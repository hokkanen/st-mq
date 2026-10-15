import { Store } from '../../src/storage/store.js';
import { Executor } from '../../src/app/executor.js';
import { createHeatingTransport } from '../../src/control/mqtt.js';

// An IPC relay simulator lives in the parent and survives this process. This
// exercises real SQLite/process boundaries, not device electronics or power loss.
const [path, operation, boundary, fence = 'none', storage = 'direct'] = process.argv.slice(2);
if (!['direct', 'worker'].includes(storage)) throw new TypeError('Choose direct or worker fixture storage.');
const store = new Store(path);
if (storage === 'worker') await store.startWriter();
let sequence = 0;
const waitForever = () => new Promise(() => { setInterval(() => {}, 1000); });
const transport = createHeatingTransport({ canControl: () => fence !== 'authority' });
transport.setDhwrRelay(async on => {
  if (fence === 'evidence') throw Object.assign(new Error('Synthetic unavailable observation'), { code: 'MQTT_STORAGE_FAILED' });
  if (on && boundary === 'before-on') { process.send({ type: 'boundary' }); await waitForever(); }
  const id = ++sequence;
  const confirmed = new Promise(resolve => {
    const receive = message => { if (message.type === 'ack' && message.id === id) { process.off('message', receive); resolve(); } };
    process.on('message', receive);
  });
  process.send({ type: 'command', id, on });
  await confirmed;
  return { sent: true, confirmed: true };
}, () => [fence === 'identity' ? 'replacement-relay' : 'original-relay']);
const executor = new Executor({ input: 'mqtt', store, commandTransport: transport, config: { dhwrPulseMinutes: 1 } });
try {
  if (operation === 'start') {
    await executor.execute({ commands: ['circulation'] }, { manualTest: true });
    if (boundary === 'off-clearing-fails') {
      const full = () => Object.assign(new Error('Synthetic full storage'), { code: 'ERR_SQLITE_ERROR', errcode: 13 });
      if (storage === 'worker') {
        // Outside the synchronous callback the runtime reader sees only the
        // committed duty. Capture the attempted clearing inside that callback
        // and fail its asynchronous COMMIT, before the worker makes it durable.
        let clearing = false;
        const setState = store.setState.bind(store), request = store.writer.request.bind(store.writer);
        store.setState = (key, value, ...args) => {
          const result = setState(key, value, ...args);
          if (key === 'executor:home' && value?.dhwrOutstanding === false) {
            clearing = true;
            store.afterCommit(() => { clearing = false; });
            store.afterRollback(() => { clearing = false; });
          }
          return result;
        };
        store.writer.request = (operation, ...args) => {
          if (operation === 'commit' && clearing) return Promise.reject(full());
          return request(operation, ...args);
        };
      } else {
        const original = store.db.exec.bind(store.db);
        store.db.exec = sql => {
          if (sql === 'COMMIT' && store.getState('executor:home')?.dhwrOutstanding === false) throw full();
          return original(sql);
        };
      }
      try { await executor.exclusive(() => executor.stopDhwr(Date.now())); }
      catch (error) { if (error.errcode !== 13) throw error; }
    } else if (boundary === 'after-clear') await executor.exclusive(() => executor.stopDhwr(Date.now()));
    process.send({ type: 'boundary', state: store.getState('executor:home') });
    await waitForever();
  } else {
    let errorCode = null;
    try { await executor.restore(); } catch (error) { errorCode = error.code; }
    const state = store.getState('executor:home');
    await executor.close({ restore: false }); await store.close();
    process.send({ type: 'restored', state, errorCode });
    process.disconnect();
  }
} catch (error) {
  process.send({ type: 'failure', code: error.code ?? error.name });
  process.exitCode = 1;
  await executor.close({ restore: false }); await store.close(); process.disconnect();
}
