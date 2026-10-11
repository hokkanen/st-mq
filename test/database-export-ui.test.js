import test from 'node:test';
import assert from 'node:assert/strict';
import { bindDatabaseExport } from '../chart/database-export.js';
import { createAccessControls } from '../chart/web-access.js';
import { createReadOnlyControls } from '../chart/dashboard-access.js';

const filename = 'stmq-2026-09-25T15-04-32-123Z.sqlite';
const path = `/example/exports/${filename}`;
function fixture(request, windowOverrides = {}, options = {}) {
  const button = () => ({ disabled: false, isConnected: true, dataset: {}, attributes: new Map(),
    getAttribute(name) { return this.attributes.get(name) ?? null; },
    hasAttribute(name) { return this.attributes.has(name); },
    setAttribute(name, value) { this.attributes.set(name, value); },
    removeAttribute(name) { this.attributes.delete(name); },
    matches: () => true, closest() { return this; },
    addEventListener(_event, handler) { this.click = handler; } });
  const saveButton = button(), downloadButton = button(), classes = new Set();
  const message = { textContent: '', classList: { add: value => classes.add(value), remove: value => classes.delete(value) } };
  const links = [], blobs = [], timers = [], revoked = [], intervals = new Map();
  const progress = button(), detail = { textContent: '', hidden: true };
  const document = {
    querySelectorAll: selector => selector === '[data-write-control]' ? [saveButton] : [saveButton, downloadButton],
    getElementById: () => ({}), addEventListener() {}, removeEventListener() {},
    createElement(tag) {
      assert.equal(tag, 'a');
      return { click() { this.clicked = true; }, remove() { this.removed = true; } };
    },
    body: { dataset: {}, append: link => links.push(link) },
  };
  const window = {
    URL: { createObjectURL: blob => { blobs.push(blob); return 'blob:database-copy'; }, revokeObjectURL: url => revoked.push(url) },
    setTimeout: (run, delay) => timers.push({ run, delay }),
    setInterval: run => { const id = intervals.size + 1; intervals.set(id, run); return id; },
    clearInterval: id => intervals.delete(id),
    ...windowOverrides,
  };
  const panel = bindDatabaseExport({ saveButton, downloadButton, message, progress, detail, request, window, document, ...options });
  return { panel, document, saveButton, downloadButton, message, progress, detail, classes, links, blobs, timers, revoked, intervals };
}

test('save local copy identifies the file beside the correctly mapped backup folder without downloading', async () => {
  const requests = [];
  const view = fixture(async method => { requests.push(method); return Response.json({ filename, path }); });
  await view.saveButton.click();
  assert.deepEqual(requests, ['POST']);
  assert.equal(view.message.textContent, `Database copy saved on the server: ${filename}. See the backup folder above.`);
  assert.equal(view.links.length, 0);
  assert.equal(view.blobs.length, 0);
  assert.equal(view.saveButton.disabled, false);
  assert.equal(view.downloadButton.disabled, false);
});

test('dated export receipts last one day and a newer action starts its own lifetime', async () => {
  let now = Date.parse('2026-10-11T12:00:00Z'), attempts = 0;
  const view = fixture(async () => ++attempts === 1 ? Response.json({ filename, path })
    : Response.json({ error: 'The selected copy could not be saved.' }, { status: 409 }), {}, { now: () => now });
  await view.saveButton.click();
  assert.match(view.detail.textContent, /11 Oct 2026/);
  now += 24 * 3600_000 - 1; view.panel.tick();
  assert.match(view.message.textContent, /Database copy saved/);
  await view.saveButton.click();
  now += 1; view.panel.tick();
  assert.match(view.message.textContent, /could not be saved/);
  now += 24 * 3600_000 - 1; view.panel.tick();
  assert.equal(view.message.textContent, ''); assert.equal(view.detail.hidden, true);
  assert.equal(view.classes.has('form-error'), false);
});

test('logout clears an export and a late response cannot publish an old receipt or download', async () => {
  let resolve;
  const view = fixture(() => new Promise(done => { resolve = done; }));
  const work = view.downloadButton.click(); view.panel.clear();
  resolve(new Response('synthetic database', { headers: { 'content-disposition': `attachment; filename="${filename}"` } }));
  await work;
  assert.equal(view.links.length, 0); assert.equal(view.message.textContent, '');
  assert.equal(view.detail.hidden, true); assert.equal(view.progress.hidden, true);
  assert.equal(view.intervals.size, 0); assert.equal(view.downloadButton.disabled, false);
});

test('clearing an export cancels its response body after headers for blob and selected-file downloads', async () => {
  for (const picker of [false, true]) {
    let cancelled = false, aborted = false, signal;
    const view = fixture(async (_method, options) => {
      signal = options.signal;
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); },
        cancel() { cancelled = true; },
      }), { headers: { 'content-disposition': `attachment; filename="${filename}"` } });
    }, picker ? { showSaveFilePicker: async () => ({ createWritable: async () => new WritableStream({ abort() { aborted = true; } }) }) } : {});
    const work = view.downloadButton.click(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(signal.aborted, false);
    view.panel.clear(); await work;
    assert.equal(signal.aborted, true); assert.equal(cancelled, true);
    if (picker) assert.equal(aborted, true);
    assert.equal(view.message.textContent, ''); assert.equal(view.links.length, 0);
    assert.equal(view.intervals.size, 0);
  }
});

test('download uses the complete server timestamped filename and releases the browser object URL', async () => {
  const requests = [];
  const view = fixture(async method => {
    requests.push(method);
    return new Response('synthetic database bytes', { headers: { 'content-disposition': `attachment; filename="${filename}"` } });
  });
  await view.downloadButton.click();
  assert.deepEqual(requests, ['GET']);
  assert.equal(view.links.length, 1);
  assert.equal(view.links[0].download, filename);
  assert.equal(view.links[0].href, 'blob:database-copy');
  assert(view.links[0].clicked);
  assert(view.links[0].removed);
  assert.equal(await view.blobs[0].text(), 'synthetic database bytes');
  assert.match(view.message.textContent, /2026-09-25T15-04-32-123Z/);
  assert.equal(view.timers[0].delay, 60_000);
  view.timers[0].run();
  assert.deepEqual(view.revoked, ['blob:database-copy']);
});

test('both buttons stay disabled until the pending export completes', async () => {
  let complete, calls = 0;
  const view = fixture(() => { calls++; return new Promise(resolve => { complete = resolve; }); });
  const pending = view.saveButton.click();
  assert(view.saveButton.disabled);
  assert(view.downloadButton.disabled);
  await view.downloadButton.click();
  await view.saveButton.click();
  assert.equal(calls, 1);
  complete(Response.json({ filename, path }));
  await pending;
  assert(!view.saveButton.disabled);
  assert(!view.downloadButton.disabled);
});

test('a view-only instance permits downloading while preserving the local-save restriction', async () => {
  const requests = [];
  const view = fixture(async method => {
    requests.push(method);
    return new Response('synthetic database bytes', { headers: { 'content-disposition': `attachment; filename="${filename}"` } });
  });
  const replica = createReadOnlyControls({ document: view.document, Observer: null });
  replica.update({ role: 'slave' });
  await view.downloadButton.click();
  assert.deepEqual(requests, ['GET']);
  assert.equal(view.blobs.length, 1);
  assert.equal(view.saveButton.disabled, true);
  assert.equal(view.downloadButton.disabled, false);
  replica.close();
});

test('rerendering buttons cannot admit concurrent exports while the request is pending', async () => {
  let complete, calls = 0;
  const view = fixture(() => { calls++; return new Promise(resolve => { complete = resolve; }); });
  const pending = view.saveButton.click();
  view.saveButton.disabled = view.downloadButton.disabled = false;
  await view.downloadButton.click();
  await view.saveButton.click();
  assert.equal(calls, 1);
  complete(Response.json({ filename, path }));
  await pending;
});

test('permissions changing during export remain authoritative when the request completes', async () => {
  for (const restriction of ['family', 'replica']) {
    let complete;
    const view = fixture(() => new Promise(resolve => { complete = resolve; }));
    const access = createAccessControls({ document: view.document, Observer: null });
    const replica = createReadOnlyControls({ document: view.document, Observer: null });
    access.update({ role: 'admin' }); replica.update({ role: 'master' });
    const pending = view.saveButton.click();
    if (restriction === 'family') access.update({ role: 'family' });
    else replica.update({ role: 'slave' });
    complete(Response.json({ filename, path }));
    await pending;
    assert.equal(view.saveButton.disabled, true, `${restriction}: completing export retains write restrictions`);
    assert.equal(view.downloadButton.disabled, restriction === 'family');
    access.update({ role: 'admin' }); replica.update({ role: 'master' });
    assert.equal(view.saveButton.disabled, false, `${restriction}: releasing permissions does not revive an old pending lock`);
    assert.equal(view.downloadButton.disabled, false);
    access.close(); replica.close();
  }
});

test('supporting browsers choose a timestamped destination before requesting and stream the download', async () => {
  const events = [], chunks = [];
  const view = fixture(async method => {
    events.push(method);
    return new Response('synthetic streamed database');
  }, {
    showSaveFilePicker: async options => {
      events.push('picker');
      assert.match(options.suggestedName, /^stmq-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.sqlite$/);
      return { createWritable: async () => new WritableStream({ write: chunk => chunks.push(chunk) }) };
    },
  });
  await view.downloadButton.click();
  assert.deepEqual(events, ['picker', 'GET']);
  assert.equal(Buffer.concat(chunks).toString(), 'synthetic streamed database');
  assert.equal(view.blobs.length, 0);
  assert.equal(view.message.textContent, 'Database download saved.');
});

test('cancelling the browser picker makes no request and local save never opens the picker', async () => {
  let requests = 0, pickers = 0;
  const view = fixture(async () => { requests++; return Response.json({ filename, path }); }, {
    showSaveFilePicker: async () => { pickers++; throw new DOMException('Cancelled', 'AbortError'); },
  });
  await view.downloadButton.click();
  assert.equal(requests, 0);
  assert.equal(pickers, 1);
  assert.equal(view.message.textContent, 'Download cancelled.');
  assert(!view.classes.has('form-error'));
  assert(!view.downloadButton.disabled);
  await view.saveButton.click();
  assert.equal(requests, 1);
  assert.equal(pickers, 1);
});

test('a failed streamed download aborts the selected file and permits retry', async () => {
  let aborted = 0;
  const output = { abort: async () => { aborted++; } };
  const view = fixture(async () => ({ ok: true, body: { pipeTo: async target => {
    assert.equal(target, output);
    throw new Error('Download interrupted.');
  } } }), {
    showSaveFilePicker: async () => ({ createWritable: async () => output }),
  });
  await view.downloadButton.click();
  assert.equal(aborted, 1);
  assert.equal(view.message.textContent, 'Download interrupted.');
  assert(view.classes.has('form-error'));
  assert(!view.saveButton.disabled);
  assert(!view.downloadButton.disabled);
});

test('API errors remain visible and a subsequent export clears the error', async () => {
  let attempts = 0;
  const view = fixture(async () => ++attempts === 1
    ? Response.json({ error: 'A database export is already in progress.' }, { status: 409 })
    : Response.json({ filename, path }));
  await view.saveButton.click();
  assert.equal(view.message.textContent, 'A database export is already in progress.');
  assert(view.classes.has('form-error'));
  assert(!view.saveButton.disabled);
  await view.saveButton.click();
  assert(!view.classes.has('form-error'));
  assert.match(view.message.textContent, /Database copy saved on the server/);
});

test('failed proxy responses and interrupted downloads restore both controls without a download', async () => {
  for (const response of [new Response('Bad gateway', { status: 502 }), {
    ok: true, headers: new Headers({ 'content-disposition': `attachment; filename="${filename}"` }),
    blob: async () => { throw new Error('Connection interrupted.'); },
  }]) {
    const view = fixture(async () => response);
    await view.downloadButton.click();
    assert(view.classes.has('form-error'));
    assert(!view.saveButton.disabled);
    assert(!view.downloadButton.disabled);
    assert.equal(view.links.length, 0);
    assert.doesNotMatch(view.message.textContent, /Bad gateway|Unexpected token/);
  }
});

test('download rejects a missing or unsafe filename instead of silently losing the export timestamp', async () => {
  for (const disposition of ['', 'attachment; filename="../../other.sqlite"']) {
    const view = fixture(async () => new Response('', { headers: { 'content-disposition': disposition } }));
    await view.downloadButton.click();
    assert.match(view.message.textContent, /no valid filename/);
    assert(view.classes.has('form-error'));
    assert.equal(view.links.length, 0);
  }
});

test('export preparation remains indeterminate with elapsed time and clears its progress timer', async () => {
  let ready;
  const view = fixture(() => new Promise(resolve => { ready = resolve; }));
  const work = view.saveButton.click();
  assert.equal(view.progress.hidden, false);
  assert.equal(view.progress.hasAttribute('value'), false);
  assert.match(view.detail.textContent, /Elapsed.*Keep this page open/);
  assert.equal(view.intervals.size, 1);
  ready(Response.json({ filename, path })); await work;
  assert.equal(view.progress.hidden, true);
  assert.equal(view.intervals.size, 0);
});

test('streaming bytes use the response length without buffering a second database copy', async () => {
  let stream;
  const bytes = new TextEncoder().encode('test');
  const view = fixture(async () => new Response(new ReadableStream({ start(controller) { stream = controller; } }), {
    headers: { 'content-length': '8', 'content-disposition': `attachment; filename="${filename}"` },
  }));
  const work = view.downloadButton.click();
  await new Promise(resolve => setImmediate(resolve));
  stream.enqueue(bytes);
  await new Promise(resolve => setImmediate(resolve));
  for (const update of view.intervals.values()) update();
  assert.equal(view.progress.value, 4);
  assert.equal(view.progress.max, 8);
  assert.match(view.detail.textContent, /4 of 8 bytes/);
  stream.enqueue(bytes); stream.close(); await work;
  assert.equal(await view.blobs[0].text(), 'testtest');
  assert.equal(view.intervals.size, 0);
});

test('a lost server-save response reports uncertainty without claiming the copy failed', async () => {
  const view = fixture(async () => { throw new Error('Connection lost'); });
  await view.saveButton.click();
  assert.match(view.message.textContent, /not confirmed.*Check the export folder/);
  assert.equal(view.progress.hidden, true);
  assert.equal(view.intervals.size, 0);
});

test('a rejected download filename cancels the stream instead of leaving its transfer running', async () => {
  let cancelled = false;
  const view = fixture(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
    headers: { 'content-disposition': 'attachment; filename="../invalid.sqlite"' },
  }));
  await view.downloadButton.click();
  assert.equal(cancelled, true);
  assert.equal(view.links.length, 0);
  assert.equal(view.intervals.size, 0);
});
