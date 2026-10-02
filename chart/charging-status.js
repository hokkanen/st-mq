export const CHARGING_CONTROL_CAUSES = {
  'read-failed': 'Charger read failed', 'command-failed': 'Charger instruction failed',
  'readback-failed': 'Charger confirmation could not be read', 'readback-mismatch': 'Charger readback did not match the instruction',
  'access-denied': 'Charger access denied', 'control-revoked': 'Control permission was withdrawn',
  'state-changed': 'Charger state changed during the instruction', 'unsupported-schedule': 'Schedule unsupported by the charger',
  'invalid-plan': 'Charging plan could not be applied', 'missing-current-limit': 'Charging current limit unavailable',
  'start-passed': 'Requested start had already passed', 'ambiguous-start': 'Requested start time was ambiguous',
  'start-out-of-range': 'Requested start time was outside the supported range', 'charger-fault': 'Charger reported a fault',
  ['charging-authorization']: 'Charging authorization required', 'incomplete-state': 'Charger state incomplete',
  'charger-stopped': 'Charger reported stopped', 'pause-unconfirmed': 'Pause not confirmed',
  offline: 'Charger offline', 'provider-offline': 'Charger provider offline',
  'transaction-unconfirmed': 'Charging transaction not confirmed', 'composite-unavailable': 'Charger schedule readback unavailable',
  'profile-rejected': 'Charger rejected the charging profile', 'retry-limit': 'Instruction retry limit reached',
  'storage-failed': 'Control state could not be saved', 'evse-control-unavailable': 'Charger control unavailable',
  'evse-command-revoked': 'Charger instruction permission withdrawn', 'evse-command-unconfirmed': 'Charger instruction unconfirmed',
  'evse-publish-unconfirmed': 'Instruction delivery unconfirmed', 'evse-rpc-rejected': 'Charger rejected the instruction',
  'evse-work-state-unavailable': 'Charger connection state unavailable', 'evse-current-control-unavailable': 'Current limiter unavailable', 'evse-profile-unsupported': 'Charger profile unsupported', 'evse-read-unavailable': 'Charger read unavailable',
  'evse-native-restriction': 'A charger restriction has priority', 'evse-native-schedule-unavailable': 'Charger timer unavailable',
  'evse-event-overflow': 'Charger event buffer exceeded', 'evse-component-mapping-unverified': 'Charger component mapping unverified',
  'identification-resume-required': 'Identification release still requires confirmation', 'command-unconfirmed': 'Charger instruction unconfirmed',
  'control-error': 'Charger control error; detailed cause unavailable',
  'manual-stop': 'Manual stop has priority', 'manual-release': 'Manual release has priority', 'native-schedule': 'Charger timer has priority',
  'manual-enable': 'Native app charging has priority', 'manual-charge-now': 'Native app release has priority', 'manual-schedule': 'Native app schedule has priority',
  'native-current-limit': 'Native current limit', 'vehicle-current-limit': 'Vehicle current limit', 'hardware-restriction': 'Hardware current limit',
  'fuse-limit': 'Installation current limit', 'priority-allocation': 'Shared charging allocation', 'telemetry-fallback': 'Current fallback for missing measurements',
  'vehicle-not-before': 'Vehicle start restriction', 'identification-pause': 'Identification pause',
  'identification-waiting': 'Identification waiting', 'identification-charging': 'Identification observing charge',
  'economic-wait': 'Waiting for a planned charging period', 'charge-now': 'Charge now requested',
  'economic-window': 'Within a planned charging period', 'no-headroom': 'No electrical headroom available',
  'supply-unavailable': 'Supply information unavailable', 'within-limit': 'Within the available current limit',
};

const CONTROL_DETAILS = {
  'manual-stop': 'A manual stop is active and has priority over automatic charging. Resume charging in the charger controls when ready.',
  'native-schedule': 'A schedule set on the charger has priority. Disable the timer in the charger app, then turn Automatic charging off and on here to request a handover.',
  'manual-schedule': 'A schedule set in the charger app has priority over automatic charging.',
  'manual-enable': 'A charging choice made in the charger app has priority over automatic charging.',
  'manual-charge-now': 'Immediate charging selected in the charger app has priority over automatic scheduling.',
  'manual-release': 'A manual charging release has priority over automatic scheduling.',
  'vehicle-not-before': 'The vehicle has a later charging start time. Charging must wait until the vehicle allows it.',
  'telemetry-fallback': 'Current is limited to the configured fallback while fresh measurements are unavailable. This is not a guarantee of fuse protection.',
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
  'evse-publish-unconfirmed': 'Delivery of the charger instruction is unconfirmed. Its outcome is still unknown; waiting for a fresh reading.',
  'command-unconfirmed': 'The charger instruction is unconfirmed. Waiting for a fresh reading.',
};

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
