/** Selected recovery corrections can invalidate a derived benefit while its
 * frozen forecast and observed cycle remain historical evidence. Callers pass
 * a fixed SQL column expression, never request data. The exclusion lookup uses
 * the generation/table/key primary index and does not read observation tapes. */
export function cycleAssessmentExcluded(cycleId) {
  return `EXISTS(SELECT 1 FROM recovery_exclusions assessment_exclusion
    WHERE assessment_exclusion.generation=(SELECT generation FROM history_selection WHERE id=1)
      AND assessment_exclusion.table_name='cycle_assessments'
      AND assessment_exclusion.record_key=${cycleId})`;
}
