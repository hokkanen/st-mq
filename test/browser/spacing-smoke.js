// Production markup and every stylesheet, without live providers or dashboard
// mutations. Feature suites separately exercise the renderers and role behavior.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uiSpacingFailures } from '../../scripts/lib/ui-spacing-checks.js';

const directory = await mkdtemp(join(tmpdir(), 'stmq-spacing-browser-'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const cssNames = ['monitor', 'pair-status', 'select-picker', 'timing-benefit', 'charging-diagnostics',
  'charging-tests', 'charging-setup', 'recording-health', 'secure-web-access', 'heating-explorer'];
const css = await Promise.all(cssNames.map(name => readFile(new URL(`../../chart/${name}.css`, import.meta.url), 'utf8')));
const html = (await readFile(new URL('../../chart/index.html', import.meta.url), 'utf8'))
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
  .replace(/<link\b[^>]*>/g, '')
  .replace('</head>', `<style>${css.join('\n')}</style></head>`);
const server = createServer((request, response) => {
  response.writeHead(request.url === '/' ? 200 : 204, { 'Content-Type': 'text/html' });
  response.end(request.url === '/' ? html : undefined);
});
let browser, socket, sequence = 0;
const pending = new Map(), errors = [], coverage = [];
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = spawn(process.env.STMQ_CHROME_BIN ?? '/opt/google/chrome/chrome', ['--headless', '--no-sandbox',
    '--disable-gpu', '--no-first-run', '--disable-background-networking', '--remote-debugging-port=0',
    `--user-data-dir=${join(directory, 'chrome')}`, 'about:blank'], { stdio: 'ignore' });
  let port;
  for (let i = 0; i < 200 && !port; i++) {
    try { port = Number((await readFile(join(directory, 'chrome/DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch {}
    if (!port) await pause(30);
  }
  assert(port, 'Disposable browser starts');
  const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then(r => r.json());
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const task = pending.get(message.id); if (!task) return;
      pending.delete(message.id); clearTimeout(task.timer);
      message.error ? task.reject(new Error(message.error.message)) : task.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 15000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
  for (let i = 0; i < 200 && !await evaluate("document.readyState === 'complete'"); i++) await pause(20);
  await evaluate(`(() => {
    document.body.dataset.authenticated='true'; document.body.dataset.accessRole='admin';
    for (const fold of document.querySelectorAll('details')) {
      for(let node=fold;node && node!==document.body;node=node.parentElement) node.hidden=false;
      fold.open=true;
    }
    for (const node of document.querySelectorAll('.notice, .read-only-help, .heating-hold-warning, .form-error, .recording-task-notice')) {
      node.hidden=false;
      if(!node.textContent.trim()) node.textContent='Synthetic warning: source details are unavailable. Refresh to check the current state.';
    }
    // These windows are created lazily by their feature modules in the real app.
    for(const className of ['confirmation-dialog','control-dialog charging-time-dialog',
      'control-dialog charging-test-dialog','control-dialog charging-flexibility-dialog',
      'charging-priority-dialog','charging-report-dialog']) {
      const dialog=document.createElement('dialog');dialog.className=className;
      const heading=document.createElement('h2');heading.textContent='Synthetic confirmation and recorded details';
      const text=document.createElement('p');text.textContent='A longer explanation remains readable while the current action and its confirmation are visible.';
      const button=document.createElement('button');button.textContent='Close';dialog.append(heading,text,button);document.body.append(dialog);
    }
    return true;
  })()`);
  const folds = await evaluate("[...document.querySelectorAll('details')].map((n,i)=>({index:i,id:n.id||n.className}))");
  assert.equal(folds.length, (html.match(/<details\b/g) ?? []).length, 'Full production disclosure catalogue is present');
  const dialogs = await evaluate("[...document.querySelectorAll('dialog')].map((n,i)=>({index:i,id:n.id||n.className}))");
  const check = async label => {
    await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    assert.deepEqual(await evaluate(`(${uiSpacingFailures.toString()})()`), [], label);
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true, `${label}: page fits`);
  };
  for (const width of [320, 360, 390, 480, 481, 640, 641, 768, 800, 801, 1440]) for (const theme of ['dark', 'light']) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)};true`);
    await check(`${width}/${theme}/expanded`);
    if ([320, 390, 1440].includes(width)) {
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      await writeFile(join(directory, `spacing-${width}-${theme}.png`), Buffer.from(shot.data, 'base64'));
    }
    if (width === 320 || width === 1440) {
      for (const { index, id } of dialogs) {
        await evaluate(`document.querySelectorAll('dialog')[${index}].showModal();true`);
        await check(`${width}/${theme}/${id}`);
        assert.equal(await evaluate(`(()=>{const d=document.querySelectorAll('dialog')[${index}];return d.scrollWidth<=d.clientWidth+1})()`), true, `${id}: dialog content fits`);
        await evaluate(`document.querySelectorAll('dialog')[${index}].close();true`);
      }
    }
    coverage.push({ width, theme, folds: folds.length, dialogs: width === 320 || width === 1440 ? dialogs.length : 0 });
  }
  // Guard against repeating the original regression, or undoing the good part.
  for (const width of [320, 768, 1440]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await evaluate("document.querySelector('#home-control').style.paddingInline='var(--ui-inset)';true");
    assert((await evaluate(`(${uiSpacingFailures.toString()})()`)).some(failure => failure.rule === 'card/window padding'),
      `${width}: the small fold step cannot replace outside card padding`);
    await evaluate("document.querySelector('#home-control').style.removeProperty('padding-inline');document.getElementById('temporary-details').style.marginInlineStart='24px';true");
    assert((await evaluate(`(${uiSpacingFailures.toString()})()`)).some(failure => failure.rule === 'one disclosure step'),
      `${width}: roomy outer padding cannot become nested fold indentation`);
    await evaluate("document.getElementById('temporary-details').style.marginInlineStart='';document.getElementById('temporary-details').style.paddingInlineStart='var(--ui-inset)';true");
    assert((await evaluate(`(${uiSpacingFailures.toString()})()`)).some(failure => failure.rule === 'one disclosure step'),
      `${width}: a nested level cannot add both margin and padding`);
    await evaluate("document.getElementById('temporary-details').style.paddingInlineStart='';true");
    await check(`${width}/regression-guards-restored`);
    await evaluate("document.getElementById('pairing-reset-dialog').showModal();true");
    for (const selector of ['#pairing-reset-dialog', '.pairing-reset-header', '.pairing-reset-body', '.pairing-reset-actions']) {
      const wrapper = selector === '#pairing-reset-dialog';
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).style.paddingInline=${JSON.stringify(wrapper ? 'var(--ui-surface-inset)' : 'var(--ui-inset)')};true`);
      const node = wrapper ? 'pairing-reset-dialog' : selector.slice(1);
      assert((await evaluate(`(${uiSpacingFailures.toString()})()`)).some(failure => failure.rule === 'card/window padding' && failure.node === node),
        `${width}: ${wrapper ? 'the dialog wrapper cannot double the owned inset' : `${node} must retain outside window padding`}`);
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).style.removeProperty('padding-inline');true`);
    }
    await check(`${width}/dialog-regression-guards-restored`);
    await evaluate("document.getElementById('pairing-reset-dialog').close();true");
  }
  // Every static fold can close/reopen without changing its horizontal step.
  await evaluate("document.querySelectorAll('details').forEach(n=>n.open=false);true");
  await check('collapsed catalogue');
  await evaluate("document.querySelectorAll('details').forEach(n=>n.querySelector(':scope > summary')?.click());true");
  await check('reopened catalogue');
  // Access-specific CSS, including long warning messages.
  for (const role of ['family', 'admin']) for (const authenticated of ['false', 'true']) {
    await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 640, deviceScaleFactor: 1, mobile: false });
    await evaluate(`document.body.dataset.accessRole='${role}';document.body.dataset.authenticated='${authenticated}';true`);
    await check(`${role}/${authenticated}`);
  }
  assert.deepEqual(errors, []);
  await writeFile(join(directory, 'coverage.json'), JSON.stringify(coverage, null, 2));
  console.log(JSON.stringify({ result: 'spacing-catalogue-passed', coverage, folds: folds.length, dialogs: dialogs.length, directory }));
} finally {
  socket?.close(); browser?.kill();
  await new Promise(resolve => server.close(resolve));
  await rm(join(directory, 'chrome'), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
