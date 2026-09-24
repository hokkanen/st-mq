import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pipeline } from 'node:stream/promises';

/** The SQLite backup API includes committed WAL pages without pausing recording.
 * Keep one private snapshot per download, never expose a server filesystem path. */
export function createDatabaseExport() {
  let busy = false;
  return async ({ store, response, authorized }) => {
    if (busy) throw Object.assign(new Error('A database export is already in progress. Retry when it finishes.'), { statusCode: 409 });
    busy = true;
    let directory;
    try {
      directory = await mkdtemp(join(tmpdir(), 'stmq-export-'));
      const path = join(directory, 'history.sqlite');
      await store.backup(path);
      // Backup copies the source WAL header as well as its committed pages.
      // Finish this private copy in rollback-journal mode so even read-only
      // consumers can open the download without creating WAL/SHM companions.
      const snapshot = new DatabaseSync(path);
      try { snapshot.exec('PRAGMA journal_mode=DELETE'); } finally { snapshot.close(); }
      const { size } = await stat(path);
      if (response.destroyed || !authorized()) return;
      const name = `stmq-${new Date().toISOString().replaceAll(':', '-').slice(0, 19)}.sqlite`;
      response.writeHead(200, { 'content-type': 'application/vnd.sqlite3',
        'content-disposition': `attachment; filename="${name}"`,
        'content-length': size, 'cache-control': 'no-store' });
      await pipeline(createReadStream(path), response);
    } catch (error) {
      if (response.headersSent || response.destroyed) { response.destroy(); return; }
      throw Object.assign(new Error('Database export failed. Retry shortly.'), { statusCode: 503 });
    } finally {
      try { if (directory) await rm(directory, { recursive: true, force: true }); }
      finally { busy = false; }
    }
  };
}
