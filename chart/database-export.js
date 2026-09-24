/** Choose a destination before the request so supporting browsers retain the
 * user gesture. Other browsers use their normal download location/prompt. */
export function bindDatabaseExport({ button, message, request, window, document }) {
  button.addEventListener('click', async () => {
    if (button.disabled) return;
    button.disabled = true;
    let output;
    try {
      const suggestedName = `stmq-${new Date().toISOString().slice(0, 10)}.sqlite`;
      const handle = window.showSaveFilePicker ? await window.showSaveFilePicker({ suggestedName,
        types: [{ description: 'SQLite database', accept: { 'application/vnd.sqlite3': ['.sqlite'] } }] }) : null;
      message.textContent = 'Preparing a current database snapshot…';
      const response = await request();
      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.error ?? 'Database export failed.');
      }
      if (handle) {
        output = await handle.createWritable();
        await response.body.pipeTo(output);
        output = null;
        message.textContent = 'Database saved.';
      } else {
        const url = window.URL.createObjectURL(await response.blob());
        const link = document.createElement('a');
        link.href = url; link.download = suggestedName;
        document.body.append(link); link.click(); link.remove();
        window.setTimeout(() => window.URL.revokeObjectURL(url), 60_000);
        message.textContent = 'Download ready. Your browser chooses where to save it.';
      }
    } catch (error) {
      try { await output?.abort(); } catch {}
      message.textContent = error.name === 'AbortError' ? 'Export cancelled.' : error.message;
    } finally { button.disabled = false; }
  });
}
