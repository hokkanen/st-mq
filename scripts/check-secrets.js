#!/usr/bin/env node
// Read Git objects, never the decrypted working tree or a textconv result.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const HEADER = Buffer.from([0, 71, 73, 84, 67, 82, 89, 80, 84, 0]);
const MAX_BUFFER = 256 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });
const baseEnv = { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: '/dev/null', GIT_ATTR_NOSYSTEM: '1' };
let temporary;

function git(args, { env = baseEnv, input } = {}) {
  try {
    return execFileSync('git', args, { env, input, maxBuffer: MAX_BUFFER, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  } catch {
    // Git errors can include file contents, URLs, or configuration values.
    throw new Error(`Git ${args[0]} failed; scan incomplete (details withheld).`);
  }
}

function placeholder(value) {
  return value.length < 8 || /^(?:null|undefined|true|false|username|password\??|secret|discarded|never-store|must-not-persist|still-rejected|private-password)$/i.test(value)
    || /(?:^|[-_ :])(?:test|synthetic|fixture|example|sample|dummy|mock|placeholder|changeme|replace|your)[-_ :]/i.test(value)
    || /^(?:test|synthetic|fixture|example|sample|dummy|mock|placeholder|changeme)$/i.test(value)
    || /^(?:rotated|saved|old|new|access|refresh)-(?:access|refresh|one|two|old|new)$/i.test(value)
    || /^(.)\1{7,}$/.test(value) || /^[xX*<>]+$/.test(value)
    || /(?:\$\{|\$[A-Za-z_]|process\.env\b|\benv\.|os\.environ|\.example\b|\.invalid\b)/.test(value);
}

function categories(bytes, allowCiphertext = true) {
  if (allowCiphertext && bytes.subarray(0, HEADER.length).equals(HEADER)) {
    return bytes.length >= 22 ? [] : ['truncated git-crypt data'];
  }
  const source = bytes.toString('utf8');
  const found = new Set();
  if (bytes.includes(Buffer.from([0, 71, 73, 84, 67, 82, 89, 80, 84, 75, 69, 89, 0]))) found.add('exported git-crypt key');
  const patterns = [
    ['private key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/],
    ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{70,})\b/],
    ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
    ['Google API key', /\bAIza[A-Za-z0-9_-]{35}\b/],
    ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
    ['provider secret key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b|\b[rs]k_live_[A-Za-z0-9]{16,}\b/],
    ['SendGrid token', /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{30,}\b/],
    ['JWT credential', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{16,}\b/],
  ];
  for (const [category, pattern] of patterns) if (pattern.test(source)) found.add(category);
  // Literal assignments in JSON, YAML, shell and source code. Environment access
  // and clearly labelled dummy values are allowed; this is not an exhaustive DLP scan.
  const assignments = /["']?([A-Za-z_][\w.-]*)["']?[ \t]*[:=][ \t]*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|`([^`\r\n]*)`|([^\s,;}#]+))/g;
  for (const match of source.matchAll(assignments)) {
    const name = match[1].replace(/[-_.]/g, '').toLowerCase();
    if (!/(?:token|password|passwd|apikey|apisecret|clientsecret|privatekey|accesskey|secretkey|secret|authorization)$/.test(name) && name !== 'pw' && name !== 'pwd') continue;
    let value = match[2] ?? match[3] ?? match[4] ?? match[5];
    if (match[5] !== undefined) {
      // An unquoted code expression is not a credential literal. Uppercase bare
      // environment assignments and values with digits/punctuation are checked.
      const lineStart = source.lastIndexOf('\n', match.index - 1) + 1;
      const bareAssignment = /^[A-Z][A-Z0-9_]*$/.test(match[1])
        && /^[ \t]*(?:export[ \t]+)?$/.test(source.slice(lineStart, match.index));
      if (!/^[A-Za-z0-9_+/.=:@-]+$/.test(value) || /^(?:\w+\.)+\w+$/.test(value)
        || (!bareAssignment && !/[0-9+/:=@-]/.test(value))) continue;
    }
    value = value.replace(/^Bearer\s+/i, '');
    if (!placeholder(value)) found.add('literal credential assignment');
  }
  return [...found];
}

function attributes(paths, env) {
  if (!paths.length) return new Map();
  const fields = decoder.decode(git(['-c', 'core.attributesFile=/dev/null', 'check-attr', '--cached', '-z', '--stdin', 'filter', 'diff'],
    { env, input: Buffer.from(`${paths.join('\0')}\0`) })).split('\0');
  fields.pop();
  if (fields.length !== paths.length * 6) throw new Error('Incomplete attribute scan.');
  const result = new Map();
  for (let i = 0; i < fields.length; i += 3) {
    const [path, name, value] = fields.slice(i, i + 3);
    const attrs = result.get(path) ?? {};
    attrs[name] = value;
    result.set(path, attrs);
  }
  return result;
}

function objects(ids) {
  if (!ids.length) return [];
  const output = git(['cat-file', '--batch'], { input: `${ids.join('\n')}\n` });
  let offset = 0;
  return ids.map(id => {
    const end = output.indexOf(10, offset);
    const header = output.subarray(offset, end).toString('ascii').split(' ');
    const length = Number(header[2]);
    if (end < 0 || header[0] !== id || !['blob', 'commit'].includes(header[1]) || !Number.isSafeInteger(length)
      || length < 0 || end + length + 1 >= output.length || output[end + length + 1] !== 10) {
      throw new Error('Incomplete raw-object scan.');
    }
    const bytes = output.subarray(end + 1, end + 1 + length);
    offset = end + 2 + length;
    return bytes;
  });
}

function run() {
  const args = process.argv.slice(2);
  if (!(args.length === 1 && args[0] === '--staged') && !(args.length === 2 && args[0] === '--history')) {
    throw new Error('Usage: node scripts/check-secrets.js --staged | --history REF');
  }
  const history = args[0] === '--history';
  process.chdir(git(['rev-parse', '--show-toplevel']).toString().trim());
  if (history && git(['rev-parse', '--is-shallow-repository']).toString().trim() !== 'false') {
    throw new Error('Shallow history cannot be audited; fetch the complete history first.');
  }
  const commits = history
    ? git(['rev-list', git(['rev-parse', '--verify', '--end-of-options', `${args[1]}^{commit}`]).toString().trim()]).toString().trim().split('\n')
    : [];
  temporary = mkdtempSync(join(tmpdir(), 'stmq-secret-check-'));
  const objectDirectory = resolve(git(['rev-parse', '--git-path', 'objects']).toString().trim());
  // A separate Git directory prevents local/global/info attributes and working-tree
  // files from changing the historical attribute policy being audited.
  const isolated = { ...baseEnv, GIT_DIR: join(temporary, 'git'), GIT_WORK_TREE: temporary,
    GIT_INDEX_FILE: join(temporary, 'index'), GIT_OBJECT_DIRECTORY: objectDirectory };
  delete isolated.GIT_COMMON_DIR;
  git(['init', '--bare', isolated.GIT_DIR], { env: baseEnv });
  const cache = new Map();
  const findings = new Set();
  let snapshots = 0;
  let encryptedSnapshots = 0;
  function report(ref, path, category, id) {
    findings.add(`${ref} ${JSON.stringify(path)}${id ? ` [${id}]` : ''}: ${category}`);
  }
  for (const ref of history ? commits : ['index']) {
    let entries;
    if (history) {
      git(['read-tree', ref], { env: isolated });
      entries = decoder.decode(git(['ls-tree', '-r', '-z', '--full-tree', ref])).split('\0').filter(Boolean).map(record => {
        const tab = record.indexOf('\t');
        const [mode, type, id] = record.slice(0, tab).split(' ');
        return { mode, type, id, path: record.slice(tab + 1) };
      }).filter(entry => entry.type === 'blob');
      const message = objects([ref])[0];
      const split = message.indexOf(Buffer.from('\n\n'));
      if (split < 0) throw new Error('Malformed commit object.');
      for (const category of categories(message.subarray(split + 2), false)) report(ref, '(commit message)', category);
    } else {
      entries = decoder.decode(git(['ls-files', '--stage', '-z', '--full-name'])).split('\0').filter(Boolean).map(record => {
        const tab = record.indexOf('\t');
        const [mode, id, stage] = record.slice(0, tab).split(' ');
        if (stage !== '0') throw new Error('Unmerged index cannot be audited.');
        return { mode, id, path: record.slice(tab + 1) };
      }).filter(entry => entry.mode !== '160000');
      git(['read-tree', '--empty'], { env: isolated });
      git(['update-index', '-z', '--index-info'], { env: isolated,
        input: entries.map(({ mode, id, path }) => `${mode} ${id}\t${path}\0`).join('') });
    }
    const paths = entries.map(entry => entry.path);
    const tracked = attributes(paths, isolated);
    const effective = history ? tracked : attributes(paths, baseEnv);
    const missing = [...new Set(entries.map(entry => entry.id))].filter(id => !cache.has(id));
    const raw = objects(missing);
    for (let i = 0; i < missing.length; i++) cache.set(missing[i], {
      encrypted: raw[i].length >= 22 && raw[i].subarray(0, HEADER.length).equals(HEADER),
      categories: categories(raw[i]),
    });
    for (const { path, id } of entries) {
      snapshots++;
      const status = cache.get(id);
      if (status.encrypted) encryptedSnapshots++;
      const attrs = tracked.get(path);
      const actual = effective.get(path);
      const required = /^options\.json(?:\..*)?$/.test(path.split('/').at(-1)) || path === 'workspace/consumption.csv'
        || [attrs.filter, attrs.diff, actual.filter, actual.diff].includes('git-crypt');
      if (required) {
        if (attrs.filter !== 'git-crypt' || attrs.diff !== 'git-crypt') report(ref, path, 'tracked attributes must set filter=git-crypt and diff=git-crypt', id);
        if (actual.filter !== 'git-crypt' || actual.diff !== 'git-crypt') report(ref, path, 'effective attributes must set filter=git-crypt and diff=git-crypt', id);
        if (!status.encrypted) report(ref, path, 'required git-crypt ciphertext signature missing', id);
      }
      for (const category of status.categories) report(ref, path, category, id);
    }
  }
  if (findings.size) {
    for (const finding of findings) process.stderr.write(`${finding}\n`);
    throw new Error(`Secret check failed: ${findings.size} finding(s). No values were printed.`);
  }
  process.stdout.write(`Secret check passed: ${history ? `${commits.length} reachable commits` : 'complete staged index'}, ${snapshots} file snapshots, ${cache.size} unique blobs, ${encryptedSnapshots} encrypted snapshots.\n`);
  process.stdout.write('Checks cover git-crypt signatures/attributes and credential patterns; signatures do not authenticate ciphertext and patterns are not exhaustive.\n');
}

try {
  run();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally {
  if (temporary) rmSync(temporary, { recursive: true, force: true });
}
