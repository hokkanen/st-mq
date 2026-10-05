export const CHARGING_CONTROL_CAUSES = {
  'read-failed': 'Charger read failed', 'command-failed': 'Charger instruction failed',
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
  'native-current-limit': 'Native current limit', 'vehicle-current-limit': 'Vehicle current limit', 'hardware-restriction': 'Hardware current limit',
  'fuse-limit': 'Installation current limit', 'priority-allocation': 'Shared charging allocation', 'telemetry-fallback': 'Current fallback for missing measurements',
  'measurement-pair-pending': 'Awaiting measurements',
  'vehicle-not-before': 'Vehicle start restriction', 'identification-pause': 'Identification pause',
  'identification-waiting': 'Identification waiting', 'identification-charging': 'Identification observing charge',
  'economic-wait': 'Waiting for a planned charging period', 'charge-now': 'Charge now requested',
  'economic-window': 'Within a planned charging period', 'no-headroom': 'No electrical headroom available',
  'supply-unavailable': 'Supply information unavailable', 'within-limit': 'Within the available current limit',
};

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
  if (control.nativeExpiry === false) return control.phase === 'waiting'
    && control.ownsInstruction === true && control.pauseConfirmed === true
    && !control.pending && !control.manual
    && control.execution?.periods?.some(row => Number(row.startAt) === Number(period.startAt)) === true;
  return control.phase === 'paused' && control.pauseConfirmed !== false && control.ownsInstruction !== false
    && Number(control.owned?.startAt) === Number(period.startAt);
}

const CONTROL_DETAILS = {
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
  'telemetry-fallback': 'Current is limited to the configured fallback while usable load measurements are unavailable. This is not a guarantee of fuse protection.',
  'measurement-pair-pending': 'Property and charger changes arrived separately. The previous confirmed ceiling is retained without an increase while measurements are paired. Waiting does not trigger fallback or take balancing over from Equalizer.',
  'fuse-limit': 'Charging current is limited by the estimated spare capacity of the installation.',
  'priority-allocation': 'The available charging current is shared according to the selected charger priority.',
  'native-current-limit': 'The charger’s own current limit applies.',
  'vehicle-current-limit': 'The vehicle’s current limit applies.',
  'hardware-restriction': 'The configured hardware current limit applies.',
  'identification-pause': 'Charging is briefly paused to identify the connected vehicle.',
  'identification-waiting': 'Waiting for charging evidence to identify the connected vehicle.',
  'identification-charging': 'Charging is being observed to identify the connected vehicle.',
  'economic-wait': 'Waiting for the next planned charging period.',
  'charge-now': 'Immediate charging is requested for this connection. Charger and vehicle restrictions still apply.',
  'evse-command-unconfirmed': 'The charger has not confirmed the instruction. Its outcome is still unknown; waiting for a fresh reading.',
  'evse-notification-readback-required': 'The charger reported a change. Waiting for a fresh reading before sending another instruction.',
  'evse-permission-event-overflow': 'Too many charger changes arrived to confirm which instruction has priority. Automatic control is unavailable.',
  'evse-publish-unconfirmed': 'Delivery of the charger instruction is unconfirmed. Its outcome is still unknown; waiting for a fresh reading.',
  'command-unconfirmed': 'The charger instruction is unconfirmed. Waiting for a fresh reading.',
  'evse-takeover-changed': 'The charger changed after this view was loaded. Review its latest state before requesting automatic control again.',
  'evse-native-schedule-unsupported': 'The charger cannot replace this native schedule through the available connection. Change it in the charger controls before trying again.',
  'evse-native-schedule-unconfirmed': 'The charger has not confirmed that its previous schedule was disabled. Automatic scheduling has not taken over yet.',
};

export function chargingControlLabel(value, kind) {
  return ({ 'manual-stop': 'Stop instruction active', 'native-schedule': 'Charger schedule active',
    'manual-schedule': 'Charger schedule active', 'manual-enable': 'Other charging instruction active',
    'manual-charge-now': 'Immediate charging instruction active', 'manual-release': 'Charging release active' })[value]
    ?? CHARGING_CONTROL_CAUSES[value]
    ?? ({ stop: 'Stop instruction active', schedule: 'Charger schedule active', 'native-schedule': 'Charger schedule active',
      window: 'Charger schedule active', enable: 'Other charging instruction active',
      'charge-now': 'Immediate charging instruction active', release: 'Charging release active' })[kind]
    ?? (value ? 'Charger needs attention' : '');
}

/** Keep machine codes in diagnostics data and readable causes in ordinary UI. */
export function chargingControlReason(value) {
  if (!value) return '';
  if (CONTROL_DETAILS[value]) return CONTROL_DETAILS[value];
  if (CHARGING_CONTROL_CAUSES[value]) return `${CHARGING_CONTROL_CAUSES[value]}.`;
  return /^[a-z0-9]+(?:[-_][a-z0-9]+)+$/i.test(value)
    ? 'More charging status information is unavailable. Check the charger controls for details.' : String(value);
}

export function chargingCommandConfirmation(stage) {
  return ({ proposed: 'Instruction prepared; not yet sent', dispatched: 'Instruction sent; awaiting confirmation',
    'read-back': 'Setting confirmed; waiting for charging measurements',
    'physical-effect': 'Response confirmed by charger readings' })[stage] ?? 'Awaiting charger confirmation';
}
