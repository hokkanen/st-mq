import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const helperPath = fileURLToPath(new URL('../scripts/lib/ha-deploy-state.py', import.meta.url));
const driver = `
import importlib.util,json,os,sys
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('deployment_state',sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
request=json.load(sys.stdin)
# Storage contents must never be opened, even for small fixtures. Settings,
# source and the private snapshot live outside these roots and remain readable.
def forbid_storage_reads(event,args):
 if event=='open' and isinstance(args[0],(str,bytes,os.PathLike)):
  path=os.path.abspath(os.fsdecode(args[0]))
  if any(path==root or path.startswith(root+os.sep) for root in request['arguments']['roots']):
   raise AssertionError('Stored-file content read attempted')
sys.addaudithook(forbid_storage_reads)
try:
 getattr(module,request['action'])(**request['arguments'])
 print(json.dumps({'ok':True}))
except module.DeploymentStateError as error:
 print(json.dumps({'error':error.code,'message':str(error)}))
`;

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'ha-deploy-state-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'checkout');
  const runtime = join(directory, 'runtime');
  const addonConfig = join(directory, 'addon-config');
  for (const path of [root, runtime, addonConfig]) mkdirSync(path, { mode: 0o700 });
  const oldManifest = {
    version: '0.9.5-dev.4',
    schema: { api_secret: 'str?', enabled: 'bool', retired: 'str?' },
    options: { enabled: false, retired: 'old-default' },
  };
  const manifest = {
    version: '0.9.5-dev.4',
    schema: { api_secret: 'str?', enabled: 'bool', added: 'int' },
    options: { enabled: false, added: 7 },
  };
  const state = {
    user: {
      synthetic_st_mq: {
        version: manifest.version,
        image: 'synthetic-st-mq',
        options: {
          api_secret: 'synthetic-credential-never-output',
          retired: 'keep-this-saved-override',
          enabled: true,
          nested: { first: null, second: false },
          sequence: ['first', 'second'],
        },
        boot: 'manual',
      },
    },
    system: { synthetic_st_mq: structuredClone(oldManifest) },
  };
  const statePath = join(directory, 'apps.json');
  const snapshotPath = join(directory, 'before.json');
  const stateBytes = () => readFileSync(statePath);
  const save = () => writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
  save();
  const databasePath = join(runtime, 'synthetic.sqlite');
  writeFileSync(databasePath, 'synthetic database bytes', { mode: 0o600 });
  const settingsPath = join(addonConfig, 'settings.json');
  writeFileSync(settingsPath, '{"synthetic":"stored credential fixture"}', { mode: 0o600 });
  const outsidePath = join(directory, 'outside-data');
  writeFileSync(outsidePath, 'outside target bytes');
  const linkPath = join(runtime, 'external-data');
  symlinkSync(outsidePath, linkPath);

  writeFileSync(join(root, 'config.json'), JSON.stringify(manifest));
  const git = (...args) => execFileSync('git', args, {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  git('init', '--quiet');
  git('config', 'user.name', 'Synthetic deployment test');
  git('config', 'user.email', 'synthetic@example.invalid');
  git('config', 'core.hooksPath', '/dev/null');
  git('add', 'config.json');
  git('commit', '--quiet', '-m', 'Synthetic current manifest');
  const args = {
    state_path: statePath,
    slug: 'synthetic_st_mq',
    roots: [runtime, addonConfig],
    snapshot_path: snapshotPath,
  };
  const verifyArgs = {
    ...args,
    root,
    target: git('rev-parse', 'HEAD'),
    manifest_hash: createHash('sha256').update(readFileSync(join(root, 'config.json'))).digest('hex'),
  };
  function run(action, arguments_) {
    const result = spawnSync('python3', ['-c', driver, helperPath], {
      input: JSON.stringify({ action, arguments: arguments_ }), encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '', 'helper does not emit raw process or configuration errors');
    assert.doesNotMatch(result.stdout, /synthetic-credential-never-output|keep-this-saved-override|stored credential fixture/);
    return JSON.parse(result.stdout);
  }
  return {
    state, manifest, root, runtime, addonConfig, settingsPath, databasePath,
    outsidePath, linkPath, statePath, snapshotPath, git, save, stateBytes,
    snapshot: patch => run('snapshot', { ...args, ...patch }),
    verify: patch => run('verify', { ...verifyArgs, ...patch }),
    install: () => { state.system.synthetic_st_mq = structuredClone(manifest); save(); },
  };
}

function expectError(result, code) {
  assert.equal(result.error, code);
  assert.equal(typeof result.message, 'string');
  assert.ok(result.message.length > 0);
}

test('schema additions, removals and changed defaults preserve raw saved overrides and credentials', t => {
  const f = fixture(t);
  const original = f.stateBytes();
  assert.deepEqual(f.snapshot(), { ok: true });
  assert.deepEqual(f.stateBytes(), original, 'snapshot never rewrites Supervisor state');
  assert.deepEqual(f.verify(), { ok: true }, 'old installed metadata is expected before rebuilding');
  f.install();
  const installed = f.stateBytes();
  assert.deepEqual(f.verify({ installed: true }), { ok: true });
  assert.deepEqual(f.stateBytes(), installed, 'verification never rewrites Supervisor state');
  assert.equal(f.state.user.synthetic_st_mq.options.retired, 'keep-this-saved-override');
  assert.equal(f.state.user.synthetic_st_mq.options.api_secret, 'synthetic-credential-never-output');
  assert.equal(Object.hasOwn(f.state.user.synthetic_st_mq.options, 'added'), false);
});

test('snapshots contain digests only, have private permissions and never overwrite an existing file', t => {
  const f = fixture(t);
  assert.deepEqual(f.snapshot(), { ok: true });
  assert.equal(statSync(f.snapshotPath).mode & 0o777, 0o600);
  const bytes = readFileSync(f.snapshotPath);
  const snapshot = JSON.parse(bytes);
  assert.deepEqual(Object.keys(snapshot).sort(), ['file_metadata', 'scope', 'system', 'user']);
  for (const value of Object.values(snapshot)) assert.match(value, /^[0-9a-f]{64}$/);
  expectError(f.snapshot(), 'snapshot');
  assert.deepEqual(readFileSync(f.snapshotPath), bytes);
  const alternate = join(f.root, 'snapshot-link');
  symlinkSync(f.statePath, alternate);
  const state = f.stateBytes();
  expectError(f.snapshot({ snapshot_path: alternate }), 'snapshot');
  assert.deepEqual(f.stateBytes(), state);
});

test('raw records and metadata ignore object key order while retaining nested values', t => {
  const f = fixture(t);
  assert.deepEqual(f.snapshot(), { ok: true });
  const user = f.state.user.synthetic_st_mq;
  user.options.nested = { second: false, first: null };
  user.options = Object.fromEntries(Object.entries(user.options).reverse());
  f.state.user.synthetic_st_mq = Object.fromEntries(Object.entries(user).reverse());
  f.state.system.synthetic_st_mq.options = { retired: 'old-default', enabled: false };
  f.save();
  assert.deepEqual(f.verify(), { ok: true });
  f.install();
  f.state.system.synthetic_st_mq.schema = Object.fromEntries(Object.entries(f.manifest.schema).reverse());
  f.state.system.synthetic_st_mq.options = { added: 7, enabled: false };
  f.save();
  assert.deepEqual(f.verify({ installed: true }), { ok: true });
});

for (const [name, mutate] of [
  ['removed obsolete override', record => { delete record.options.retired; }],
  ['changed credential', record => { record.options.api_secret = 'different-synthetic-value'; }],
  ['boolean changed to number', record => { record.options.enabled = 1; }],
  ['nested false changed to zero', record => { record.options.nested.second = 0; }],
  ['changed array order', record => { record.options.sequence.reverse(); }],
  ['new saved default', record => { record.options.added = 7; }],
  ['changed non-option user setting', record => { record.boot = 'auto'; }],
]) {
  test(`raw preservation rejects ${name}`, t => {
    const f = fixture(t);
    assert.deepEqual(f.snapshot(), { ok: true });
    f.install();
    mutate(f.state.user.synthetic_st_mq);
    f.save();
    expectError(f.verify({ installed: true }), 'saved-settings');
  });
}

test('unrelated app state changes are outside the selected installation scope', t => {
  const f = fixture(t);
  assert.deepEqual(f.snapshot(), { ok: true });
  f.state.user.other_app = { options: { enabled: true } };
  f.state.system.other_app = { options: { enabled: true } };
  f.save();
  assert.deepEqual(f.verify(), { ok: true });
});

test('metadata changes before rebuild are rejected independently of user settings', t => {
  const f = fixture(t);
  assert.deepEqual(f.snapshot(), { ok: true });
  f.install();
  expectError(f.verify(), 'metadata');
});

for (const [name, mutate, code] of [
  ['stale schema', f => { f.state.system.synthetic_st_mq.schema = { enabled: 'bool' }; }, 'schema'],
  ['stale defaults', f => { f.state.system.synthetic_st_mq.options.added = 6; }, 'defaults'],
  ['default boolean changed to number', f => { f.state.system.synthetic_st_mq.options.enabled = 0; }, 'defaults'],
  ['missing defaults', f => { delete f.state.system.synthetic_st_mq.options; }, 'defaults'],
  ['wrong version', f => { f.state.system.synthetic_st_mq.version = '0.0.0'; }, 'version'],
]) {
  test(`installed verification rejects ${name}`, t => {
    const f = fixture(t);
    assert.deepEqual(f.snapshot(), { ok: true });
    f.install();
    mutate(f);
    f.save();
    expectError(f.verify({ installed: true }), code);
  });
}

for (const [name, mutate] of [
  ['tracked source edits', f => writeFileSync(join(f.root, 'config.json'), '{}')],
  ['untracked source files', f => writeFileSync(join(f.root, 'unexpected.txt'), 'untracked')],
  ['a different committed revision', f => {
    writeFileSync(join(f.root, 'unexpected.txt'), 'different revision');
    f.git('add', 'unexpected.txt');
    f.git('commit', '--quiet', '-m', 'Synthetic source drift');
  }],
]) {
  test(`source verification rejects ${name}`, t => {
    const f = fixture(t);
    assert.deepEqual(f.snapshot(), { ok: true });
    mutate(f);
    expectError(f.verify(), 'source');
  });
}

test('the selected source must contain the exact intended manifest bytes', t => {
  const f = fixture(t);
  assert.deepEqual(f.snapshot(), { ok: true });
  expectError(f.verify({ manifest_hash: '0'.repeat(64) }), 'source');
});

for (const [name, mutate] of [
  ['changed database', f => writeFileSync(f.databasePath, 'changed database')],
  ['removed configuration', f => unlinkSync(f.settingsPath)],
  ['new stored file', f => writeFileSync(join(f.runtime, 'added-file'), 'new bytes')],
  ['changed symbolic link target', f => {
    unlinkSync(f.linkPath);
    symlinkSync(f.settingsPath, f.linkPath);
  }],
  ['removed data root', f => rmSync(f.addonConfig, { recursive: true })],
]) {
  test(`stored-file verification rejects ${name}`, t => {
    const f = fixture(t);
    assert.deepEqual(f.snapshot(), { ok: true });
    mutate(f);
    expectError(f.verify(), 'files');
  });
}

test('symbolic links are preserved without reading their outside targets', t => {
  const f = fixture(t);
  assert.deepEqual(f.snapshot(), { ok: true });
  writeFileSync(f.outsidePath, 'outside target changed');
  assert.deepEqual(f.verify(), { ok: true });
});

test('intermediate fences skip stored-file metadata while preserving settings and source checks', t => {
  const f = fixture(t);
  assert.deepEqual(f.snapshot(), { ok: true });
  writeFileSync(f.databasePath, 'changed database');
  assert.deepEqual(f.verify({ check_files: false }), { ok: true });
  f.state.user.synthetic_st_mq.options.enabled = false;
  f.save();
  expectError(f.verify({ check_files: false }), 'saved-settings');
  f.state.user.synthetic_st_mq.options.enabled = true;
  f.save();
  const unexpected = join(f.root, 'unexpected.txt');
  writeFileSync(unexpected, 'untracked');
  expectError(f.verify({ check_files: false }), 'source');
  unlinkSync(unexpected);
  expectError(f.verify(), 'files');
});

test('stored-file metadata detects timestamp-only changes and documents equal-metadata limits', t => {
  const f = fixture(t);
  const timestamp = 1700000000;
  utimesSync(f.databasePath, timestamp, timestamp);
  assert.deepEqual(f.snapshot(), { ok: true });
  utimesSync(f.databasePath, timestamp, timestamp + 1);
  expectError(f.verify(), 'files');
  const size = statSync(f.databasePath).size;
  writeFileSync(f.databasePath, 'x'.repeat(size));
  utimesSync(f.databasePath, timestamp, timestamp);
  assert.deepEqual(f.verify(), { ok: true }, 'equal size and modification time are not proof of equal contents');
  writeFileSync(f.databasePath, 'x'.repeat(size + 1));
  utimesSync(f.databasePath, timestamp, timestamp);
  expectError(f.verify(), 'files');
});

test('obsolete content-hash snapshots are rejected without translation or mutation', t => {
  const f = fixture(t);
  assert.deepEqual(f.snapshot(), { ok: true });
  const saved = JSON.parse(readFileSync(f.snapshotPath));
  saved.files = saved.file_metadata;
  delete saved.file_metadata;
  writeFileSync(f.snapshotPath, JSON.stringify(saved));
  const before = readFileSync(f.snapshotPath);
  expectError(f.verify(), 'snapshot');
  assert.deepEqual(readFileSync(f.snapshotPath), before);
});

for (const [name, mutate] of [
  ['missing user record', state => { delete state.user.synthetic_st_mq; }],
  ['missing options', state => { delete state.user.synthetic_st_mq.options; }],
  ['invalid options', state => { state.user.synthetic_st_mq.options = []; }],
  ['missing system record', state => { delete state.system.synthetic_st_mq; }],
]) {
  test(`unreadable state fails closed for ${name}`, t => {
    const f = fixture(t);
    mutate(f.state);
    f.save();
    expectError(f.snapshot(), 'state');
  });
}

test('malformed state never includes parse errors or private values in diagnostics', t => {
  const f = fixture(t);
  for (const content of ['synthetic-credential-never-output', '{"user":{},"user":{}}']) {
    writeFileSync(f.statePath, content);
    expectError(f.snapshot(), 'state');
  }
});

test('missing, altered or insecure snapshots cannot authorize verification', t => {
  const f = fixture(t);
  expectError(f.verify(), 'snapshot');
  assert.deepEqual(f.snapshot(), { ok: true });
  expectError(f.verify({ slug: 'other_app' }), 'snapshot');
  expectError(f.verify({ roots: [f.runtime] }), 'snapshot');
  chmodSync(f.snapshotPath, 0o644);
  expectError(f.verify(), 'snapshot');
  chmodSync(f.snapshotPath, 0o600);
  writeFileSync(f.snapshotPath, '{}');
  expectError(f.verify(), 'snapshot');
});
