import { lockControl, unlockControl } from './control-locks.js';
import { backgroundProgress, renderProgressBar } from './background-progress.js';
import { ACTION_RECEIPT_MS } from './action-receipts.js';

const receiptDate = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', dateStyle: 'medium', timeStyle: 'short' });

/** Both actions share one pending request; downloads stream when a picker is available. */
export function bindDatabaseExport({ saveButton, downloadButton, message, progress, detail, request, window, document, onSettled, now = Date.now }) {
  let pending = false;
  let revision = 0, receiptAt = null, receiptTimer, operation;
  const owner = Symbol('database-export');
  function clearReceipt() {
    window.clearTimeout?.(receiptTimer); receiptTimer = undefined; receiptAt = null;
    message.textContent = ''; message.classList.remove('form-error');
    if (detail) { detail.textContent = ''; detail.hidden = true; }
  }
  function tick() {
    if (receiptAt !== null && now() - receiptAt >= ACTION_RECEIPT_MS) clearReceipt();
  }
  async function run(method) {
    if (pending || (method === 'POST' ? saveButton : downloadButton).disabled) return;
    const generation = ++revision;
    const controller = new AbortController(); operation = controller;
    const current = () => generation === revision;
    const setMessage = value => { if (current()) message.textContent = value; };
    clearReceipt();
    pending = true;
    lockControl(saveButton, owner); lockControl(downloadButton, owner);
    message.classList.remove('form-error');
    message.textContent = method === 'POST' ? 'Saving a database copy on the server…' : 'Preparing a database download…';
    let output, stream, received = null, total, lastRender = 0, requested = false, rejected = false;
    const startedAt = now();
    function updateProgress(force = false) {
      if (!current()) return;
      const at = now();
      if (!force && at - lastRender < 100) return;
      lastRender = at;
      const work = backgroundProgress({ processed: received, total, unit: 'bytes' }, { startedAt, now: at });
      if (progress) { progress.hidden = false; renderProgressBar(progress, work); }
      if (detail) {
        detail.hidden = false;
        detail.textContent = [work.work, work.timing, 'Keep this page open until the export finishes.'].filter(Boolean).join(' · ');
      }
    }
    updateProgress(true);
    const timer = window.setInterval?.(() => updateProgress(true), 1000);
    try {
      // Open the picker before any network await to retain the user gesture.
      const handle = method === 'GET' && window.showSaveFilePicker ? await window.showSaveFilePicker({
        suggestedName: `stmq-${new Date().toISOString().replaceAll(':', '-').replace('.', '-')}.sqlite`,
        types: [{ description: 'SQLite database', accept: { 'application/vnd.sqlite3': ['.sqlite'] } }],
      }) : null;
      if (!current()) return;
      requested = true;
      const response = await request(method, { signal: controller.signal });
      if (!current()) { try { await response.body?.cancel(); } catch {} return; }
      if (!response.ok) {
        const result = await response.json().catch(() => null);
        rejected = !!result?.error;
        throw new Error(result?.error ?? 'Database export failed. Please try again.');
      }
      if (method === 'POST') {
        const result = await response.json();
        setMessage(`Database copy saved on the server: ${result.filename}. See the backup folder above.`);
      } else {
        const contentLength = response.headers?.get('content-length');
        total = contentLength && /^\d+$/.test(contentLength) && Number.isSafeInteger(Number(contentLength)) ? Number(contentLength) : undefined;
        received = 0;
        setMessage('Downloading the verified database copy…');
        updateProgress(true);
        // Streamed progress adds no second copy and preserves backpressure to the browser's file writer.
        stream = response.body?.pipeThrough ? response.body.pipeThrough(new TransformStream({ transform(chunk, output) {
          received += chunk.byteLength; updateProgress(); output.enqueue(chunk);
        } }), { signal: controller.signal }) : response.body;
        if (handle) {
          output = await handle.createWritable();
          await stream.pipeTo(output, { signal: controller.signal });
          output = null;
          setMessage('Database download saved.');
        } else {
          const filename = response.headers.get('content-disposition')?.match(/filename="(stmq-[\w.-]+\.sqlite)"/)?.[1];
          if (!filename) throw new Error('The database download has no valid filename. Please try again.');
          const blob = stream ? await new Response(stream).blob() : await response.blob();
          if (!current()) return;
          const url = window.URL.createObjectURL(blob);
          const link = document.createElement('a');
          try {
            link.href = url; link.download = filename;
            document.body.append(link); link.click();
          } finally {
            link.remove();
            window.setTimeout(() => window.URL.revokeObjectURL(url), 60_000);
          }
          setMessage(`Download ready: ${filename}. Your browser chooses where to save it.`);
        }
      }
    } catch (error) {
      try { await stream?.cancel?.(); } catch {}
      try { await output?.abort(); } catch {}
      if (method === 'GET' && error.name === 'AbortError') setMessage('Download cancelled.');
      else if (current()) {
        message.classList.add('form-error');
        message.textContent = method === 'POST' && requested && !rejected
          ? 'Save result was not confirmed. Check the export folder before saving another copy.'
          : error.message || 'Database export failed. Please try again.';
      }
    } finally {
      pending = false;
      if (operation === controller) operation = undefined;
      if (timer !== undefined) window.clearInterval(timer);
      if (current()) {
        if (progress) progress.hidden = true;
        receiptAt = now();
        if (detail) { detail.hidden = false; detail.textContent = `${receiptDate.format(receiptAt)} · ${backgroundProgress(null, { startedAt, finishedAt: receiptAt }).timing}`; }
        receiptTimer = window.setTimeout?.(tick, ACTION_RECEIPT_MS);
      }
      unlockControl(saveButton, owner); unlockControl(downloadButton, owner);
      if (current()) void onSettled?.();
    }
  }
  saveButton.addEventListener('click', () => run('POST'));
  downloadButton.addEventListener('click', () => run('GET'));
  return { tick, clear() { revision++; operation?.abort(); clearReceipt(); if (progress) progress.hidden = true; } };
}
