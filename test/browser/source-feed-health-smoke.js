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
  const providerCases = providerProofDefinitions();
  const completeMarket = providerCases.find(row=>row.snapshots?.market?.source==='entsoe');
  const failedMarket = providerCases.find(row=>row.providerHealth?.market?.status==='error');
  const cachedMarket = { garage:'fresh', indoor:'fresh', providerHealth:failedMarket.providerHealth,
    snapshots:completeMarket.snapshots, title:'Both price requests failed; saved prices still cover the required day' };
  const shortMarket = structuredClone(completeMarket);
  shortMarket.garage='fresh'; shortMarket.title='Current price available; required later-day coverage missing';
  shortMarket.snapshots.market.intervals[0].end=NOW+MINUTE;
  const shortWeather = structuredClone(providerCases.find(row=>row.snapshots?.weather?.source==='fmi'));
  shortWeather.garage='fresh'; shortWeather.title='Current weather available; required planning horizon missing';
  shortWeather.snapshots.weather.forecast[0].end=NOW+MINUTE;
  const definitions = [...outdoorDefinitions(), cachedMarket, shortMarket, shortWeather,
    { fmi: 'fresh', openmeteo: 'stale', garage: 'fresh', indoor: 'fresh', title: 'Independent Garage warning recovers' },
    { fmi: 'failed', openmeteo: 'failed', garage: 'failed', indoor: 'failed', title: 'No usable observed source' },
    { fmi: 'never', openmeteo: 'never', garage: 'never', indoor: 'never', title: 'No source observed after startup grace' },
    { fmi: 'never', openmeteo: 'never', garage: 'never', indoor: 'never', startup: true, title: 'No source observed during startup grace' },
    ...[30 * MINUTE - 1, 30 * MINUTE, 30 * MINUTE + 1].map(fmiAge => ({ fmi: 'fresh', openmeteo: 'stale',
      garage: 'unavailable', fmiAge, title: `FMI expiry: ${fmiAge === 30 * MINUTE ? 'exactly 30 minutes'
        : fmiAge < 30 * MINUTE ? 'one millisecond before' : 'one millisecond after'}` })),
    { fmi: 'fresh', openmeteo: 'fresh', garage: 'fresh', title: 'Every observed source is available' },
    ...providerProofDefinitions(),
    ...providerProofDefinitions().map(definition => ({ ...definition, garage: 'fresh',
      title: `${definition.title} (other measurements healthy)` }))];
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
const panel = createRecordingHealth({document,now:()=>now,setTimer:(callback,delay)=>{if(delay===15000)window.expireIntro=callback;return 0;},clearTimer:()=>{},
  request:async()=>{throw Error('Screenshot fixtures cannot request application services');}});
window.showCase = id => { const fixture = cases.find(row=>row.id===id);
  // Isolate source warnings from unrelated filesystem availability: measurements
  // and source health are real projections; disk space here is invented healthy evidence.
  const health=structuredClone(fixture.health);
  health.disk={state:'ok',totalBytes:128e9,freeBytes:80e9,checkedAt:now};
  panel.update({now,recordingHealth:health,recording:fixture.recording,webAccess:{role:'admin'}});
  window.expireIntro?.();
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
    const views = ['light', 'dark'].flatMap(theme => [['desktop', 1440], ['mobile', 390], ['narrow', 320], ['tablet', 768]].map(([viewport, width]) => [theme, viewport, width]));
    for (const [theme, viewport, width] of views) {
      await evaluate(`document.documentElement.dataset.theme='${theme}'`);
      await send('Emulation.setDeviceMetricsOverride', { width, height: 1200, deviceScaleFactor: 1, mobile: false });
      for (const fixture of cases) {
        await evaluate(`showCase('${fixture.id}')`);
        await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        const geometry = `(() => {
          const region=document.querySelector('[aria-labelledby=recording-sources-title]');
          const bounds=region.getBoundingClientRect(), clipped=[];
          for(const node of region.querySelectorAll('*')) {
            if(!node.checkVisibility())continue;
            const box=node.getBoundingClientRect();
            if(box.right>bounds.right+1||box.left<bounds.left-1)clipped.push({node:node.className,left:box.left,right:box.right});
          }
          return {rows:[...document.querySelectorAll('#recording-recording-sources > li')].map(row=>({
            label:row.querySelector('strong').textContent,status:row.querySelector('.recording-source-status').textContent,
            clocks:[...row.querySelectorAll('.recording-source-clocks dt')].map(node=>node.textContent),
            height:row.getBoundingClientRect().height,text:row.textContent})),clipped,
            banner:!document.getElementById('recording-status').hidden,
            tone:document.getElementById('recording-status').dataset.tone,
            pageOverflow:document.documentElement.scrollWidth>innerWidth+1,
            overflow:region.scrollWidth>region.clientWidth+1};})()`;
        const expected = fixture.health.recording.sources?.groups ?? [];
        // Every refresh starts collapsed only when the group is genuinely new;
        // explicitly close existing folds for the collapsed layout matrix.
        await evaluate("document.querySelectorAll('#recording-recording-sources details').forEach(node=>node.open=false)");
        const actual = await evaluate(geometry);
        assert.equal(actual.rows.length, expected.length, `${fixture.title}: one card per API group (${viewport})`);
        const fits = result => {
          assert.equal(result.overflow, false, `${fixture.title}: source section fits ${viewport}`);
          assert.deepEqual(result.clipped, [], `${fixture.title}: every source element fits ${viewport}`);
          assert.equal(result.pageOverflow, false, `${fixture.title}: page fits ${viewport}`);
        };
        fits(actual);
        if(fixture.health.recording.state==='ok' && !fixture.health.attention.length) {
          assert.equal(actual.banner,false,`${fixture.title}: diagnostic-only problems don't keep the banner visible`);
        }
        if(fixture.health.attention.length) assert.equal(actual.banner,true,`${fixture.title}: functional and independent warnings remain visible`);
        for (const [index, group] of expected.entries()) {
          assert(actual.rows[index].text.includes(group.label), `${fixture.title}: logical item is shown`);
          if(group.sourceLabel) assert(actual.rows[index].text.includes(group.sourceLabel),`${fixture.title}: current supplier is shown`);
          for(const issue of group.issues) {
            if (issue.sourceLabel) assert(actual.rows[index].text.includes(issue.sourceLabel), `${fixture.title}: provider identity is retained`);
            if (issue.sourceRole) assert.match(actual.rows[index].text.toLowerCase(), new RegExp(issue.sourceRole), `${fixture.title}: source role is retained`);
            assert(actual.rows[index].text.includes(issue.reason),`${fixture.title}: diagnostic reason is retained`);
          }
        }
        await evaluate("document.querySelectorAll('#recording-recording-sources details').forEach(node=>node.open=true)");
        const expanded = await evaluate(geometry); fits(expanded);
        for(const row of expanded.rows) {
          assert(row.clocks.includes('Source observation'),`${fixture.title}: observation clock remains inspectable`);
          assert(row.clocks.some(label=>['Last provider check','Last polling attempt'].includes(label)),`${fixture.title}: check clock remains separate`);
        }
        // Repainting a stable group must preserve its native disclosure and keyboard focus.
        const hasFold = await evaluate("Boolean(document.querySelector('#recording-recording-sources details > summary'))");
        if(hasFold) {
          await evaluate("document.querySelector('#recording-recording-sources details > summary').focus()");
          await evaluate(`showCase('${fixture.id}')`);
          assert.equal(await evaluate("document.activeElement===document.querySelector('#recording-recording-sources details > summary') && document.activeElement.parentElement.open"),true,
            `${fixture.title}: refresh retains disclosure and keyboard focus`);
          // Remove focus before testing banner visibility in the next case.
          await evaluate('document.activeElement.blur()');
        }
        await evaluate("document.querySelectorAll('#recording-recording-sources details').forEach(node=>node.open=false)");
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
    // Native keyboard behavior and enlarged text exercise the same production
    // disclosures; no synthetic click handler substitutes for browser semantics.
    const interactive=cases.find(row=>(row.health.recording.sources?.groups??[]).some(group=>group.providers?.length));
    await evaluate(`showCase('${interactive.id}')`);
    await send('Emulation.setDeviceMetricsOverride',{width:390,height:1200,deviceScaleFactor:1,mobile:false});
    await evaluate("document.querySelectorAll('#recording-recording-sources details').forEach(node=>node.open=false);document.querySelector('#recording-recording-sources details > summary').focus()");
    for(const [key,code] of [['Enter','Enter'],[' ','Space']]) {
      const before=await evaluate("document.activeElement.parentElement.open");
      await send('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:key==='Enter'?13:32,text:key==='Enter'?'\r':' ',unmodifiedText:key==='Enter'?'\r':' '});
      await send('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:key==='Enter'?13:32});
      assert.equal(await evaluate("document.activeElement.parentElement.open"),!before,`${code} toggles the native source disclosure`);
    }
    for(const theme of ['light','dark']) for(const width of [320,768]) for(const scale of [1.5,2]) {
      await send('Emulation.setDeviceMetricsOverride',{width,height:1600,deviceScaleFactor:1,mobile:false});
      await evaluate(`document.documentElement.dataset.theme='${theme}';
        document.querySelectorAll('#recording-recording-sources details').forEach(node=>node.open=true);
        (()=>{const nodes=[...document.querySelectorAll('#recording-recording-sources *')];
        nodes.forEach(node=>node.style.fontSize='');const sizes=nodes.map(node=>parseFloat(getComputedStyle(node).fontSize));
        nodes.forEach((node,index)=>node.style.fontSize=sizes[index]*${scale}+'px');})()`);
      const enlarged=await evaluate(`(()=>{const region=document.querySelector('[aria-labelledby=recording-sources-title]');
        const bounds=region.getBoundingClientRect();return {overflow:region.scrollWidth>region.clientWidth+1,
          page:document.documentElement.scrollWidth>innerWidth+1,
          clipped:[...region.querySelectorAll('*')].filter(node=>node.checkVisibility()).some(node=>{const r=node.getBoundingClientRect();return r.right>bounds.right+1||r.left<bounds.left-1})}})()`);
      assert.deepEqual(enlarged,{overflow:false,page:false,clipped:false},`${width}/${theme}/${scale}: enlarged source text remains readable without clipping`);
    }
    await evaluate("document.querySelectorAll('#recording-recording-sources *').forEach(node=>node.style.fontSize='')");
    assert.deepEqual(errors, [], 'Production rendering raises no browser errors');
    const matrix = '<table><thead><tr><th>FMI / Open-Meteo</th>' + SOURCE_STATES.map(state => `<th>${escapeHtml(STATE_LABELS[state])}</th>`).join('')
      + '</tr></thead><tbody>' + SOURCE_STATES.map(fmi => '<tr><th>' + escapeHtml(STATE_LABELS[fmi]) + '</th>'
        + SOURCE_STATES.map(openmeteo => { const fixture = cases.find(row => row.matrix && row.fmi === fmi && row.openmeteo === openmeteo);
          return `<td><a href="#case-${fixture.id}">Case ${fixture.id}</a></td>`; }).join('') + '</tr>').join('') + '</tbody></table>';
    reportHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sources needing attention — verified combinations</title>
<style>body{font:14px system-ui;color:#173b30;background:#f7f9f6;margin:24px}h1{font-size:24px}table{border-collapse:collapse;width:100%;font-size:12px}th,td{border:1px solid #bacbbf;padding:8px;text-align:left}.case{background:white;border:1px solid #c8d6cd;margin:24px 0;padding:16px;break-inside:avoid}.case h2{font-size:18px}.shots{display:flex;align-items:flex-start;gap:16px}.shots img{max-width:70%;height:auto}.shots img+img{max-width:27%}p{line-height:1.5}a{color:#256a50}@media print{body{margin:0;background:white}.overview{break-after:page}.case{break-after:page;border:0;margin:0;padding:0}.shots img{max-height:9in;object-fit:contain;object-position:top}}@page{size:A4;margin:.4in}</style></head><body>
<div class="overview"><h1>Actual “Sources needing attention” panel</h1><p>Invented observations only. All cases use the real Engine, Recorder and recording-health API projection, rendered by the production UI. No live service, household state or equipment was accessed. Every API warning is checked against the visible panel at 320px, 390px, 768px and 1440px widths, collapsed and expanded, in both light and dark themes. Expand each case's dark-theme disclosure for its additional screenshots.</p>
<p>The 25-pair weather matrix includes a separate unavailable Garage pipe estimate. Additional cases cover Garage recovery, startup, complete source loss, exact expiry, failed backup checks, FMI/Open-Meteo weather and ENTSO-E/Elering price failures, and partial solar/price coverage.</p>${matrix}</div>
${cases.map(fixture => `<section class="case" id="case-${fixture.id}"><h2>${fixture.id}. ${escapeHtml(fixture.title)}</h2><p>Current outdoor source: <b>${escapeHtml(fixture.currentOutdoorSource ?? 'unavailable')}</b>. Visible items: <b>${fixture.rendered.length}</b>. Recording: <b>${escapeHtml(fixture.health.recording.state)}</b>.</p><div class="shots">${['desktop', 'mobile'].map(viewport => `<img alt="${escapeHtml(viewport)} Sources needing attention for ${escapeHtml(fixture.title)}" src="data:image/png;base64,${readFileSync(join(out, fixture.screenshots[viewport])).toString('base64')}">`).join('')}</div><details><summary>Dark theme screenshots</summary><div class="shots">${['desktop-dark', 'mobile-dark'].map(view => `<img alt="${escapeHtml(view)} Sources needing attention for ${escapeHtml(fixture.title)}" src="data:image/png;base64,${readFileSync(join(out, fixture.screenshots[view])).toString('base64')}">`).join('')}</div></details></section>`).join('')}</body></html>`;
    writeFileSync(join(out, 'sources-needing-attention.html'), reportHtml);
    await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/report` });
    await evaluate('document.fonts.ready');
    const pdf = await send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true });
    writeFileSync(join(out, 'sources-needing-attention.pdf'), Buffer.from(pdf.data, 'base64'));
    writeFileSync(join(out, 'results.json'), JSON.stringify({ synthetic: true, generatedAt: NOW, cases }, null, 2));
    console.log(JSON.stringify({ out, cases: cases.length, outdoorCombinations: 25, widths: [320, 390, 768, 1440], themes: ['light', 'dark'], renderedMatchesApi: true }));
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
