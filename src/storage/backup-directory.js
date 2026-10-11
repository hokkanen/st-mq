import { dirname, resolve } from 'node:path';

/** Configuration owns retained copies; a missing current optional setting uses
 * the persistent database directory, never the service account's home. */
export function backupDirectory(config = {}) {
  return resolve(config.recording?.backupDirectory ?? resolve(config.databaseDir ?? dirname(config.dbPath ?? resolve('st-mq.sqlite')), 'backups'));
}
