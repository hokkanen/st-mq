import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { publishDatabaseFile } from '../storage/publication.js';

/** The SQLite backup API includes committed WAL pages without pausing recording.
 * Keep one private snapshot until its download or server-side publication ends. */
export function createDatabaseExport({ getDirectory, onBackupEvent = () => {} }) {
  let busy = false;
  return async ({ store, response, authorized, save = false }) => {
    if (busy) throw Object.assign(new Error('A database export is already in progress. Retry when it finishes.'), { statusCode: 409 });
    busy = true;
    let directory, publishedPath, saved = false, completed = false, bytes, backupPhase;
    const notify = (phase, extra = {}) => {
      backupPhase = phase;
      // Health reporting cannot turn a completed backup into a failed operation.
      try { onBackupEvent({ phase, kind: save ? 'saved-copy' : 'download', at: Date.now(), ...extra }, store); } catch {}
    };
    const fail = () => {
      if (response.headersSent || response.destroyed) { response.destroy(); return; }
      throw Object.assign(new Error('Database export failed. Retry shortly.'), { statusCode: 503 });
    };
    try {
      if (response.destroyed || !authorized()) return;
      notify('start');
      const destination = save ? resolve(getDirectory()) : tmpdir();
      if (save) await mkdir(destination, { recursive: true, mode: 0o700 });
      // Staging alongside the destination permits atomic, no-overwrite linking
      // even when the system temporary directory is on a different filesystem.
      directory = await mkdtemp(join(destination, '.stmq-export-'));
      const path = join(directory, 'history.sqlite');
      await store.backup(path);
      const { size } = await stat(path);
      bytes = size;
      if (response.destroyed || !authorized()) return;
      const stem = `stmq-${new Date().toISOString().replaceAll(':', '-').replace('.', '-')}`;
      let filename = `${stem}.sqlite`;
      if (save) {
        for (let collision = 1; ; collision++) {
          if (response.destroyed || !authorized()) return;
          const candidate = join(destination, filename);
          try { await publishDatabaseFile(path, candidate); publishedPath = candidate; break; }
          catch (error) {
            if (error.published) publishedPath = candidate;
            if (!['EEXIST', 'database_destination_occupied'].includes(error.code)) throw error;
            filename = `${stem}-${collision + 1}.sqlite`;
          }
        }
        await rm(directory, { recursive: true, force: true });
        directory = undefined;
        if (response.destroyed || !authorized()) return;
        saved = true;
        completed = true;
        return { filename, path: publishedPath };
      }
      response.writeHead(200, { 'content-type': 'application/vnd.sqlite3',
        'content-disposition': `attachment; filename="${filename}"`,
        'content-length': size, 'cache-control': 'no-store' });
      await pipeline(createReadStream(path), response);
      completed = true;
    } catch (error) {
      // pipeline also destroys the response for disk read errors. Only a known
      // aborted connection is cancellation; an I/O failure must remain visible.
      const cancelled = response.destroyed && ['ERR_STREAM_PREMATURE_CLOSE', 'ABORT_ERR', 'ECONNRESET'].includes(error?.code);
      notify(cancelled ? 'cancelled' : 'failed',
        { errorCode: typeof error?.code === 'string' && /^[a-z_0-9-]{1,80}$/i.test(error.code) ? error.code : 'backup_failed' });
      fail();
    } finally {
      try {
        try { if (publishedPath && !saved) await rm(publishedPath, { force: true }); }
        finally { if (directory) await rm(directory, { recursive: true, force: true }); }
      } catch {
        notify('failed', { errorCode: 'backup_cleanup_failed' });
        fail();
      } finally {
        if (backupPhase === 'start') notify(completed ? 'complete' : 'cancelled', completed ? { bytes } : {});
        busy = false;
      }
    }
  };
}
