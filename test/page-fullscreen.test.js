import test from 'node:test';
import assert from 'node:assert/strict';
import { enterPageFullscreen, exitPageFullscreen } from '../chart/page-fullscreen.js';

function browser() {
  const pending = [];
  let exits = 0;
  const document = {
    fullscreenElement: null,
    documentElement: { requestFullscreen() {
      return new Promise(resolve => pending.push(() => {
        document.fullscreenElement = document.documentElement;
        resolve();
      }));
    } },
    async exitFullscreen() { exits++; document.fullscreenElement = null; },
  };
  return { document, pending, get exits() { return exits; } };
}

test('a chart closed during fullscreen permission does not leave the dashboard unexpectedly fullscreen', async () => {
  const page = browser();
  let open = true;
  const entry = enterPageFullscreen(page.document, () => open);
  open = false;
  page.pending[0]();
  await entry;
  assert.equal(page.document.fullscreenElement, null);
  assert.equal(page.exits, 1);
});

test('late chart cleanup cannot cancel a newer fullscreen request from the header', async () => {
  for (const order of [[0, 1], [1, 0]]) {
    const page = browser();
    let open = true;
    const chart = enterPageFullscreen(page.document, () => open);
    open = false;
    const header = enterPageFullscreen(page.document);
    for (const index of order) { page.pending[index](); await Promise.resolve(); }
    await Promise.all([chart, header]);
    assert.equal(page.document.fullscreenElement, page.document.documentElement);
    assert.equal(page.exits, 0);
    await exitPageFullscreen(page.document);
    assert.equal(page.document.fullscreenElement, null);
  }
});

test('a reopened chart keeps a late fullscreen entry', async () => {
  const page = browser();
  let open = true;
  const entry = enterPageFullscreen(page.document, () => open);
  open = false;
  open = true;
  page.pending[0]();
  await entry;
  assert.equal(page.document.fullscreenElement, page.document.documentElement);
  assert.equal(page.exits, 0);
});

test('an older chart entry cannot undo a completed header entry and exit', async () => {
  const page = browser();
  let open = true;
  const chart = enterPageFullscreen(page.document, () => open);
  open = false;
  const header = enterPageFullscreen(page.document);
  page.pending[1]();
  await header;
  await exitPageFullscreen(page.document);
  page.pending[0]();
  await chart;
  assert.equal(page.document.fullscreenElement, null);
});
