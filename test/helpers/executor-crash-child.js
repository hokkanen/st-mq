import { Store } from '../../src/storage/store.js';
import { Executor } from '../../src/app/executor.js';
import { createHeatingTransport } from '../../src/control/mqtt.js';

// An IPC relay simulator lives in the parent and survives this process. This
// exercises real SQLite/process boundaries, not device electronics or power loss.
const [path, operation, boundary, fence = 'none'] = process.argv.slice(2);
const store = new Store(path);
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
      const original = store.db.exec.bind(store.db);
      store.db.exec = sql => {
        if (sql === 'COMMIT' && store.getState('executor:home')?.dhwrOutstanding === false)
          throw Object.assign(new Error('Synthetic full storage'), { code: 'ERR_SQLITE_ERROR', errcode: 13 });
        return original(sql);
      };
      try { await executor.exclusive(() => executor.stopDhwr(Date.now())); }
      catch (error) { if (error.errcode !== 13) throw error; }
    } else if (boundary === 'after-clear') await executor.exclusive(() => executor.stopDhwr(Date.now()));
    process.send({ type: 'boundary', state: store.getState('executor:home') });
    await waitForever();
  } else {
    let errorCode = null;
    try { await executor.restore(); } catch (error) { errorCode = error.code; }
    const state = store.getState('executor:home');
    await executor.close({ restore: false }); store.close();
    process.send({ type: 'restored', state, errorCode });
    process.disconnect();
  }
} catch (error) {
  process.send({ type: 'failure', code: error.code ?? error.name });
  process.exitCode = 1;
  await executor.close({ restore: false }); store.close(); process.disconnect();
}
