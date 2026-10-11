export const CHARGING_CONTROL_CAUSES = {
  disconnected: 'No vehicle connected', unavailable: 'Charger status unavailable',
  'read-failed': 'Charger read failed', 'command-failed': 'Charger instruction unconfirmed',
  'readback-failed': 'Charger confirmation could not be read', 'readback-mismatch': 'Charger readback did not match the instruction',
  'access-denied': 'Charger access denied', 'control-revoked': 'Control permission was withdrawn',
  'state-changed': 'Charger state changed during the instruction', 'unsupported-schedule': 'Charger schedule cannot be replaced',
  'invalid-plan': 'Charging plan could not be applied', 'missing-current-limit': 'Charging current limit unavailable',
  'start-passed': 'Requested start had already passed', 'ambiguous-start': 'Requested start time was ambiguous',
  'start-out-of-range': 'Requested start time was outside the supported range', 'charger-fault': 'Charger reported a fault',
  ['charging-authorization']: 'Charging authorization required', 'incomplete-state': 'Charger state incomplete',
  'charger-stopped': 'Charger reported stopped', 'pause-unconfirmed': 'Pause not confirmed',
  offline: 'Charger offline', 'provider-offline': 'Charger provider offline',
  'transaction-unconfirmed': 'Charging transaction not confirmed', 'composite-unavailable': 'Charger schedule readback unavailable',
  'charging-plan-unavailable': 'Waiting for a charging plan', 'takeover-unavailable': 'Waiting for automatic control',
  'status-stale': 'Waiting for current connection status',
  'takeover-stale': 'Charger instructions changed before automatic handover',
  'takeover-unconfirmed': 'Automatic handover unconfirmed', 'resume-current-limit': 'Separate charger current limit prevents handover',
  'ocpp-request-timeout': 'Local charger command timed out', 'ocpp-request-aborted': 'Local charger command cancelled',
  'ocpp-request-failed': 'Local charger returned a protocol error', 'ocpp-request-revoked': 'Local charger command permission withdrawn',
  'ocpp-disconnected': 'Local charger disconnected before confirmation', 'ocpp-reconfigured': 'Local charger connection reconfigured',
  'ocpp-unavailable': 'Local charger connection unavailable', 'ocpp-queue-full': 'Local charger command queue full',
  'takeover-pause-prepare': 'Handover step: preparing the planned pause',
  'takeover-pause-install': 'Handover step: installing the planned pause',
  'takeover-pause-confirm': 'Handover step: confirming the planned pause',
  'takeover-native-check': 'Handover step: checking the current charger instructions',
  'takeover-native-handover': 'Handover step: replacing the previous charger instructions',
  'takeover-native-confirm': 'Handover step: confirming the previous instructions were cleared',
  'takeover-state-save': 'Handover step: saving confirmed ownership',
  'profile-rejected': 'Charger rejected the charging profile', 'retry-limit': 'Instruction retry limit reached',
  'storage-failed': 'Control state could not be saved', 'evse-control-unavailable': 'Charger control unavailable',
  'evse-command-revoked': 'Charger instruction permission withdrawn', 'evse-command-unconfirmed': 'Charger instruction unconfirmed',
  'evse-publish-unconfirmed': 'Instruction delivery unconfirmed', 'evse-rpc-rejected': 'Charger rejected the instruction',
  'evse-read-timeout': 'Charger reading timed out',
  'evse-offline': 'Charger connection unavailable', 'evse-input-persistence-pending': 'Waiting for charger readings to be saved',
  'evse-source-time-pending': 'Waiting for the charger report time', 'evse-source-clock-unavailable': 'Charger report time invalid',
  'evse-recording-unavailable': 'Charger readings could not be saved',
  'evse-subscription-overflow': 'Charger report backlog exceeded', 'evse-request-limit': 'Charger request queue full',
  'charging-stream-save-unavailable': 'Charging evidence could not be saved',
  'charging-backend-transition-blocked': 'Charger connection change blocked',
  'charging-backend-transition': 'Charger connection change pending',
  'connection-changed': 'Charging connection changed', 'control-unavailable': 'Charging control unavailable',
  'evse-work-state-unavailable': 'Charger connection state unavailable', 'evse-current-control-unavailable': 'Current limiter unavailable', 'evse-profile-unsupported': 'Charger profile unsupported', 'evse-read-unavailable': 'Charger read unavailable',
  'evse-native-restriction': 'A charger restriction has priority', 'evse-native-schedule-unavailable': 'Charger timer unavailable',
  'evse-event-overflow': 'Charger event buffer exceeded', 'evse-component-mapping-unverified': 'Charger component mapping unverified',
  'evse-notification-readback-required': 'Confirming a charger change',
  'evse-permission-event-overflow': 'Charger instruction history incomplete',
  'identification-resume-required': 'Identification release still requires confirmation', 'command-unconfirmed': 'Charger instruction unconfirmed',
  'control-error': 'Charger control error; detailed cause unavailable',
  'manual-stop': 'Stop instruction active', 'manual-release': 'Charging release active', 'native-schedule': 'Charger schedule active',
  'device-permission-held': 'Waiting for charger permission',
  'manual-enable': 'Other charging instruction has priority', 'manual-charge-now': 'Immediate charging instruction has priority', 'manual-schedule': 'Charger schedule has priority',
  'native-current-limit': 'Charger current choice', 'vehicle-current-limit': 'Vehicle current limit', 'hardware-restriction': 'Hardware current limit',
  'fuse-limit': 'Installation current limit', 'priority-allocation': 'Shared charging allocation', 'telemetry-fallback': 'Current fallback for missing measurements',
  'vehicle-not-before': 'Vehicle start restriction', 'identification-pause': 'Identification pause',
  'identification-waiting': 'Identification waiting', 'identification-charging': 'Identification observing charge',
  'economic-wait': 'Waiting for a planned charging period', 'charge-now': 'Charge now requested',
  'economic-window': 'Within a planned charging period', 'no-headroom': 'No electrical headroom available',
  'supply-unavailable': 'Supply information unavailable', 'within-limit': 'Within the available current limit',
};

/** An unplugged, idle charger has no session permission to confirm. Outstanding
 * instructions and restoration still need confirmation, even after unplugging. */
export function chargingConfirmationMissing(charger) {
  const control = charger.control ?? {}, connection = charger.values?.connected;
  if (control.confirmed !== false) return false;
  const currentTests = [control.currentTest, charger.identification?.currentTest];
  const idle = connection?.value === false && connection.available !== false && control.phase === 'off'
    && control.snapshot?.online !== false && !charger.error && !control.errorCode
    && !control.pending && !control.owned && !control.ownedPause && !control.execution
    && control.handoverConfirmed !== false && !['pending', 'blocked'].includes(control.takeover?.state)
    && !['unknown', 'takeover-unconfirmed'].includes((control.manual ?? control.manualOverride)?.kind)
    && !charger.identification?.active && !charger.identification?.pauseOutstanding
    && !currentTests.some(test => ['proposed', 'applying', 'active', 'restoring', 'uncertain'].includes(test?.phase));
  return !idle;
}

export const chargingRecordedDetail = charger => charger.readOnly === true && charger.recorded === true
  ? 'Recorded master status; live charger health is unavailable on this read-only computer. Check current status and use controls on the controlling computer.' : '';

/** Waiting for vehicle evidence does not suspend ordinary price scheduling. */
export const chargingIdentificationInProgress = charger => charger.identification?.active === true
  && (charger.identification.phase !== 'waiting' || charger.identification.probe?.endedAt === null
    || ['proposed', 'applying', 'active'].includes(charger.identification.currentTest?.phase));

/** An OCPP transaction is needed to apply a profile, not to display a plan. */
export const chargingTransactionWaiting = charger => charger.control?.errorCode === 'transaction-unconfirmed'
  && charger.control?.snapshot?.transport === 'ocpp' && charger.values?.connected?.value === true
  && charger.plan?.periods?.some(period => Number.isFinite(period.startAt)) === true
  && !charger.control.manual && !['pending', 'blocked'].includes(charger.control.takeover?.state);

/** A controller-held pause and a native expiring pause have different release evidence. */
export function chargingPauseConfirmedForPeriod(control, period) {
  const currentAdjustmentOnly = control.scheduleConfirmed === true && control.currentAdjustment?.pending === true;
  if (control.nativeExpiry === false) return (control.phase === 'waiting' || currentAdjustmentOnly)
    && control.ownsInstruction === true && control.pauseConfirmed === true
    && (!control.pending || currentAdjustmentOnly) && !control.manual
    && control.execution?.periods?.some(row => Number(row.startAt) === Number(period.startAt)) === true;
  return control.phase === 'paused' && control.pauseConfirmed !== false && control.ownsInstruction !== false
    && Number(control.owned?.startAt) === Number(period.startAt);
}

const CONTROL_DETAILS = {
  disconnected: 'The charger reports that no vehicle is plugged in. Its communication connection is separate; charging can be planned when a vehicle connects.',
  unavailable: 'Current charger status is unavailable. Check the charger connection and native controls before requesting charging.',
  offline: 'The charger connection is unavailable. New instructions cannot be confirmed. Check its power and connection; the outcome of earlier instructions remains separate.',
  'provider-offline': 'The charger provider is unavailable. New instructions cannot be confirmed. Check the provider connection in Charging setup.',
  'ocpp-disconnected': 'The local charger connection was lost before confirmation. Earlier instructions may still be active; check the local connection in Charging setup and the charger’s actual state before retrying.',
  'ocpp-unavailable': 'The local charger connection is unavailable. Automatic control is waiting for it to return; check the connection in Charging setup.',
  'read-failed': 'Current charger readings could not be obtained. Waiting for fresh readings before confirming control; check the charger connection in Charging setup.',
  'command-failed': 'The charger instruction could not be confirmed. It may still have taken effect; check the charger’s actual state before retrying.',
  'readback-failed': 'The instruction could not be checked against fresh charger settings. Its outcome is unknown; review the charger’s actual state before retrying.',
  'readback-mismatch': 'The charger setting does not match the requested instruction. Review its actual settings and any later native instructions before retrying.',
  'charger-fault': 'The charger reports a fault. Check its native fault information and resolve it before requesting charging.',
  ['charging-authorization']: 'The charger requires authorization before charging. Check authorization in the charger’s native controls.',
  'incomplete-state': 'The charger has not supplied enough current state to confirm control. Waiting for fresh readings; check the connection in Charging setup.',
  'control-error': 'Charging control encountered a problem whose cause is unavailable. Check the charger connection and actual settings before retrying.',
  'ocpp-request-timeout': 'The local charger request did not finish before its timeout. Check the charger’s actual state before retrying; an instruction already sent may still take effect.',
  'ocpp-request-aborted': 'The local charger request was cancelled. Cancellation does not undo an instruction already sent; check the charger’s actual state before retrying.',
  'ocpp-request-failed': 'The local charger returned a protocol error. The requested change is not confirmed; check its native controls and connection in Charging setup.',
  'ocpp-request-revoked': 'Permission for this local charger request was withdrawn. Check the controlling computer and current charger state before requesting another change.',
  'ocpp-reconfigured': 'The local charger connection changed before the request could be confirmed. Review the current connection and actual charger settings before retrying.',
  'ocpp-queue-full': 'The local charger has too many queued requests. This request could not proceed; wait for earlier requests to settle before retrying.',
  'charger-stopped': 'The charger reports stopped or disabled. Review its native controls and current instructions; the Automatic switch alone does not supersede a Stop.',
  'evse-work-state-unavailable': 'A usable vehicle connection state is unavailable from the charger. New instructions wait for fresh readings; check the local connection in Charging setup.',
  'evse-current-control-unavailable': 'The charger’s adjustable current setting is unavailable. Check its supported capabilities and current-setting readback in Charging setup.',
  'evse-profile-unsupported': 'The reported charger profile is unsupported. Automatic control is blocked; review the integration requirements in Charging setup.',
  'evse-read-unavailable': 'Usable charger readback is unavailable. New instructions wait for fresh saved readings; check the charger connection and Recording & storage.',
  'evse-native-restriction': 'A native charger restriction has priority. Review the charger’s actual settings and restriction before requesting automatic control.',
  'evse-native-schedule-unavailable': 'The charger’s native timer state could not be read. Automatic takeover waits for it to be confirmed; review the timer in the native charger controls.',
  'evse-event-overflow': 'Too many charger changes arrived to preserve their order. Current instructions cannot be confirmed; check the native charger state and wait for fresh readback.',
  'evse-component-mapping-unverified': 'The charger’s control components have not been verified. Automatic control is blocked; review the supported profile and commissioning in Charging setup.',
  'evse-offline': 'The local MQTT charger connection is unavailable. New instructions cannot be confirmed; check its connection in MQTT and Charging setup.',
  'evse-input-persistence-pending': 'Received charger readings are waiting to be saved. New instructions wait for that evidence; check Recording & storage if the wait continues.',
  'evse-source-time-pending': 'A charger report is slightly ahead of the controller clock. New instructions wait until its time can be used; check the device and controller clocks if the wait continues.',
  'evse-source-clock-unavailable': 'The charger report time cannot be used. New instructions wait for valid evidence; check the device and controller clocks.',
  'evse-recording-unavailable': 'Charger readings could not be saved, so new instructions are blocked. Check Recording & storage; fresh saved evidence is needed before control can resume.',
  'evse-subscription-overflow': 'Too many charger reports arrived while MQTT subscriptions were being confirmed. Current state is incomplete and new instructions are blocked; check the MQTT connection and wait for fresh charger readings.',
  'evse-request-limit': 'The charger already has too many requests awaiting replies. Wait for them to settle and check the actual charger state before retrying.',
  'charging-stream-save-unavailable': 'Charging evidence could not be saved. Recorded charging history may be incomplete; check Recording & storage before relying on its totals.',
  'charging-backend-transition-blocked': 'The previous charger connection could not be reconciled for the change. Check its actual settings and any pending recovery before changing the connection.',
  'charging-backend-transition': 'The charger connection is being changed. Control is waiting for the previous connection’s instructions to be reconciled.',
  'connection-changed': 'The charging connection changed. Refresh to review its current plan before applying this action.',
  'control-unavailable': 'Charging control is unavailable for this connection. Check the charger status and connection in Charging setup before applying this action.',
  'charging-plan-unavailable': 'Automatic control is waiting for a charging plan. Existing charger restrictions remain in place.',
  'takeover-unavailable': 'Automatic control is waiting for fresh charger readings and control access. Existing restrictions remain in place.',
  'status-stale': 'The charger connection report is older than the current session. Waiting for an updated report; the current charging instructions remain in effect.',
  'unsupported-schedule': 'Automatic control cannot replace this type of charger schedule. Change it in the charger controls before returning to automatic charging.',
  'manual-stop': 'A stop instruction is preventing automatic scheduling.',
  'device-permission-held': 'The charger withdrew charging permission. Waiting for it to restore permission; no replacement Start is sent.',
  'native-schedule': 'The charger’s own schedule has priority over automatic scheduling.',
  'manual-schedule': 'A charger schedule has priority over automatic charging.',
  'manual-enable': 'Another charging instruction has priority over automatic scheduling.',
  'manual-charge-now': 'An immediate charging instruction has priority over automatic scheduling.',
  'manual-release': 'A charging release has priority over automatic scheduling.',
  'vehicle-not-before': 'The vehicle has a later charging start time. Charging must wait until the vehicle allows it.',
  'telemetry-fallback': 'The current allowance uses the configured fallback while usable load measurements are unavailable. Charger-setting confirmation is separate. Check the load feeds; this fallback is not a guarantee of fuse protection.',
  'fuse-limit': 'The current allowance is limited by the estimated spare capacity of the installation. Charger-setting confirmation and actual draw are separate.',
  'priority-allocation': 'The available charging current is shared according to the selected charger priority.',
  'native-current-limit': 'A current choice on the charger applies for this connection.',
  'vehicle-current-limit': 'The vehicle’s current limit applies.',
  'hardware-restriction': 'The configured hardware current limit applies.',
  'identification-pause': 'Charging is briefly paused to identify the connected vehicle.',
  'identification-waiting': 'Waiting for charging evidence to identify the connected vehicle.',
  'identification-charging': 'Charging is being observed to identify the connected vehicle.',
  'economic-wait': 'Waiting for the next planned charging period.',
  'charge-now': 'Immediate charging is requested for this connection. Charger and vehicle restrictions still apply.',
  'evse-command-unconfirmed': 'The charger has not confirmed the instruction. Its outcome is still unknown; waiting for a fresh reading.',
  'evse-read-timeout': 'The charger did not answer a reading request in time. Waiting for fresh readings before sending another instruction.',
  'evse-notification-readback-required': 'The charger reported a change. Waiting for a fresh reading before sending another instruction.',
  'evse-permission-event-overflow': 'Too many charger changes arrived to confirm which instruction has priority. Automatic control is unavailable.',
  'evse-publish-unconfirmed': 'Delivery of the charger instruction is unconfirmed. Its outcome is still unknown; waiting for a fresh reading.',
  'command-unconfirmed': 'The charger instruction is unconfirmed. Waiting for a fresh reading.',
  'evse-takeover-changed': 'The charger changed after this view was loaded. Review its latest state before requesting automatic control again.',
  'evse-native-schedule-unsupported': 'The charger cannot replace this native schedule through the available connection. Change it in the charger controls before trying again.',
  'evse-native-schedule-unconfirmed': 'The charger has not confirmed that its previous schedule was disabled. Automatic scheduling has not taken over yet.',
};

const UNKNOWN_CONTROL_DETAIL = 'Charging status could not be explained from the available information. Check the charger controls for details before requesting charging again.';
const ownValue = (values, key) => typeof key === 'string' && Object.hasOwn(values, key) ? values[key] : null;

export function chargingControlLabel(value, kind) {
  return ownValue({ 'manual-stop': 'Stop instruction active', 'native-schedule': 'Charger schedule active',
    'manual-schedule': 'Charger schedule active', 'manual-enable': 'Other charging instruction active',
    'manual-charge-now': 'Immediate charging instruction active', 'manual-release': 'Charging release active' }, value)
    ?? ownValue(CHARGING_CONTROL_CAUSES, value)
    ?? ownValue({ stop: 'Stop instruction active', schedule: 'Charger schedule active', 'native-schedule': 'Charger schedule active',
      window: 'Charger schedule active', enable: 'Other charging instruction active',
      'charge-now': 'Immediate charging instruction active', release: 'Charging release active' }, kind)
    ?? (value ? 'Charger needs attention' : '');
}

/** Keep machine codes in diagnostics data and readable causes in ordinary UI. */
export function chargingControlReason(value) {
  if (!value) return '';
  if (typeof value !== 'string') return UNKNOWN_CONTROL_DETAIL;
  value = value.trim();
  const detail = ownValue(CONTROL_DETAILS, value), label = ownValue(CHARGING_CONTROL_CAUSES, value);
  if (detail) return detail;
  if (label) return `${label}.`;
  return /^[a-z0-9_-]+$/i.test(value)
    ? UNKNOWN_CONTROL_DETAIL : value;
}

/** Missing session permission must not explain an outstanding physical duty. */
export function chargingUnconfirmedDetail(charger) {
  const control = charger.control ?? {};
  if (control.reason === 'disconnected') {
    if (control.pending) return 'An earlier charger instruction still needs reconciliation. Review recovery status and the charger’s actual settings before retrying; unplugging alone does not confirm its outcome.';
    if (control.handoverConfirmed === false) return 'The earlier control handover is still unconfirmed. Check the charger’s actual settings and recovery status; unplugging alone does not confirm that restrictions were released.';
    if (charger.error || control.errorCode) return chargingControlReason(charger.error || control.errorCode);
    const currentTests = [control.currentTest, charger.identification?.currentTest];
    if (control.owned || control.ownedPause || control.execution || charger.identification?.pauseOutstanding
      || currentTests.some(test => ['proposed', 'applying', 'active', 'restoring', 'uncertain'].includes(test?.phase)))
      return 'An earlier charger instruction or temporary setting still needs recovery. Check its actual settings and recovery status; unplugging alone does not confirm restoration.';
    if (control.snapshot?.online === false) return chargingControlReason('offline');
    return 'Current vehicle connection and charging permission cannot be confirmed. Waiting for fresh charger readings; check the charger connection in Charging setup.';
  }
  return chargingControlReason(control.reason || control.errorCode);
}

/** Feed loss affects battery evidence, separately from charger communication. */
export function chargingVehicleFeedReason(value) {
  return ownValue({
    'mqtt-disconnected': 'the vehicle MQTT connection is unavailable; check its broker connection',
    'mqtt-subscription-failed': 'the MQTT subscription failed for vehicle reports; check MQTT topic access',
    'vehicle-feed-stale': 'no recent vehicle report is available; check the vehicle publisher',
    'vehicle-source-clock-pending': 'a vehicle report is ahead of the controller clock; waiting until its time can be used',
    'vehicle-source-clock-unavailable': 'vehicle report times cannot be used; check the publisher and controller clocks',
    'vehicle-logger-unhealthy': 'vehicle logger health is unconfirmed; check the vehicle logger',
  }, value) ?? 'usable vehicle reports are unavailable; check the vehicle feed in Charging setup';
}

export function chargingCommandConfirmation(stage) {
  return ({ proposed: 'Instruction prepared; not yet sent', dispatched: 'Instruction sent; awaiting confirmation',
    'read-back': 'Setting confirmed; waiting for charging measurements',
    'physical-effect': 'Response confirmed by charger readings' })[stage] ?? 'Awaiting charger confirmation';
}
