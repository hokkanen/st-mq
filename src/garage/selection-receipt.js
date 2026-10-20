/** A saved selection may also be an adopted device baseline. Only a committed
 * matching dashboard action establishes a receipt; neither grants live authority. */
export function garageSelectionReceipt(store, selection) {
  if (!selection) return null;
  const row = store.db.prepare("SELECT payload FROM active_events WHERE type='garage-mode-changed' AND at=? ORDER BY id DESC LIMIT 1")
    .get(selection.changedAt);
  if (!row) return null;
  const action = JSON.parse(row.payload);
  const targetC = selection.mode === 'away' ? selection.awayTargetC : selection.normalTargetC;
  if (action.mode !== selection.mode || action.targetC !== targetC || typeof action.commandId !== 'string') return null;
  return { at: selection.changedAt, mode: selection.mode, targetC, commandId: action.commandId };
}
