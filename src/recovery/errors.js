import { databaseErrorDetails } from '../storage/database-errors.js';

const messages = Object.freeze({
  recovery_state_invalid: 'Saved recovery state is invalid. Preserve this database and use a fresh current database.',
  recovery_active_required: 'Open history recovery on the active recording computer. This computer cannot write to the current database.',
  recovery_busy: 'A history or paired-computer operation is already running. Wait for it to finish, then reload results.',
  recovery_backups_unavailable: 'Saved backups could not be listed. Check the export folder and access permissions, then reload results.',
  recovery_storage_not_ready: 'Recovery working storage is unavailable. Check this computer’s storage and access permissions before retrying.',
  recovery_stopped: 'The recovery service has stopped. Reopen history recovery on the active recording computer after startup completes.',
  recovery_authority_changed: 'This computer’s permission to recover history changed. Reload results on the active recording computer before continuing.',
  recovery_action_invalid: 'Choose a recovery action with a unique request ID.',
  recovery_verification_invalid: 'Choose whether to verify with a full snapshot.',
  recovery_fields_invalid: 'Unsupported recovery action fields.',
  recovery_request_conflict: 'This request conflicts with an earlier recovery action. Reload results and review the source again.',
  recovery_peer_unavailable: 'Paired recovery is unavailable.',
  recovery_installation_unconfirmed: 'Confirm that this backup contains history from this household before checking it.',
  recovery_source_missing: 'Choose an available saved or uploaded backup.',
  recovery_review_required: 'Review this backup and confirm recovery first.',
  recovery_peer_required: 'Use the paired source to retain its protection checks.',
  recovery_checked_source_missing: 'The checked backup is unavailable. Select an available source and check again.',
  recovery_review_changed: 'The checked recovery changed. Review it again.',
  recovery_operation_required: 'Select an existing recovery operation.',
  recovery_revision_review_required: 'Review the recovery impact and confirm this change first.',
  recovery_upload_type: 'Upload a self-contained SQLite backup file.',
  recovery_upload_too_large: 'This backup exceeds the 8 GiB upload limit.',
  recovery_upload_authority_changed: 'Upload permission changed before the backup was registered. Sign in on the active recording computer and reload results before uploading again.',
  recovery_upload_timed_out: 'The backup upload exceeded its time limit. Reload results, then use a smaller backup or a faster connection before uploading again.',
  recovery_upload_interrupted: 'The backup upload was interrupted before registration. Reload results on the active recording computer before uploading again.',
  recovery_upload_storage_failed: 'The backup upload could not be stored.',
  recovery_upload_not_database: 'This file is not a SQLite database.',
  recovery_upload_not_snapshot: 'Use a self-contained SQLite backup created by Export database or a reset archive.',
  recovery_request_invalid: 'The recovery request must contain valid supported input.',
  recovery_request_unconfirmed: 'The recovery request could not be confirmed. Reload results to check its outcome.',
  recovery_database_busy: 'Recovery could not obtain a database lock. Wait for the current database work to finish, then check again before retrying.',
  recovery_storage_full: 'Recovery ran out of storage space. Free space on this computer, then check again before retrying.',
  recovery_database_constraint: 'Recovery could not save a record because a database consistency constraint failed. Keep both databases intact for investigation before retrying.',
  recovery_database_corrupt: 'Recovery found an unreadable or damaged database. Keep the existing files intact and inspect them or restore an intact current-schema backup.',
  recovery_storage_failed: 'Recovery encountered a storage read or write failure. Check this computer’s storage and filesystem permissions before checking again.',
  recovery_storage_unavailable: 'Recovery could not open a required file. Check that its source and working storage are still available, then check again.',
  recovery_invalid: 'The checked recovery inputs are no longer valid. Check the history again before retrying.',
  recovery_worker_failed: 'The recovery worker stopped before completion. The previous model remains selected. Check again before retrying.',
  recovery_failed: 'Recovery could not finish. Keep both databases intact and check again before retrying.',
  recovery_scope_mismatch: 'This backup belongs to a different simulation or live environment. Choose history for the current environment.',
  recovery_source_not_snapshot: 'This source is a working database, not a self-contained backup. Use Export database on its computer, then check the saved copy. Keep the original database and its companion files together.',
  recovery_other_input: 'This recovery affects saved learning in another input. Keep it active or use a separate database for that input.',
  database_schema_mismatch: 'The database schema does not match this application. Use an intact current-schema backup or deliberately start with a fresh database.',
  database_schema_invalid: 'The database structure does not match its declared schema. Use an intact current-schema backup or deliberately start with a fresh database.',
  database_algorithm_mismatch: 'This database uses a different learning algorithm. Its history is preserved. Use matching software to inspect it; recovery requires a supported database for this version.',
  database_state_incompatible: 'This database contains saved application state that this version cannot safely use. Its history is preserved. Use matching software to inspect it before choosing a supported recovery path.',
  database_journal_invalid: 'The transaction journal or checkpoint could not be verified. Preserve the database and run full verification or choose an intact current-format backup.',
  database_integrity_failed: 'This database failed its integrity checks and cannot be used safely. Keep its files intact and check storage or choose an intact verified backup.',
});

export const RECOVERY_ERROR_CODES = Object.freeze(Object.keys(messages));
export const recoveryErrorMessage = code => Object.hasOwn(messages, code) ? messages[code] : null;

const sqliteCodes = new Map([[5, 'recovery_database_busy'], [6, 'recovery_database_busy'],
  [8, 'recovery_storage_failed'], [10, 'recovery_storage_failed'],
  [11, 'recovery_database_corrupt'], [13, 'recovery_storage_full'],
  [14, 'recovery_storage_unavailable'], [19, 'recovery_database_constraint'],
  [26, 'recovery_database_corrupt']]);
const filesystemCodes = new Map([['ENOSPC', 'recovery_storage_full'], ['EDQUOT', 'recovery_storage_full'],
  ['EACCES', 'recovery_storage_failed'], ['EPERM', 'recovery_storage_failed'],
  ['EROFS', 'recovery_storage_failed'], ['EIO', 'recovery_storage_failed'],
  ['ENOTDIR', 'recovery_storage_not_ready'], ['EISDIR', 'recovery_storage_not_ready'],
  ['ENOENT', 'recovery_storage_unavailable'], ['RECOVERY_INVALID', 'recovery_invalid']]);

/** Error text may contain SQL values or private paths. Classify only stable
 * machine codes; never infer a cause from, or publish, a native error message. */
export function recoveryFailure(error, fallback = 'recovery_failed') {
  let code = Object.hasOwn(messages, error?.code) ? error.code : null;
  if (!code && error?.code === 'ERR_SQLITE_ERROR' && Number.isSafeInteger(error.errcode)) {
    // Extended SQLite results retain their primary result in the low byte.
    code = sqliteCodes.get(error.errcode & 0xff);
  }
  if (!code) code = filesystemCodes.get(error?.code);
  if (!code) code = databaseErrorDetails(error)?.code;
  code ??= Object.hasOwn(messages, fallback) ? fallback : 'recovery_failed';
  // These messages are authored by the recovery workers, never SQLite or the
  // filesystem. Keep their specific review instructions in the history API.
  return { code, error: error?.code === 'RECOVERY_INVALID' || error?.public === true
    ? error.message : messages[code] };
}
