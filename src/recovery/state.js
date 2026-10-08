import { fireplaceLearningContext } from '../app/fireplace-inputs.js';
import { sensorLearningContext, sensorRevision } from '../app/sensor-inputs.js';

/** A recovery projection is not selected until publication. Read its compact
 * corrections without switching the live journal view. */
export function projectedSensorContext(store, input, epoch) {
  return sensorLearningContext(store, input, Number.MAX_SAFE_INTEGER, { epoch });
}

/** A failed import may have accepted old manual source events already. Let the
 * normal background correction worker reconcile those against the still-active
 * journal; a failed peer must not permanently suspend ordinary corrections. */
export function markRecoveryFailed(store, input, { operationToken } = {}) {
  store.transaction(() => {
    if (operationToken !== undefined && store.getState(`recovery:active:${input}`)?.operationToken !== operationToken) return;
    store.db.prepare("UPDATE history_recoveries SET status='interrupted' WHERE input=? AND status IN ('importing','rebuilding')").run(input);
    const checkpoint = store.getState(`adaptive:${input}`);
    const revision = fireplaceLearningContext(store, input).fireplaceRevision;
    const correctedSensors = sensorRevision(store, input);
    if (checkpoint && ((checkpoint.fireplaceRevision ?? 0) !== revision || (checkpoint.sensorRevision ?? 0) !== correctedSensors))
      store.setState(`fireplace:rebuild:${input}`, { status: 'pending', revision,
        sensorRevision: correctedSensors, epoch: store.learningEpoch(input),
        requiresRebuild: true, requestedAt: Date.now(), reason: 'accepted-recovery-source-events' });
    store.setState(`recovery:active:${input}`, { status: 'failed',
      error: 'Recovery remains protected; accepted history is valid and the previous model remains available.' });
  });
}
