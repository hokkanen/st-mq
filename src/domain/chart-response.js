/** Both current response purposes expose pending assessment work explicitly.
 * A drawing may contain assessment-valued series without comparison cards. */
export function chartAssessmentPending(result) {
  const state = result.meta?.summaryOnly ? result.firewoodBenefit : result.meta?.firewoodOutcomes;
  return state?.preparing === true || state?.retryable === true;
}
