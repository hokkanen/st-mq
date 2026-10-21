// Full standalone simulation, file-backed learning history and real local APIs.
// The browser and every database are disposable; no household configuration loads.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../../src/main.js';
import { loadConfig } from '../../src/app/config.js';
import { Store } from '../../src/storage/store.js';
import { appendLearningRecord } from '../helpers/home-learning-fixture.js';
import { initialAdaptiveModel } from '../../src/control/adaptive-learning.js';
import { replayLearningJournal } from '../../src/app/committed-learning.js';
import { MODEL_COEFFICIENT_INFO } from '../../src/domain/history-series.js';
import { createSourceSnapshot } from '../../src/replication/transport.js';
import { startReplica } from '../../src/app/replica.js';

const directory = await mkdtemp(join(tmpdir(), 'model-reconstruction-service-browser-'));
const admin = 'synthetic-model-browser-admin-access', family = 'synthetic-model-browser-family-access';
const now = Date.parse('2026-10-21T12:00:00Z'), pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const pending = new Map(), errors = [], writes = [], checks = [];
let app, browser, socket, sequence = 0;
try {
  const configuration = join(directory, 'fixture.json'); await writeFile(configuration, '{}', { mode: 0o600 });
  const config = loadConfig({ STMQ_CONFIG: configuration, STMQ_DATA_DIR: directory, STMQ_INPUT: 'simulated',
    STMQ_PORT: '0', STMQ_API_TOKEN: admin, STMQ_FAMILY_API_TOKEN: family }, directory);
  config.web.httpsDirectory = join(directory, 'https');
  const seed = new Store(config.dbPath);
  for (let index = 0; index < 320; index++) appendLearningRecord(seed, 'simulated', 'context', {
    timestamp: now - (320 - index) * 900_000,
    ...(index === 0 ? { historySeed: { model: initialAdaptiveModel({ thermalPriors: { lossPerHour: .025 } }), source: { basis: 'invented-browser-model' } } } : {}),
  }, { config: {} });
  replayLearningJournal(seed, 'simulated'); await seed.close();
  app = await start({ config, clock: () => now, installSignalHandlers: false });
  app.server.on('request', request => { if (!['GET', 'HEAD'].includes(request.method)) writes.push(request.url); });
  let base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (path, role = 'admin') => {
    const response = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${role === 'admin' ? admin : family}` } });
    assert(response.ok, `Read ${path}: ${response.status}`); return response.json();
  };
  const profile = join(directory, 'chromium');
  browser = spawn(process.env.STMQ_CHROME_BIN ?? '/opt/google/chrome/chrome', ['--headless', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--disable-background-networking', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let port, launchError; browser.on('error', error => { launchError = error; });
  for (let attempt = 0; attempt < 200 && !port; attempt++) {
    if (launchError) throw launchError;
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch {}
    if (!port) await pause(30);
  }
  assert(port);
  const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then(response => response.json());
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) { const task = pending.get(message.id); if (!task) return; pending.delete(message.id); clearTimeout(task.timer); message.error ? task.reject(Error(message.error.message)) : task.resolve(message.result); }
    else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => reject(Error(`Timeout ${method}`)), 30_000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value;
  };
  const until = async expression => {
    for (let attempt = 0; attempt < 1200; attempt++) { if (await evaluate(`Boolean(document.body && (${expression}))`)) return; await pause(25); }
    const detail = await evaluate(`document.getElementById('model-reconstruction-status')?.textContent+' '+document.getElementById('model-reconstruction-message')?.textContent`);
    const status = await request('/api/model-reconstruction');
    throw Error(`UI did not settle: ${expression}; ${detail}; ${JSON.stringify({ state: status.state, error: status.error, job: status.job })}; ${errors.join('; ')}`);
  };
  const id = name => `document.getElementById('model-reconstruction-${name}')`;
  const click = async name => {
    await until(`!${id(name)}.disabled`);
    return evaluate(`${id(name)}.click();true`);
  };
  const open = async () => { await until("document.body.dataset.authenticated === 'true'"); await evaluate(`document.getElementById('recording-details').open=true;${id('details')}.open=true;true`); };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `if(!sessionStorage.getItem('stmq-token'))sessionStorage.setItem('stmq-token',${JSON.stringify(admin)});` });
  await send('Page.navigate', { url: base }); await open(); await until(`!${id('verify')}.disabled`);
  for (const key of Object.keys(MODEL_COEFFICIENT_INFO)) {
    const chart = await request(`/api/chart?start=2026-10-21&left=${encodeURIComponent(key)}`);
    assert(chart.series[key].some(point => Number.isFinite(point.y)), `${key} is available before any verification`);
  }
  checks.push('all four main-database coefficient charts work before verification');
  const checkpointBefore = app.store.checkpoint();
  await click('verify'); await until(`${id('status')}.textContent.includes('is running')`);
  await click('pause'); await until(`${id('status')}.textContent.includes('is paused')`);
  assert.equal((await request('/api/model-reconstruction')).state, 'paused');
  checks.push('real worker pause at durable boundary');
  await click('resume'); await until(`${id('result')}.textContent.includes('All four coefficient histories: matched')`);
  const verified = await request('/api/model-reconstruction');
  assert.equal(verified.lastVerification.state, 'matched');
  assert.equal(verified.lastVerification.modelMatched, true);
  assert.equal(verified.lastVerification.historyMatched, true);
  checks.push('independent seed replay matches complete saved model and all four recorded timelines');
  assert.deepEqual(app.store.checkpoint(), checkpointBefore, 'Verification does not mutate the main database');
  const adminWrites = writes.length;
  await evaluate(`sessionStorage.setItem('stmq-token',${JSON.stringify(family)});true`); await send('Page.reload'); await open();
  await until(`${id('result')}.textContent.includes('All four coefficient histories: matched')`);
  assert.equal(await evaluate(`${id('verify')}.disabled && ${id('discard')}.disabled`), true);
  await evaluate(`${id('verify')}.click();true`); assert.equal(writes.length, adminWrites);
  const denied = await fetch(`${base}/api/model-reconstruction/action`, { method: 'POST', headers: { Authorization: `Bearer ${family}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'verify', requestId: '11111111-1111-4111-8111-111111111111' }) });
  assert.equal(denied.status, 403); checks.push('family reads real results but cannot start jobs');
  await app.close(); app = await start({ config, clock: () => now, installSignalHandlers: false });
  base = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await request('/api/model-reconstruction')).lastVerification.state, 'matched');
  checks.push('local verification result survives application restart');
  await app.close();
  const snapshots = join(directory, 'snapshots'); await mkdir(snapshots, { mode: 0o700 });
  const generation = randomUUID(), dbPath = join(snapshots, `${generation}.sqlite`);
  await createSourceSnapshot({ dbPath: config.dbPath, destination: dbPath });
  const saved = new Store(dbPath, { readOnly: true }), checkpoint = saved.checkpoint(); await saved.close();
  const bytes = await readFile(dbPath), digest = createHash('sha256').update(bytes).digest('hex');
  const publication = { dbPath, generation, fileGeneration: generation, sourceAt: now, verifiedAt: now,
    sourceStartedAt: now - 1000, checkpoint, digest, bytes: bytes.length };
  app = await startReplica({ config: { ...config, dataDir: join(directory, 'slave-local'), topology: 'mirror', role: 'slave',
    mirror: { directory: snapshots, intervalMs: 60_000, staleAfterMs: 180_000 } },
    readPublication: async () => publication, clock: () => now, installSignalHandlers: false });
  app.server.on('request', request => { if (!['GET', 'HEAD'].includes(request.method)) writes.push(request.url); });
  base = `http://127.0.0.1:${app.server.address().port}`;
  await send('Page.navigate', { url: base }); await open(); await until(`!${id('verify')}.disabled`);
  assert.equal((await request('/api/status')).role, 'slave');
  await click('verify'); await until(`${id('status')}.textContent.includes('is running')`);
  await click('cancel'); await until(`${id('status')}.textContent.includes('No verification is running')`);
  await click('discard'); await until(`${id('storage')}.textContent.includes('0 B')`);
  assert.equal((await request('/api/model-reconstruction')).lastVerification, null);
  await click('verify'); await until(`${id('result')}.textContent.includes('All four coefficient histories: matched')`);
  assert.equal(createHash('sha256').update(await readFile(dbPath)).digest('hex'), digest, 'Slave verification never edits its source snapshot');
  checks.push('real slave verification, cancellation and discard leave source snapshot intact');
  assert(writes.every(path => path === '/api/model-reconstruction/action'), 'No browser action dispatches a device, main history, settings or pairing command');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'pass', checks, realActions: writes.length, runtimeErrors: errors.length }));
  await send('Browser.close');
} finally {
  socket?.close(); for (const task of pending.values()) clearTimeout(task.timer); browser?.kill('SIGTERM');
  await app?.close(); await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
