import { cycleAssessmentExcluded } from '../storage/cycle-assessment.js';

const finite = Number.isFinite;

/** Read frozen, attributable space-heating assessments. Each complete cycle is
 * assigned to its completion date, including recovery and any earlier start.
 * Rolling €/cycle observations cannot be summed into a selected-period total. */
export function getHeatingBenefit({ store, input = 'offline', range, now = Date.now() }) {
  const result = {
    status: 'unavailable', reason: 'no-elapsed-time', valueEuro: null, range, generatedAt: now,
    selectionBasis: 'cycles-completed-in-range',
    counts: { assessed: 0, completed: 0, unassessed: 0, incomplete: 0, active: 0, startedBeforeSelection: 0 },
    firstStartedAt: null, lastEndedAt: null, estimateRange: null,
    referenceCostEuro: null, actualSpaceHeatingCostEuro: null,
  };
  if (now <= range.from) return result;

  // Extract only compact assessment fields inside SQLite; observation tapes,
  // frozen models, credentials and device identifiers never enter the result.
  const row = store.db.prepare(`WITH selected AS (
    SELECT status, started_at, ended_at, ${cycleAssessmentExcluded('learning_cycles.id')} AS recoveryExcluded,
      CASE WHEN json_valid(payload) THEN payload ELSE '{}' END AS data
    FROM active_learning_cycles AS learning_cycles
    WHERE input=? AND started_at<=? AND started_at<?
      AND ((status IN ('completed','incomplete') AND ended_at>=? AND ended_at<? AND ended_at<=?)
        OR (status='active' AND ended_at IS NULL))
  ), assessments AS (
    SELECT *,
      json_extract(data,'$.assessment.profitCents') AS profit,
      json_extract(data,'$.assessment.uncertaintyCents') AS uncertainty,
      json_extract(data,'$.assessment.referenceCostCents') AS referenceCost,
      json_extract(data,'$.assessment.actualSpaceHeatingCostCents') AS actualCost,
      status='completed' AND ended_at>started_at
        AND json_extract(data,'$.assessment.basis')='estimated-space-heating-execution-and-reference'
        AND COALESCE(json_extract(data,'$.fireplaceCorrectionRevision'),0)=0
        AND NOT recoveryExcluded
        AND json_type(data,'$.assessment.profitCents') IN ('integer','real') AS assessed
    FROM selected
  ) SELECT
    COUNT(*) FILTER (WHERE status='completed') AS completed,
    COUNT(*) FILTER (WHERE status='incomplete') AS incomplete,
    COUNT(*) FILTER (WHERE status='active') AS active,
    COUNT(*) FILTER (WHERE assessed) AS assessed,
    COUNT(*) FILTER (WHERE assessed AND started_at<?) AS earlier,
    MIN(started_at) FILTER (WHERE assessed) AS firstStartedAt,
    MAX(ended_at) FILTER (WHERE assessed) AS lastEndedAt,
    SUM(profit) FILTER (WHERE assessed) AS profitCents,
    COUNT(*) FILTER (WHERE assessed AND json_type(data,'$.assessment.uncertaintyCents') IN ('integer','real') AND uncertainty>=0) AS uncertaintyCount,
    SUM(uncertainty) FILTER (WHERE assessed AND uncertainty>=0) AS uncertaintyCents,
    COUNT(*) FILTER (WHERE assessed AND json_type(data,'$.assessment.referenceCostCents') IN ('integer','real')) AS referenceCount,
    SUM(referenceCost) FILTER (WHERE assessed) AS referenceCents,
    COUNT(*) FILTER (WHERE assessed AND json_type(data,'$.assessment.actualSpaceHeatingCostCents') IN ('integer','real')) AS actualCount,
    SUM(actualCost) FILTER (WHERE assessed) AS actualCents
    FROM assessments`).get(input, now, range.to, range.from, range.to, now, range.from);

  result.counts = { assessed: row.assessed, completed: row.completed, unassessed: row.completed - row.assessed,
    incomplete: row.incomplete, active: row.active, startedBeforeSelection: row.earlier };
  result.reason = row.completed ? 'no-assessed-cycles' : 'no-completed-cycles';
  if (!row.assessed || !finite(row.profitCents)) return result;
  result.status = 'estimated'; result.reason = null; result.valueEuro = row.profitCents / 100;
  result.firstStartedAt = row.firstStartedAt; result.lastEndedAt = row.lastEndedAt;
  if (row.uncertaintyCount === row.assessed && finite(row.uncertaintyCents)) result.estimateRange = {
    lowerEuro: (row.profitCents - row.uncertaintyCents) / 100,
    upperEuro: (row.profitCents + row.uncertaintyCents) / 100,
  };
  if (row.referenceCount === row.assessed && finite(row.referenceCents)) result.referenceCostEuro = row.referenceCents / 100;
  if (row.actualCount === row.assessed && finite(row.actualCents)) result.actualSpaceHeatingCostEuro = row.actualCents / 100;
  return result;
}
