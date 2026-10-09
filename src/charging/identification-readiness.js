/** Current prerequisites for a controlled identification attempt. Returning a
 * cause keeps the command gate and its explanation on the same conditions. */
export function identificationControlBlocker({ supported, transitioning, closed, canControl, input, control, now }) {
  const snapshot = control?.snapshot;
  if (!supported) return 'unsupported';
  if (transitioning) return 'backend-changing';
  if (closed || !canControl || !['mqtt', 'providers'].includes(input)) return 'control-unavailable';
  if (snapshot?.online !== true) return 'charger-offline';
  if (!Number.isSafeInteger(snapshot.readAt) || !(snapshot.readAt <= now && now - snapshot.readAt <= 60_000))
    return 'charger-readback-stale';
  if (control.session?.connected !== true || snapshot.pluggedIn !== true || control.vehicleDisconnect?.awaitingConnection)
    return 'assignment-unresolved';
  if (snapshot.faulted || snapshot.connectorStatus === 'Faulted') return 'charger-fault';
  if (snapshot.authorizationBlocked) return 'charging-authorization';
  if (snapshot.enabled === false) return 'charger-disabled';
  if (['Unavailable', 'Reserved'].includes(snapshot.connectorStatus)) return 'connector-unavailable';
  if (snapshot.transport === 'shelly-evse' && snapshot.nativeScheduleActive) return 'native-schedule';
  if (control.manual || control.devicePermissionHeld !== true && (snapshot.manualStop || snapshot.stopped))
    return 'other-instruction';
  if (snapshot.transport === 'shelly-evse' && snapshot.identificationReady !== true) return 'charger-confirmation-pending';
  return null;
}

/** Bounded public explanations, shared by action errors and the disabled action.
 * A past attempt's result remains separate from these current prerequisites. */
export const IDENTIFICATION_BLOCKERS = {
  'assignment-unresolved': 'Waiting for a confirmed vehicle connection before identification can start.',
  'awaiting-stop-confirmation': 'The previous identification pause still needs confirmation before another test can start.',
  'current-test-restoration-pending': 'The previous identification current setting must be restored before another test can start.',
  unsupported: 'This connection supports live vehicle matching but cannot run a controlled identification test.',
  'backend-changing': 'Identification is held while the charger connection is being changed.',
  'control-unavailable': 'This instance cannot control the charger. Identification requires the active controller.',
  'charger-offline': 'The charger is offline. Waiting for its live connection before starting identification.',
  'charger-readback-stale': 'Waiting for a current charger readback before starting identification.',
  'charger-fault': 'The charger reports a fault. Resolve it in the charger controls before starting identification.',
  'charging-authorization': 'The charger requires authorization before an identification test can start.',
  'charger-disabled': 'Charging is disabled on the charger. Identification cannot enable it.',
  'connector-unavailable': 'The charger reports its connector unavailable or reserved. Identification cannot start in that state.',
  'native-schedule': 'The charger’s own schedule blocks this identification test. Review its instruction in Charging controls.',
  'other-instruction': 'Another charger instruction has priority. Review it in Charging controls before starting identification.',
  'charger-confirmation-pending': 'Waiting for the charger to confirm its current settings before starting identification.',
  'charger-unavailable': 'The charger is not currently ready for an identification test. Review its connection and instructions.',
  'vehicle-feed-stale': 'Waiting for a current vehicle report before starting identification.',
  'evidence-capacity': 'Vehicle observation history is incomplete. Another test cannot establish a reliable match for this connection.',
  'bmw-away': 'BMW last reported away. Waiting for home evidence or another vehicle’s matching reports.',
  'bmw-home-unknown': 'BMW location is unavailable. Waiting for usable home evidence before starting identification.',
  'bmw-not-plugged': 'Waiting for usable BMW plugged-in evidence before starting identification.',
};

export const identificationBlockerDetail = reason => Object.hasOwn(IDENTIFICATION_BLOCKERS, reason)
  ? IDENTIFICATION_BLOCKERS[reason] : 'Identification prerequisites are unavailable. Review the charger and vehicle connection status.';
