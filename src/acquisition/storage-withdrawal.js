const pending = new WeakMap();

/** Transport loss must take effect immediately, including while a transaction
 * awaits its worker COMMIT. Reapply that RAM-only withdrawal after settlement:
 * an earlier transaction's rollback snapshot cannot resurrect live authority.
 * Each owner keeps only its latest withdrawal and original observation clocks.
 */
export function retainStorageWithdrawal(store, owner, withdraw) {
  withdraw();
  if (!store.writePending || store.transactionDepth || !store.onWriteSettled) return;
  let held = pending.get(store);
  if (!held) {
    held = new Map();
    pending.set(store, held);
    const unsubscribe = store.onWriteSettled(() => {
      unsubscribe();
      pending.delete(store);
      const failures = [];
      for (const effect of held.values()) {
        try { effect(); } catch (error) { failures.push(error); }
      }
      held.clear();
      if (failures.length) throw new AggregateError(failures, 'Live availability withdrawal could not finish.');
    });
  }
  held.set(owner, withdraw);
}
