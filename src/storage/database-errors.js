const guidance = {
  database_schema_mismatch: 'Use the same current application on both computers and deliberately start fresh development databases and pairing storage. In the paired dashboard, choose Reset pairing → Start fresh to archive the old storage. Earlier development databases are not migrated. See docs/pairing.md#fresh-development-databases.',
  database_schema_invalid: 'Restore an intact current-schema backup or deliberately start fresh development databases and pairing storage. In the paired dashboard, choose Reset pairing → Start fresh to archive the old storage. See docs/pairing.md#fresh-development-databases.',
};

/** Closed diagnostic fields only: exceptions can contain private paths and data. */
export function databaseErrorDetails(error) {
  if (typeof error?.code !== 'string' || !Object.hasOwn(guidance, error.code)) return null;
  const details = { code: error.code };
  for (const field of ['actualSchema', 'requiredSchema']) {
    const value = error[field];
    if (Number.isInteger(value) && value >= -2147483648 && value <= 2147483647) details[field] = value;
  }
  return details;
}

export function databaseErrorGuidance(error) {
  return databaseErrorDetails(error) ? guidance[error.code] : null;
}
