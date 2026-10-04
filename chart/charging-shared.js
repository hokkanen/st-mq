const priorityName = value => ({ balanced: 'Balanced', charger1: 'Charger 1', charger2: 'Charger 2' })[value] ?? 'Unknown';
const amount = value => Number.isFinite(value) ? Number(value.toFixed(3)).toString() : 'unknown';

export function chargingSharedSummary(shared) {
  const current = shared?.current ?? shared;
  const overlap = current?.overlap === 'observed' ? 'overlapping draw observed'
    : current?.overlap === 'unknown' ? 'overlap unconfirmed' : 'no overlap observed';
  const issue = [current?.priority, current?.execution?.state, current?.proposed?.state, current?.adopted?.state].includes('inconsistent');
  return `Both chargers · Priority ${priorityName(current?.selectedPriority)} · ${issue ? 'shared check needs attention' : overlap}`;
}

export function chargingSharedText(shared, focus) {
  const current = shared?.current ?? shared;
  if (!current) return 'Shared charging evidence is not yet available.';
  const peer = current.peers?.find(row => row.id !== focus);
  const peerName = peer?.id === 'charger1' ? 'Charger 1' : 'Charger 2';
  const peerText = peer?.connected === false ? `${peerName} is unplugged.` : peer?.drawing === true
    ? `${peerName} draw: ${amount(peer.powerKw)} kW.` : peer?.drawing === false ? `${peerName}: no draw measured.` : `${peerName} evidence is unavailable.`;
  const overlap = shared?.coverage?.overlap === 'observed' ? 'Overlapping draw was observed.'
    : current.overlap === 'unknown' ? 'Overlapping draw cannot currently be assessed.' : 'Overlapping draw has not been observed.';
  const consistency = current.priority === 'consistent' ? 'Both joint models use the selected priority.'
    : current.priority === 'inconsistent' ? 'The joint models do not both use the selected priority.'
      : current.priority === 'settling' ? 'The joint models are updating to the selected priority.'
      : current.priority === 'not-exercised' ? 'Priority sharing has not been exercised by two connected chargers.'
        : 'Priority handling is unconfirmed.';
  const models = [['Proposed', current.proposed], ['Adopted', current.adopted]].map(([name, model]) => {
    const state = ({ feasible: 'allocation covers both requests', shortfall: 'allocation has a readiness shortfall',
      inconsistent: 'allocation evidence is inconsistent', 'not-exercised': 'no connected request', unknown: 'joint evidence unavailable' })[model?.state] ?? 'joint evidence unavailable';
    return `${name} model: ${state}${Number.isFinite(model?.costCents) ? `; combined cost ${amount(model.costCents)} cents` : ''}.`;
  });
  const solver = current.proposed;
  const bounds = Number.isFinite(solver?.costLowerBoundCents) && Number.isFinite(solver?.costGapBoundCents)
    ? `Planner-reported cost lower bound ${amount(solver.costLowerBoundCents)} cents; gap bound ${amount(solver.costGapBoundCents)} cents.`
    : 'A joint cost bound is unavailable.';
  const execution = current.execution?.state;
  const readback = execution === 'consistent' ? 'Charger 2 current readback respects its active current ceiling.'
    : execution === 'inconsistent' ? 'Charger 2 current readback exceeds its active current ceiling.'
      : execution === 'settling' ? 'Charger 2 allocation change is settling.'
        : execution === 'not-exercised' ? 'Charger 2 current sharing has not been exercised.' : 'Charger 2 allocation readback is unconfirmed.';
  return [`Shared priority: ${priorityName(current.selectedPriority)}.`, peerText, overlap, consistency,
    ...(shared?.priorityChanges ? [`Observed priority changes: ${shared.priorityChanges}.`] : []), readback, ...models, bounds,
    'Allocation checks use reported limits and configured ceilings. Unknown current uses the maximum available within shared property capacity as a delivery estimate. Model checks do not confirm charger readiness, physical delivery or global optimality.'].join(' ');
}
