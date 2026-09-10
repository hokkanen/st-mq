import { fireplaceLearningContext } from '../app/fireplace-inputs.js';

/** A failed import may have accepted old manual source events already. Let the
 * normal background correction worker reconcile those against the still-active
 * journal; a failed peer must not permanently suspend ordinary corrections. */
export function markRecoveryFailed(store, input) {
  store.transaction(() => {
    const checkpoint = store.getState(`adaptive:${input}`);
    const revision = fireplaceLearningContext(store, input).fireplaceRevision;
    if (checkpoint && (checkpoint.fireplaceRevision ?? 0) !== revision)
      store.setState(`fireplace:rebuild:${input}`, { status: 'pending', revision,
        requiresRebuild: true, requestedAt: Date.now(), reason: 'accepted-recovery-source-events' });
    store.setState(`recovery:active:${input}`, { status: 'failed',
      error: 'Recovery remains protected; accepted history is valid and the previous model remains available.' });
  });
}
