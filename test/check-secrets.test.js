import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const checker = fileURLToPath(new URL('../scripts/check-secrets.js', import.meta.url));
// A signature fixture exercises locked-CI validation, not cryptographic validity.
const ciphertext = Buffer.concat([Buffer.from([0, 71, 73, 84, 67, 82, 89, 80, 84, 0]), Buffer.alloc(40, 19)]);
const policy = 'options.json filter=git-crypt diff=git-crypt -text\noptions.json.* filter=git-crypt diff=git-crypt -text\n';

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
  function check(...args) {
    const result = spawnSync(process.execPath, [checker, ...args], { cwd: path, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.ifError(result.error);
    return { code: result.status, output: result.stdout + result.stderr };
  }
  function commit(message = 'safe checkpoint') { git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', message); return git('rev-parse', 'HEAD'); }
  return { path, env, git, write, stage, check, commit };
}

test('plaintext options fail despite attributes; staged ciphertext passes without a key or clean filter', t => {
  const repo = repository(t);
  repo.stage('.gitattributes', policy);
  repo.stage('data/options.json', '{}');
  let result = repo.check('--staged');
  assert.equal(result.code, 1);
  assert.match(result.output, /ciphertext signature missing/);
  repo.stage('data/options.json', ciphertext);
  repo.write('data/options.json', '{"token":"synthetic-decrypted-worktree"}');
  result = repo.check('--staged');
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /1 encrypted snapshots/);
  repo.stage('data/options.json', '{}');
  repo.write('data/options.json', ciphertext);
  assert.equal(repo.check('--staged').code, 1, 'a safe worktree cannot mask plaintext in the index');
});

test('committed policy, nested overrides, backups and effective local attributes are enforced', t => {
  const repo = repository(t);
  repo.stage('data/options.json', ciphertext);
  assert.match(repo.check('--staged').output, /tracked attributes must set/);
  repo.stage('.gitattributes', policy);
  repo.stage('data/.gitattributes', 'options.json -filter -diff\n');
  assert.match(repo.check('--staged').output, /tracked attributes must set/);
  repo.git('rm', '-f', 'data/.gitattributes');
  repo.write('.git/info/attributes', 'data/options.json -filter -diff\n');
  assert.match(repo.check('--staged').output, /effective attributes must set/);
  repo.write('.git/info/attributes', '');
  repo.stage('data/options.json.bak', '{}');
  assert.match(repo.check('--staged').output, /options.json.bak.*ciphertext signature missing/);
});

test('any file selected by git-crypt must contain ciphertext, including when the clean filter is absent', t => {
  const repo = repository(t);
  repo.stage('.gitattributes', 'private/*.csv filter=git-crypt diff=git-crypt\n');
  repo.stage('private/readings.csv', 'time,value\n');
  assert.match(repo.check('--staged').output, /readings.csv.*ciphertext signature missing/);
  repo.stage('private/readings.csv', ciphertext);
  assert.equal(repo.check('--staged').code, 0);
  repo.stage('private/readings.csv', ciphertext.subarray(0, 15));
  assert.match(repo.check('--staged').output, /truncated git-crypt data/);
});

test('known household telemetry cannot become plaintext by removing its attribute rule', t => {
  const repo = repository(t);
  repo.stage('workspace/consumption.csv', 'time,value\n');
  const result = repo.check('--staged');
  assert.equal(result.code, 1);
  assert.match(result.output, /consumption.csv.*ciphertext signature missing/);
  assert.match(result.output, /consumption.csv.*tracked attributes must set/);
  repo.stage('.gitattributes', '/workspace/consumption.csv filter=git-crypt diff=git-crypt\n');
  repo.stage('workspace/consumption.csv', ciphertext);
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
  assert.match(result.output, new RegExp(`${exposed} .*ciphertext signature missing`));
  assert.doesNotMatch(result.output, /attributes must set/);
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
  for (const category of ['private key', 'GitHub token', 'literal credential assignment', 'exported git-crypt key']) assert.ok(result.output.includes(category), result.output);
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
