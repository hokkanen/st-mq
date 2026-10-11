// Shared by the server and browser. A source inventory is not a merge assessment.
export const checkedRecoverySource = preview => preview?.status === 'checked'
  && preview.model?.status === 'not-assessed' && preview.counts === undefined
  && typeof preview.previewId === 'string' && /^[a-f0-9]{64}$/.test(preview.previewId);

const checkpoint = value => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === 3 && /^[a-f0-9-]{36}$/.test(value.databaseId)
  && Number.isSafeInteger(value.sequence) && value.sequence >= 0 && /^[a-f0-9]{64}$/.test(value.hash);
const zeroRows = rows => Array.isArray(rows) && rows.every(row => row?.count === 0);

/** A validated advancing source can contain deletions even with no retained rows. */
export function recoveryCheckpointChanged(preview) {
  if (!checkedRecoverySource(preview)) return false;
  const delta = preview.incremental;
  return Boolean(delta && typeof delta === 'object' && !Array.isArray(delta)
    && Object.keys(delta).every(key => ['base', 'checkpoint', 'records'].includes(key))
    && Number.isSafeInteger(delta.records) && delta.records >= 0
    && checkpoint(delta.base) && checkpoint(delta.checkpoint)
    && delta.base.databaseId === delta.checkpoint.databaseId && delta.checkpoint.sequence > delta.base.sequence
    && preview.donorDigest === delta.checkpoint.hash);
}

/** Only an unchanged, validated shared source proves there are no candidates.
 * Zero displayed category counts can hide excluded records or deletions. This
 * structural classification grants no authority; the server also validates the
 * saved preview digest, donor identity and actual checkpoint before release.
 */
export function emptyRecoverySource(preview) {
  if (!checkedRecoverySource(preview)) return false;
  const delta = preview.incremental;
  if (!delta || Object.keys(delta).some(key => !['base', 'checkpoint', 'records'].includes(key))
    || delta.records !== 0 || !checkpoint(delta.base) || !checkpoint(delta.checkpoint)
    || delta.base.databaseId !== delta.checkpoint.databaseId || delta.base.sequence !== delta.checkpoint.sequence
    || delta.base.hash !== delta.checkpoint.hash || preview.donorDigest !== delta.checkpoint.hash
    || !zeroRows(preview.tables) || !preview.tables.length) return false;
  if (preview.unsupported !== undefined && !zeroRows(preview.unsupported)) return false;
  if (preview.sourceSummary !== undefined && (!zeroRows(preview.sourceSummary?.categories)
    || !preview.sourceSummary.categories.length)) return false;
  return preview.sourceAssessment?.skippedLearningRecords === undefined
    || preview.sourceAssessment.skippedLearningRecords === 0;
}
