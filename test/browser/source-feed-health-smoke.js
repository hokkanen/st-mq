// Exact production "Sources needing attention" panel, driven by real isolated
// Engine/Recorder evidence. No household configuration, devices or services.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSourceHealthFixture, outdoorDefinitions, providerProofDefinitions, SOURCE_STATES, STATE_LABELS, NOW, MINUTE } from '../helpers/source-feed-health-fixture.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const escapeHtml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;');

async function proofCases() {
  const definitions = [...outdoorDefinitions(),
    { fmi: 'fresh', openmeteo: 'stale', garage: 'fresh', indoor: 'fresh', title: 'Independent Garage warning recovers' },
    { fmi: 'failed', openmeteo: 'failed', garage: 'failed', indoor: 'failed', title: 'No usable observed source' },
    { fmi: 'never', openmeteo: 'never', garage: 'never', indoor: 'never', title: 'No source observed after startup grace' },
    { fmi: 'never', openmeteo: 'never', garage: 'never', indoor: 'never', startup: true, title: 'No source observed during startup grace' },
    ...[30 * MINUTE - 1, 30 * MINUTE, 30 * MINUTE + 1].map(fmiAge => ({ fmi: 'fresh', openmeteo: 'stale',
      garage: 'unavailable', fmiAge, title: `FMI expiry: ${fmiAge === 30 * MINUTE ? 'exactly 30 minutes'
        : fmiAge < 30 * MINUTE ? 'one millisecond before' : 'one millisecond after'}` })),
    { fmi: 'fresh', openmeteo: 'fresh', garage: 'fresh', title: 'Every observed source is available' },
    ...providerProofDefinitions()];
  const cases = [];
  for (const [index, definition] of definitions.entries()) {
    const fixture = createSourceHealthFixture(definition);
    try {
      const before = fixture.store.db.prepare('SELECT total_changes() n').get().n;
      const health = await fixture.status(), recording = fixture.engine.recordingSourceStatus(NOW);
      assert.equal(fixture.store.db.prepare('SELECT total_changes() n').get().n, before, 'Health reads cannot mutate evidence');
      cases.push({ ...definition, id: String(index + 1).padStart(2, '0'), health, recording,
        currentOutdoorSource: fixture.selectedSource, screenshots: {} });
    } finally { await fixture.close(); }
  }
  return cases;
}

export async function runSourceFeedHealthSmoke() {
  const out = mkdtempSync(join(tmpdir(), 'stmq-source-feed-health-'));
  mkdirSync(join(out, 'screenshots'));
  const cases = await proofCases();
  const markup = readFileSync(join(root, 'chart/index.html'), 'utf8');
  const context = markup.slice(markup.indexOf('<main>') + '<main>'.length,
    markup.indexOf('<section class="controller-panels"'));
  const start = markup.indexOf('<details id="recording-details"');
  const recordingMarkup = markup.slice(start, markup.indexOf('</section>\n\n    <section id="pairing-panel"', start));
  assert(start >= 0 && recordingMarkup.includes('id="recording-recording-sources"'));
  const html = `<!doctype html><html data-theme="light" lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/chart/monitor.css">
<link rel="stylesheet" href="/chart/recording-health.css"><style>body{margin:0;padding:12px}main{max-width:880px;margin:auto}#recording-details{margin:0}</style></head>
<body data-authenticated="true"><main>${context}${recordingMarkup}</main><script type="module">
import { createRecordingHealth } from '/chart/recording-health.js';
const cases = ${JSON.stringify(cases)}, now = ${NOW};
const panel = createRecordingHealth({document,now:()=>now,setTimer:()=>0,clearTimer:()=>{},
  request:async()=>{throw Error('Screenshot fixtures cannot request application services');}});
window.showCase = id => { const fixture = cases.find(row=>row.id===id);
  panel.update({now,recordingHealth:fixture.health,recording:fixture.recording,webAccess:{role:'admin'}});
  document.getElementById('recording-details').open=true;
  document.getElementById('recording-recording-card').open=true;
}; showCase(cases[0].id); window.ready=true;</script></body></html>`;
  let reportHtml = '';
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://fixture').pathname;
    if (path === '/' || path === '/report') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(path === '/' ? html : reportHtml); return; }
    if (!path.startsWith('/chart/') && !path.startsWith('/src/')) { res.writeHead(404); res.end(); return; }
    const file = resolve(root, '.' + path);
    if (!file.startsWith(root + '/')) { res.writeHead(403); res.end(); return; }
    try { res.writeHead(200, { 'Content-Type': path.endsWith('.css') ? 'text/css' : 'text/javascript' }); res.end(readFileSync(file)); }
    catch { res.writeHead(404); res.end(); }
  });
  const profile = mkdtempSync(join(tmpdir(), 'stmq-source-feed-chrome-'));
  const pending = new Map(), errors = [];
  let browser, socket, sequence = 0;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = spawn(process.env.CHROME_BIN || '/opt/google/chrome/chrome', ['--headless', '--no-sandbox', '--disable-gpu',
      '--disable-background-networking', '--no-first-run', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
      `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
    let port;
    for (let retry = 0; retry < 200 && !port; retry++) {
      try { port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { /* Browser is starting. */ }
      if (!port) await pause(25);
    }
    assert(port, 'Disposable Chrome exposes its local debugger');
    const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then(response => response.json());
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const task = pending.get(message.id); if (!task) return;
        pending.delete(message.id); clearTimeout(task.timer);
        if (message.error) task.reject(Error(JSON.stringify(message.error))); else task.resolve(message.result);
      } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence, timer = setTimeout(() => reject(Error(`Browser deadline: ${method}`)), 20_000);
      pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async expression => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value;
    };
    await send('Runtime.enable'); await send('Page.enable');
    await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}` });
    let ready = false;
    for (let retry = 0; retry < 200 && !ready; retry++) { ready = await evaluate('window.ready===true'); if (!ready) await pause(25); }
    assert(ready, JSON.stringify(errors));
    const views = ['light', 'dark'].flatMap(theme => [['desktop', 920], ['mobile', 390]].map(([viewport, width]) => [theme, viewport, width]));
    for (const [theme, viewport, width] of views) {
      await evaluate(`document.documentElement.dataset.theme='${theme}'`);
      await send('Emulation.setDeviceMetricsOverride', { width, height: 1200, deviceScaleFactor: 1, mobile: false });
      for (const fixture of cases) {
        await evaluate(`showCase('${fixture.id}')`);
        await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        const actual = await evaluate(`(() => {
          const region=document.querySelector('[aria-labelledby=recording-sources-title]');
          const bounds=region.getBoundingClientRect(), clipped=[];
          for(const node of region.querySelectorAll('*')) {
            if(!node.checkVisibility())continue;
            const box=node.getBoundingClientRect();
            if(box.right>bounds.right+1||box.left<bounds.left-1)clipped.push({node:node.className,left:box.left,right:box.right});
          }
          return {title:document.getElementById('recording-recording-sources-title').textContent,
            rows:[...document.querySelectorAll('#recording-recording-sources > li')].map(row=>({
              label:row.querySelector('strong').textContent,status:row.querySelector('.recording-source-status').textContent,
              clocks:[...row.querySelectorAll('.recording-source-clocks dt')].map(node=>node.textContent),
              text:row.textContent})),clipped,viewport:innerWidth,regionWidth:bounds.width,
              pageOverflow:document.documentElement.scrollWidth>innerWidth+1,
              overflow:region.scrollWidth>region.clientWidth+1};})()`);
        const expected = fixture.health.recording.sources?.issues ?? [];
        assert.equal(actual.rows.length, expected.length, `${fixture.title}: every API issue is visible (${viewport})`);
        assert.equal(actual.overflow, false, `${fixture.title}: source section fits ${viewport}`);
        assert.deepEqual(actual.clipped, [], `${fixture.title}: every source element fits ${viewport}`);
        assert.equal(actual.pageOverflow, false, `${fixture.title}: page fits ${viewport}`);
        for (const [index, issue] of expected.entries()) {
          assert(actual.rows[index].text.includes(issue.label), `${fixture.title}: signal label is shown`);
          if (issue.sourceLabel) assert(actual.rows[index].text.includes(issue.sourceLabel), `${fixture.title}: provider identity is shown`);
          if (issue.sourceRole) assert.match(actual.rows[index].text.toLowerCase(), new RegExp(issue.sourceRole), `${fixture.title}: source role is shown`);
          if (issue.feed) assert(actual.rows[index].text.includes(issue.feed.label), `${fixture.title}: affected feed is shown`);
          assert.deepEqual(actual.rows[index].clocks, ['Source observation',
            issue.kind === 'provider' || issue.checkKind === 'acquisition' ? 'Last provider check' : 'Last polling attempt'],
          `${fixture.title}: original observation and request clocks keep their separate meanings`);
        }
        // Capture the displayed viewport. Chrome's beyond-viewport clip capture
        // can reflow a narrow source card after geometry was checked, yielding
        // a misleading cropped status. A section-height viewport preserves the
        // actual layout and includes the complete requested section directly.
        const sectionHeight = await evaluate("document.querySelector('[aria-labelledby=recording-sources-title]').getBoundingClientRect().height");
        await send('Emulation.setDeviceMetricsOverride', { width, height: Math.ceil(sectionHeight + 32), deviceScaleFactor: 1, mobile: false });
        await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>{const region=document.querySelector('[aria-labelledby=recording-sources-title]');
          scrollTo(0,region.getBoundingClientRect().top+scrollY-12);requestAnimationFrame(resolve)}))`);
        const screenshotGeometry = await evaluate(`(() => {const r=document.querySelector('[aria-labelledby=recording-sources-title]').getBoundingClientRect();
          return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight}})()`);
        assert(screenshotGeometry.top >= 0 && screenshotGeometry.bottom <= screenshotGeometry.height,
          `${fixture.title}: the complete source section is visible in the screenshot`);
        const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        const view = viewport + (theme === 'dark' ? '-dark' : '');
        const filename = `${fixture.id}-${view}.png`;
        writeFileSync(join(out, 'screenshots', filename), Buffer.from(shot.data, 'base64'));
        fixture.screenshots[view] = 'screenshots/' + filename;
        fixture.rendered = actual.rows;
        (fixture.geometry ??= {})[view] = screenshotGeometry;
      }
    }
    assert.deepEqual(errors, [], 'Production rendering raises no browser errors');
    const matrix = '<table><thead><tr><th>FMI / Open-Meteo</th>' + SOURCE_STATES.map(state => `<th>${escapeHtml(STATE_LABELS[state])}</th>`).join('')
      + '</tr></thead><tbody>' + SOURCE_STATES.map(fmi => '<tr><th>' + escapeHtml(STATE_LABELS[fmi]) + '</th>'
        + SOURCE_STATES.map(openmeteo => { const fixture = cases.find(row => row.matrix && row.fmi === fmi && row.openmeteo === openmeteo);
          return `<td><a href="#case-${fixture.id}">Case ${fixture.id}</a></td>`; }).join('') + '</tr>').join('') + '</tbody></table>';
    reportHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sources needing attention — verified combinations</title>
<style>body{font:14px system-ui;color:#173b30;background:#f7f9f6;margin:24px}h1{font-size:24px}table{border-collapse:collapse;width:100%;font-size:12px}th,td{border:1px solid #bacbbf;padding:8px;text-align:left}.case{background:white;border:1px solid #c8d6cd;margin:24px 0;padding:16px;break-inside:avoid}.case h2{font-size:18px}.shots{display:flex;align-items:flex-start;gap:16px}.shots img{max-width:70%;height:auto}.shots img+img{max-width:27%}p{line-height:1.5}a{color:#256a50}@media print{body{margin:0;background:white}.overview{break-after:page}.case{break-after:page;border:0;margin:0;padding:0}.shots img{max-height:9in;object-fit:contain;object-position:top}}@page{size:A4;margin:.4in}</style></head><body>
<div class="overview"><h1>Actual “Sources needing attention” panel</h1><p>Invented observations only. All cases use the real Engine, Recorder and recording-health API projection, rendered by the production UI. No live service, household state or equipment was accessed. Every API warning is checked against the visible panel at 920px and 390px widths in both light and dark themes. Expand each case's dark-theme disclosure for its additional screenshots.</p>
<p>The 25-pair weather matrix includes a separate unavailable Garage pipe estimate. Additional cases cover Garage recovery, startup, complete source loss, exact expiry, failed backup checks, FMI/Open-Meteo weather and ENTSO-E/Elering price failures, and partial solar/price coverage.</p>${matrix}</div>
${cases.map(fixture => `<section class="case" id="case-${fixture.id}"><h2>${fixture.id}. ${escapeHtml(fixture.title)}</h2><p>Current outdoor source: <b>${escapeHtml(fixture.currentOutdoorSource ?? 'unavailable')}</b>. Visible issues: <b>${fixture.rendered.length}</b>. Recording: <b>${escapeHtml(fixture.health.recording.state)}</b>.</p><div class="shots">${['desktop', 'mobile'].map(viewport => `<img alt="${escapeHtml(viewport)} Sources needing attention for ${escapeHtml(fixture.title)}" src="data:image/png;base64,${readFileSync(join(out, fixture.screenshots[viewport])).toString('base64')}">`).join('')}</div><details><summary>Dark theme screenshots</summary><div class="shots">${['desktop-dark', 'mobile-dark'].map(view => `<img alt="${escapeHtml(view)} Sources needing attention for ${escapeHtml(fixture.title)}" src="data:image/png;base64,${readFileSync(join(out, fixture.screenshots[view])).toString('base64')}">`).join('')}</div></details></section>`).join('')}</body></html>`;
    writeFileSync(join(out, 'sources-needing-attention.html'), reportHtml);
    await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/report` });
    await evaluate('document.fonts.ready');
    const pdf = await send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true });
    writeFileSync(join(out, 'sources-needing-attention.pdf'), Buffer.from(pdf.data, 'base64'));
    writeFileSync(join(out, 'results.json'), JSON.stringify({ synthetic: true, generatedAt: NOW, cases }, null, 2));
    console.log(JSON.stringify({ out, cases: cases.length, outdoorCombinations: 25, widths: [920, 390], themes: ['light', 'dark'], renderedMatchesApi: true }));
    await send('Page.close');
    return out;
  } finally {
    socket?.close(); for (const task of pending.values()) clearTimeout(task.timer); browser?.kill();
    await new Promise(resolve => server.close(resolve));
    if (browser && browser.exitCode === null) await new Promise(resolve => browser.once('exit', resolve));
    rmSync(profile, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runSourceFeedHealthSmoke();
