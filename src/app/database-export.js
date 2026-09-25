import { chmod, link, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pipeline } from 'node:stream/promises';

/** The SQLite backup API includes committed WAL pages without pausing recording.
 * Keep one private snapshot until its download or server-side publication ends. */
export function createDatabaseExport({ getDirectory }) {
  let busy = false;
  return async ({ store, response, authorized, save = false }) => {
    if (busy) throw Object.assign(new Error('A database export is already in progress. Retry when it finishes.'), { statusCode: 409 });
    busy = true;
    let directory, publishedPath, saved = false;
    const fail = () => {
      if (response.headersSent || response.destroyed) { response.destroy(); return; }
      throw Object.assign(new Error('Database export failed. Retry shortly.'), { statusCode: 503 });
    };
    try {
      if (response.destroyed || !authorized()) return;
      const destination = save ? resolve(getDirectory()) : tmpdir();
      if (save) await mkdir(destination, { recursive: true, mode: 0o700 });
      // Staging alongside the destination permits atomic, no-overwrite linking
      // even when the system temporary directory is on a different filesystem.
      directory = await mkdtemp(join(destination, '.stmq-export-'));
      const path = join(directory, 'history.sqlite');
      await store.backup(path);
      await chmod(path, 0o600);
      // Backup copies the source WAL header as well as its committed pages.
      // Finish this private copy in rollback-journal mode so even read-only
      // consumers can open the download without creating WAL/SHM companions.
      const snapshot = new DatabaseSync(path);
      try { snapshot.exec('PRAGMA journal_mode=DELETE'); } finally { snapshot.close(); }
      const { size } = await stat(path);
      if (response.destroyed || !authorized()) return;
      const stem = `stmq-${new Date().toISOString().replaceAll(':', '-').replace('.', '-')}`;
      let filename = `${stem}.sqlite`;
      if (save) {
        for (let collision = 1; ; collision++) {
          if (response.destroyed || !authorized()) return;
          const candidate = join(destination, filename);
          try { await link(path, candidate); publishedPath = candidate; break; }
          catch (error) {
            if (error.code !== 'EEXIST') throw error;
            filename = `${stem}-${collision + 1}.sqlite`;
          }
        }
        await rm(directory, { recursive: true, force: true });
        directory = undefined;
        if (response.destroyed || !authorized()) return;
        saved = true;
        return { filename, path: publishedPath };
      }
      response.writeHead(200, { 'content-type': 'application/vnd.sqlite3',
        'content-disposition': `attachment; filename="${filename}"`,
        'content-length': size, 'cache-control': 'no-store' });
      await pipeline(createReadStream(path), response);
    } catch {
      fail();
    } finally {
      try {
        try { if (publishedPath && !saved) await rm(publishedPath, { force: true }); }
        finally { if (directory) await rm(directory, { recursive: true, force: true }); }
      } catch { fail(); }
      finally { busy = false; }
    }
  };
}
