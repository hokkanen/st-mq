import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const checker = fileURLToPath(new URL('../scripts/check-secrets.js', import.meta.url));
// Synthetic retired-format bytes; these contain no cryptographic key or private data.
const ciphertext = Buffer.concat([Buffer.from([0, 71, 73, 84, 67, 82, 89, 80, 84, 0]), Buffer.alloc(40, 19)]);
const policy = 'options.json filter=unavailable-filter diff=unavailable-filter -text\n';
const ciphertextId = createHash('sha1').update(`blob ${ciphertext.length}\0`).update(ciphertext).digest('hex');

function repository(t) {
  const path = mkdtempSync(join(tmpdir(), 'stmq-secret-test-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  for (const name of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)$/.test(name)) delete env[name];
  function git(...args) {
    return execFileSync('git', args, { cwd: path, env, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  }
  git('init', '-q');
  git('config', 'user.name', 'Security Test');
  git('config', 'user.email', 'test@example.invalid');
  function write(name, bytes) {
    mkdirSync(dirname(join(path, name)), { recursive: true });
    writeFileSync(join(path, name), bytes);
  }
  function stage(name, bytes) { write(name, bytes); git('add', '--', name); }
  const tools = mkdtempSync(join(tmpdir(), 'stmq-checker-test-'));
  t.after(() => rmSync(tools, { recursive: true, force: true }));
  const localChecker = join(tools, 'check-secrets.mjs');
  copyFileSync(checker, localChecker);
  writeFileSync(join(tools, 'historical-private-blobs.json'), JSON.stringify({ 'data/options.json': [ciphertextId] }));
  function check(...args) {
    const result = spawnSync(process.execPath, [localChecker, ...args], { cwd: path, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.ifError(result.error);
    return { code: result.status, output: result.stdout + result.stderr };
  }
  function commit(message = 'safe checkpoint') { git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', message); return git('rev-parse', 'HEAD'); }
  return { path, env, git, write, stage, check, commit };
}

test('private configuration names and ciphertext cannot be staged, even with encryption attributes', t => {
  for (const name of ['data/options.json', 'secrets.json', 'backup/secrets.json.bak', 'options.json.copy']) {
    const repo = repository(t);
    repo.stage('.gitattributes', policy);
    repo.stage(name, '{}');
    assert.match(repo.check('--staged').output, /private configuration\/data must remain outside Git/);
    repo.stage(name, ciphertext);
    assert.equal(repo.check('--staged').code, 1);
  }
});

test('renamed ciphertext and known household telemetry are rejected in the current index', t => {
  const repo = repository(t);
  repo.stage('renamed.bin', ciphertext);
  repo.stage('workspace/consumption.csv', 'time,value\n');
  const result = repo.check('--staged');
  assert.equal(result.code, 1);
  assert.match(result.output, /renamed.bin.*private configuration/);
  assert.match(result.output, /consumption.csv.*private configuration/);
});

test('safe current checkout needs no encryption attributes or filter and reads index only', t => {
  const repo = repository(t);
  repo.stage('public.json', '{}');
  repo.write('public.json', '{"password":"synthetic-worktree-value"}');
  assert.equal(repo.check('--staged').code, 0);
});

test('household consumption CSV is rejected anywhere in current files and deleted history', t => {
  const repo = repository(t);
  repo.stage('archive/Consumption.csv', 'time,value\nfixture-time,1\n');
  assert.equal(repo.check('--staged').code, 1);
  repo.commit();
  repo.git('rm', 'archive/Consumption.csv');
  repo.stage('public.txt', 'fixture-public\n');
  repo.commit();
  assert.equal(repo.check('--staged').code, 0);
  const result = repo.check('--history', 'HEAD');
  assert.equal(result.code, 1);
  assert.match(result.output, /archive\/Consumption.csv.*private configuration/);
});

test('inventoried historical bytes need no encryption attributes, executable or key', t => {
  const repo = repository(t);
  repo.stage('data/options.json', ciphertext);
  repo.commit();
  repo.git('rm', '-f', 'data/options.json');
  repo.stage('.gitignore', 'options.json\nsecrets.json\n');
  repo.commit();
  assert.equal(repo.check('--history', 'HEAD').code, 0);
  assert.equal(repo.check('--staged').code, 0);
});

test('history scans intermediate exposure and deleted files, irrespective of tip policy or local overrides', t => {
  const repo = repository(t);
  repo.stage('.gitattributes', policy);
  repo.stage('data/options.json', ciphertext);
  repo.commit();
  repo.stage('data/options.json', '{}');
  const exposed = repo.commit();
  repo.stage('data/options.json', ciphertext);
  repo.commit();
  repo.git('rm', '-f', 'data/options.json');
  repo.commit();
  repo.write('.git/info/attributes', 'options.json -filter -diff\n');
  const result = repo.check('--history', 'HEAD');
  assert.equal(result.code, 1);
  assert.match(result.output, new RegExp(`${exposed} .*only inventoried historical blobs`));
  assert.doesNotMatch(result.output, /attributes must set/);
});

test('inventoried ciphertext is rejected in the index, at another path, or after any byte change', t => {
  const repo = repository(t);
  repo.stage('data/options.json', ciphertext);
  assert.equal(repo.check('--staged').code, 1);
  repo.commit();
  assert.equal(repo.check('--history', 'HEAD').code, 0);
  repo.stage('renamed.bin', ciphertext);
  repo.commit();
  assert.match(repo.check('--history', 'HEAD').output, /renamed.bin.*only inventoried historical blobs/);
  repo.git('reset', '--hard', 'HEAD~1');
  const changed = Buffer.from(ciphertext);
  changed[changed.length - 1] ^= 1;
  repo.stage('data/options.json', changed);
  repo.commit();
  assert.match(repo.check('--history', 'HEAD').output, /data\/options.json.*only inventoried historical blobs/);
});

test('unavailable filters and text converters are never invoked by a history scan', t => {
  const repo = repository(t);
  repo.stage('.gitattributes', policy);
  repo.stage('data/options.json', ciphertext);
  repo.commit();
  repo.git('config', 'filter.unavailable-filter.smudge', '/does-not-exist');
  repo.git('config', 'filter.unavailable-filter.clean', '/does-not-exist');
  repo.git('config', 'filter.unavailable-filter.required', 'true');
  repo.git('config', 'diff.unavailable-filter.textconv', '/does-not-exist');
  assert.equal(repo.check('--history', 'HEAD').code, 0);
});

test('retired key signatures are rejected in deleted history and behind a data header', t => {
  const repo = repository(t);
  const marker = Buffer.from([0, 71, 73, 84, 67, 82, 89, 80, 84, 75, 69, 89, 0]);
  repo.stage('arbitrary.bin', Buffer.concat([ciphertext, marker, Buffer.alloc(64, 17)]));
  assert.match(repo.check('--staged').output, /retired encryption key/);
  const exposed = repo.commit();
  repo.git('rm', 'arbitrary.bin');
  repo.commit();
  const result = repo.check('--history', 'HEAD');
  assert.equal(result.code, 1);
  assert.match(result.output, new RegExp(`${exposed} .*retired encryption key`));
});

test('history follows both merge parents and does not let grafts hide an ancestor', t => {
  const repo = repository(t);
  repo.stage('readme.txt', 'safe');
  const base = repo.commit();
  repo.git('checkout', '-qb', 'side');
  repo.stage('lost.txt', ['-----BEGIN ', 'PRIVATE KEY-----'].join(''));
  const exposed = repo.commit();
  repo.git('rm', 'lost.txt');
  repo.commit();
  repo.git('checkout', '-qb', 'primary', base);
  repo.stage('main.txt', 'safe');
  repo.commit();
  repo.git('merge', '--no-ff', '-qm', 'merge safe tips', 'side');
  const tip = repo.git('rev-parse', 'HEAD');
  repo.write('.git/info/grafts', `${tip}\n`);
  const result = repo.check('--history', 'HEAD');
  assert.equal(result.code, 1);
  assert.match(result.output, new RegExp(`${exposed} .*private key`));
});

test('credential patterns cover private keys, provider keys, raw exported keys and literal assignments without printing values', t => {
  const repo = repository(t);
  const provider = ['ghp', '_', 'Ab12'.repeat(9)].join('');
  const literal = ['qR7', '!nB6', 'zK9'].join('');
  repo.stage('keys.txt', `${['-----BEGIN ', 'OPENSSH PRIVATE KEY-----'].join('')}\n${provider}\npassword=${JSON.stringify(literal)}\n`);
  repo.stage('arbitrary.bin', Buffer.concat([Buffer.from([0, 71, 73, 84, 67, 82, 89, 80, 84, 75, 69, 89, 0]), Buffer.alloc(64, 17)]));
  const result = repo.check('--staged');
  assert.equal(result.code, 1);
  for (const category of ['private key', 'GitHub token', 'literal credential assignment', 'retired encryption key']) assert.ok(result.output.includes(category), result.output);
  assert.ok(!result.output.includes(provider));
  assert.ok(!result.output.includes(literal));
});

test('environment access and explicit test placeholders are allowed, while secrets in commit messages fail', t => {
  const repo = repository(t);
  repo.stage('config.js', "const token = process.env.API_TOKEN; const apiKey = 'synthetic-test-token'; const password = env.PASSWORD;\naccess_token=\"username\"\ntoken:\n  name: Access token\n");
  assert.equal(repo.check('--staged').code, 0);
  const message = ['accidental ', 'ghp', '_', 'Ac93'.repeat(9)].join('');
  const exposed = repo.commit(message);
  const result = repo.check('--history', 'HEAD');
  assert.equal(result.code, 1);
  assert.match(result.output, new RegExp(`${exposed} .*commit message.*GitHub token`));
  assert.ok(!result.output.includes(message));
});

test('bare alphabetic dotenv values and static template literals are checked', t => {
  const repo = repository(t);
  const value = ['Qrb', 'zNp', 'Xvf'].join('');
  repo.stage('.env', `API_KEY=${value}\n`);
  repo.stage('config.js', `const password = \`${value}\`;\n`);
  const result = repo.check('--staged');
  assert.equal(result.code, 1);
  assert.match(result.output, /\.env.*literal credential assignment/);
  assert.match(result.output, /config.js.*literal credential assignment/);
  assert.ok(!result.output.includes(value));
});

test('history refuses shallow clones and invalid refs instead of reporting success', t => {
  const source = repository(t);
  source.stage('readme.txt', 'safe');
  source.commit();
  source.stage('readme.txt', 'still safe');
  source.commit();
  const shallow = repository(t);
  rmSync(join(shallow.path, '.git'), { recursive: true, force: true });
  shallow.git('clone', '-q', '--depth=1', `file://${source.path}`, '.');
  assert.match(shallow.check('--history', 'HEAD').output, /Shallow history cannot be audited/);
  assert.equal(source.check('--history', 'missing-ref').code, 1);
  assert.equal(source.check('--invalid').code, 1);
});
