import { lockControl, unlockControl } from './control-locks.js';

/** Both actions share one pending request; downloads stream when a picker is available. */
export function bindDatabaseExport({ saveButton, downloadButton, message, request, window, document, onSettled }) {
  let pending = false;
  const owner = Symbol('database-export');
  async function run(method) {
    if (pending || (method === 'POST' ? saveButton : downloadButton).disabled) return;
    pending = true;
    lockControl(saveButton, owner); lockControl(downloadButton, owner);
    message.classList.remove('form-error');
    message.textContent = method === 'POST' ? 'Saving a database copy on the server…' : 'Preparing a database download…';
    let output;
    try {
      // Open the picker before any network await to retain the user gesture.
      const handle = method === 'GET' && window.showSaveFilePicker ? await window.showSaveFilePicker({
        suggestedName: `stmq-${new Date().toISOString().replaceAll(':', '-').replace('.', '-')}.sqlite`,
        types: [{ description: 'SQLite database', accept: { 'application/vnd.sqlite3': ['.sqlite'] } }],
      }) : null;
      const response = await request(method);
      if (!response.ok) {
        const result = await response.json().catch(() => null);
        throw new Error(result?.error ?? 'Database export failed. Please try again.');
      }
      if (method === 'POST') {
        const result = await response.json();
        message.textContent = `Database copy saved on the server: ${result.path}`;
      } else if (handle) {
        output = await handle.createWritable();
        await response.body.pipeTo(output);
        output = null;
        message.textContent = 'Database download saved.';
      } else {
        const filename = response.headers.get('content-disposition')?.match(/filename="(stmq-[\w.-]+\.sqlite)"/)?.[1];
        if (!filename) throw new Error('The database download has no valid filename. Please try again.');
        const url = window.URL.createObjectURL(await response.blob());
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
    } catch (error) {
      try { await output?.abort(); } catch {}
      if (error.name === 'AbortError') message.textContent = 'Download cancelled.';
      else {
        message.classList.add('form-error');
        message.textContent = error.message || 'Database export failed. Please try again.';
      }
    } finally {
      pending = false;
      unlockControl(saveButton, owner); unlockControl(downloadButton, owner);
      void onSettled?.();
    }
  }
  saveButton.addEventListener('click', () => run('POST'));
  downloadButton.addEventListener('click', () => run('GET'));
}
