import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
// Optional browser smoke check against a separately launched, isolated Firefox
// WebDriver BiDi instance. Protocol: https://w3c.github.io/webdriver-bidi/ .
const ws = new WebSocket(process.argv[2] ?? 'ws://127.0.0.1:39124/session');
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let id = 0;
const pending = new Map(), errors = [];
ws.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.id) { const p = pending.get(message.id); if (!p) return; clearTimeout(p.timer); pending.delete(message.id); message.type === 'error' ? p.reject(new Error(JSON.stringify(message))) : p.resolve(message.result); }
  else if (message.method === 'log.entryAdded' && message.params.level === 'error') errors.push(message.params.text);
};
const command = (method, params) => new Promise((resolve, reject) => {
  const requestId = ++id;
  const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`Timeout: ${method}`)); }, 15000);
  pending.set(requestId, { resolve, reject, timer });
  ws.send(JSON.stringify({ id: requestId, method, params }));
});
try {
  await command('session.new', { capabilities: {} });
  await command('session.subscribe', { events: ['log.entryAdded'] });
  const { context } = await command('browsingContext.create', { type: 'tab' });
  await command('browsingContext.setViewport', { context, viewport: { width: 1440, height: 2000 }, devicePixelRatio: 1 });
  await command('browsingContext.navigate', { context, url: process.argv[3] ?? 'http://127.0.0.1:39123', wait: 'complete' });
  const evaluate = async expression => {
    const result = await command('script.evaluate', { expression, target: { context }, awaitPromise: true });
    if (result.type === 'exception') throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const until = async expression => {
    for (let i = 0; i < 50; i++) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 100)); }
    throw new Error(`UI did not settle: ${expression}; browser errors: ${JSON.stringify(errors)}`);
  };
  await until("document.getElementById('connection').textContent.includes('SIMULATION')");
  assert.equal(await evaluate("document.getElementById('error').hidden"), true);
  assert.match(await evaluate("document.getElementById('indoor').textContent"), /°C/);
  await evaluate("document.getElementById('duration').value='120'; document.getElementById('override-form').requestSubmit(); true");
  await until("document.getElementById('override-status').textContent.includes('until')");
  await evaluate("document.getElementById('max-drop').value='0.9'; document.getElementById('settings-form').requestSubmit(); true");
  await until("document.getElementById('drop').textContent === '0.9 °C'");
  await evaluate("document.getElementById('max-drop').value='1'; document.getElementById('settings-form').requestSubmit(); true");
  await until("document.getElementById('drop').textContent === '1 °C'");
  await until("document.getElementById('events').children.length > 0");
  const capture = async name => { const shot = await command('browsingContext.captureScreenshot', { context, origin: 'document' }); writeFileSync(`var/${name}.png`, Buffer.from(shot.data, 'base64')); };
  await capture('dashboard-desktop');
  await command('browsingContext.setViewport', { context, viewport: { width: 390, height: 844 }, devicePixelRatio: 1 });
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'Mobile layout must not scroll horizontally');
  await capture('dashboard-mobile');
  assert.deepEqual(errors, []);
  console.log('Browser smoke passed: loaded backend data, chart, override and settings forms, desktop/mobile layout; no console errors.');
  await command('browser.close', {});
} finally { ws.close(); }
