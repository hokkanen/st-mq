// Synthetic ownership checks across real bind mounts. Only abstract Unix sockets
// are opened; no application, provider or certificate helper is started.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { lockDirectory } from '../../src/https/storage.js';

const image = process.argv[2];
assert(image, 'Usage: node test/container/https-lock.js IMAGE');
const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = await mkdtemp(resolve(tmpdir(), 'stmq-https-bind-lock-'));
const first = resolve(directory, 'first'), second = resolve(directory, 'second');
const execute = promisify(execFile), containers = new Set();
const run = args => execute('docker', args, { timeout: 20000, maxBuffer: 65536 });
const mounts = (source, target) => ['--mount', `type=bind,src=${source},dst=${target}`];
const options = (source, target) => ['--rm', '--network', 'host', '--read-only', '--cap-drop', 'ALL',
  '--security-opt', 'no-new-privileges', '--user', `${process.getuid()}:${process.getgid()}`,
  '--mount', `type=bind,src=${root}src/https,dst=/lock-source,readonly`, ...mounts(source, target),
  '--entrypoint', 'node'];
const moduleImport = "import {lockDirectory} from '/lock-source/storage.js';";
async function attempt(source, target) {
  const { stdout } = await run(['run', ...options(source, target), image, '--input-type=module', '--eval',
    `${moduleImport}try{const release=await lockDirectory(${JSON.stringify(target)});await release();console.log('acquired');}
    catch(error){console.log(error.code);}`]);
  return stdout.trim();
}
async function hold(source) {
  const name = `stmq-https-lock-${randomUUID()}`; containers.add(name);
  const child = spawn('docker', ['run', ...options(source, '/fixture'), '--name', name, '-i', image,
    '--input-type=module', '--eval', `${moduleImport}
      await lockDirectory('/fixture');
      if(process.pid!==1)throw Error('Expected container PID 1');
      process.stdout.write('locked\\n');process.stdin.resume();`], { stdio: ['pipe', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr.on('data', bytes => { errors += bytes; });
  const exited = once(child, 'exit');
  const ready = await Promise.race([
    once(child.stdout, 'data', { signal: AbortSignal.timeout(15000) }).then(([bytes]) => bytes.toString()),
    exited.then(() => { throw Error(`Container exited before ownership: ${errors}`); }),
  ]);
  assert.equal(ready, 'locked\n');
  return { name, exited };
}

let release;
try {
  await mkdir(first, { mode: 0o700 }); await mkdir(second, { mode: 0o700 });
  release = await lockDirectory(first);
  assert.equal(await attempt(first, '/fixture'), 'https_manager_already_running',
    'The same physical directory at a different container path must retain its owner');
  await release(); release = null;
  const peer = await hold(second);
  for (let restart = 0; restart < 3; restart++) {
    const owner = await hold(first);
    assert.equal(await attempt(first, '/different-mount'), 'https_manager_already_running',
      'Bind-mount aliases must not bypass a running container owner');
    await assert.rejects(lockDirectory(first), { code: 'https_manager_already_running' });
    await run(['kill', '--signal', 'KILL', owner.name]);
    const [code] = await owner.exited; assert.equal(code, 137);
    containers.delete(owner.name);
    release = await lockDirectory(first); await release(); release = null;
    assert.deepEqual(await readdir(first), [], 'Restart creates no persistent lock or claim');
    assert.equal(await attempt(second, '/elsewhere'), 'https_manager_already_running',
      'The independent volume at identical /fixture retains its own running owner');
  }
  await run(['kill', '--signal', 'KILL', peer.name]); await peer.exited; containers.delete(peer.name);
  console.log('HTTPS lock container checks passed: real bind aliases, independent volumes at identical paths, and three PID 1 crash/restart cycles.');
} finally {
  await release?.();
  await Promise.all([...containers].map(name => run(['rm', '--force', name]).catch(() => {})));
  await rm(directory, { recursive: true, force: true });
}
