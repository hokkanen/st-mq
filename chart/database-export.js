import { lockControl, unlockControl } from './control-locks.js';
import { backgroundProgress, renderProgressBar } from './background-progress.js';

/** Both actions share one pending request; downloads stream when a picker is available. */
export function bindDatabaseExport({ saveButton, downloadButton, message, progress, detail, request, window, document, onSettled, now = Date.now }) {
  let pending = false;
  const owner = Symbol('database-export');
  async function run(method) {
    if (pending || (method === 'POST' ? saveButton : downloadButton).disabled) return;
    pending = true;
    lockControl(saveButton, owner); lockControl(downloadButton, owner);
    message.classList.remove('form-error');
    message.textContent = method === 'POST' ? 'Saving a database copy on the server…' : 'Preparing a database download…';
    let output, stream, received = null, total, lastRender = 0, requested = false, rejected = false;
    const startedAt = now();
    function updateProgress(force = false) {
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
      requested = true;
      const response = await request(method);
      if (!response.ok) {
        const result = await response.json().catch(() => null);
        rejected = !!result?.error;
        throw new Error(result?.error ?? 'Database export failed. Please try again.');
      }
      if (method === 'POST') {
        const result = await response.json();
        message.textContent = `Database copy saved on the server: ${result.path}`;
      } else {
        const contentLength = response.headers?.get('content-length');
        total = contentLength && /^\d+$/.test(contentLength) && Number.isSafeInteger(Number(contentLength)) ? Number(contentLength) : undefined;
        received = 0;
        message.textContent = 'Downloading the verified database copy…';
        updateProgress(true);
        // Streamed progress adds no second copy and preserves backpressure to the browser's file writer.
        stream = response.body?.pipeThrough ? response.body.pipeThrough(new TransformStream({ transform(chunk, controller) {
          received += chunk.byteLength; updateProgress(); controller.enqueue(chunk);
        } })) : response.body;
        if (handle) {
          output = await handle.createWritable();
          await stream.pipeTo(output);
          output = null;
          message.textContent = 'Database download saved.';
        } else {
          const filename = response.headers.get('content-disposition')?.match(/filename="(stmq-[\w.-]+\.sqlite)"/)?.[1];
          if (!filename) throw new Error('The database download has no valid filename. Please try again.');
          const blob = stream ? await new Response(stream).blob() : await response.blob();
          const url = window.URL.createObjectURL(blob);
          const link = document.createElement('a');
          try {
            link.href = url; link.download = filename;
            document.body.append(link); link.click();
          } finally {
            link.remove();
            window.setTimeout(() => window.URL.revokeObjectURL(url), 60_000);
          }
          message.textContent = `Download ready: ${filename}. Your browser chooses where to save it.`;
        }
      }
    } catch (error) {
      try { await stream?.cancel?.(); } catch {}
      try { await output?.abort(); } catch {}
      if (method === 'GET' && error.name === 'AbortError') message.textContent = 'Download cancelled.';
      else {
        message.classList.add('form-error');
        message.textContent = method === 'POST' && requested && !rejected
          ? 'Save result was not confirmed. Check the export folder before saving another copy.'
          : error.message || 'Database export failed. Please try again.';
      }
    } finally {
      pending = false;
      if (timer !== undefined) window.clearInterval(timer);
      if (progress) progress.hidden = true;
      if (detail) { detail.hidden = false; detail.textContent = backgroundProgress(null, { startedAt, finishedAt: now() }).timing; }
      unlockControl(saveButton, owner); unlockControl(downloadButton, owner);
      void onSettled?.();
    }
  }
  saveButton.addEventListener('click', () => run('POST'));
  downloadButton.addEventListener('click', () => run('GET'));
}
