const INPUTS = ['mqtt', 'providers', 'simulated', 'history'];

/** Evidence can disprove a source choice without proving household identity.
 * This runs in the recovery worker against its pinned read-only donor. Mixed
 * databases retain their declared input namespaces; no journal is translated. */
export function assessRecoverySource(donor, input) {
  const learning = donor.db.prepare(`SELECT
    COALESCE(SUM(input='mqtt'),0) mqtt, COALESCE(SUM(input='providers'),0) providers,
    COALESCE(SUM(input='simulated'),0) simulated, COALESCE(SUM(input='history'),0) history,
    COALESCE(SUM(input NOT IN ('mqtt','providers','simulated','history')),0) unknown
    FROM ${donor.recoveryJournal ?? 'learning_journal'}`).get();
  const observed = donor.db.prepare(`SELECT
    EXISTS(SELECT 1 FROM active_observations WHERE source='simulation'
      OR source='controller' AND device='simulated' LIMIT 1) simulated,
    EXISTS(SELECT 1 FROM active_observations WHERE source<>'simulation'
      AND NOT(source='controller' AND device='simulated') LIMIT 1) physical`).get();
  const simulated = Boolean(observed.simulated || learning.simulated);
  const physical = Boolean(observed.physical || learning.mqtt || learning.providers);
  const scope = simulated && physical ? 'mixed' : simulated ? 'simulated' : physical ? 'live' : 'unknown';
  if (scope === 'simulated' && ['mqtt', 'providers'].includes(input) || scope === 'live' && input === 'simulated')
    throw Object.assign(new Error('The backup contains a different simulation or live environment. Choose history for the current environment.'),
      { code: 'recovery_scope_mismatch' });
  const skippedLearning = Object.fromEntries(Object.entries(learning).filter(([source, count]) => source !== input && count > 0));
  return { scope, selectedInput: input, learningInputs: INPUTS.filter(source => learning[source] > 0),
    skippedLearning, skippedLearningRecords: Object.values(skippedLearning).reduce((sum, count) => sum + count, 0),
    installationIdentity: 'not-proven-by-format' };
}
