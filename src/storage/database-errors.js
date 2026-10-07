const guidance = {
  database_schema_mismatch: 'Use the same current application on both computers and deliberately start fresh development databases and pairing storage. In the paired dashboard, choose Reset pairing → Start fresh to archive the old storage. Earlier development databases are not migrated. See docs/pairing.md#fresh-development-databases.',
  database_schema_invalid: 'Restore an intact current-schema backup or deliberately start fresh development databases and pairing storage. In the paired dashboard, choose Reset pairing → Start fresh to archive the old storage. See docs/pairing.md#fresh-development-databases.',
  database_algorithm_mismatch: 'The saved learning history uses a different algorithm. Use matching application builds and supported history. Earlier development journals are not converted; preserve them before deliberately starting fresh. See docs/pairing.md#software-upgrades.',
  database_state_incompatible: 'Saved device or control state is unsupported or unreadable. Preserve the database and resolve any outstanding equipment restoration before choosing a compatible backup or a deliberate fresh start.',
  database_integrity_failed: 'The database failed an integrity check. Keep the original files intact and use a verified intact backup. Retrying or changing application versions does not repair damaged data.',
};

const stateErrors = new Set(['HEATING_CONTROL_STATE_UNREADABLE', 'H66_STATE_UNSUPPORTED', 'EXECUTOR_STATE_UNSUPPORTED',
  'ADAPTIVE_RECORDING_BUDGET_UNSUPPORTED', 'RECORDING_STORAGE_METRICS_UNSUPPORTED']);

/** Closed diagnostic fields only: exceptions can contain private paths and data. */
export function databaseErrorDetails(error) {
  let code = typeof error?.code === 'string' ? error.code : null;
  if (stateErrors.has(code)) code = 'database_state_incompatible';
  if (code === 'ERR_SQLITE_ERROR' && Number.isSafeInteger(error.errcode)
    && [11, 26].includes(error.errcode & 0xff)) code = 'database_integrity_failed';
  if (!Object.hasOwn(guidance, code)) return null;
  const details = { code };
  for (const field of ['actualSchema', 'requiredSchema']) {
    const value = error[field];
    if (Number.isInteger(value) && value >= -2147483648 && value <= 2147483647) details[field] = value;
  }
  return details;
}

export function databaseErrorGuidance(error) {
  const details = databaseErrorDetails(error);
  return details ? guidance[details.code] : null;
}
