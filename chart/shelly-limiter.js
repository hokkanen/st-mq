/** Presentation of recorded controller decisions. Never infer a limiter mode
 * from actual power, charging permission, or today's configuration. */
export const SHELLY_LIMITER_STATES = Object.freeze({
  unrestricted: { label: 'Unrestricted', color: 'indoor', description: 'Load balancing allows the full configured ceiling. The vehicle may draw less.' },
  limited: { label: 'Limited', color: 'outdoor', description: 'Property load or charger priority reduces the current allowance.' },
  'paused-by-balancing': { label: 'Paused by balancing', color: 'learning', description: 'Available room is below the minimum charging current. A pause is requested; charger confirmation is separate.' },
  fallback: { label: 'Fallback', color: 'solar', description: 'Usable load evidence is unavailable. The configured fallback cap applies, respecting tighter limits.' },
  inactive: { label: 'Inactive', color: 'muted', description: 'Load balancing is disabled or has no connected session.' },
  unknown: { label: 'Unknown', color: 'muted', pattern: 'unknown', description: 'No reliable limiter status is available. This does not establish the charger setting or actual draw.' },
});
const reasons = {
  'unobserved': 'No recorded observation', 'history-detail-required': 'Zoom in to inspect earlier changes',
  'invalid-history': 'Recorded status unavailable', 'overlapping-history': 'Conflicting recorded status',
  'limiter-unavailable': 'Limiter status unavailable',
  'fuse-limit': 'Property headroom', 'priority-allocation': 'Charger priority',
  'hardware-restriction': 'Full configured ceiling', 'native-current-limit': 'Native charger limit',
  'vehicle-current-limit': 'Vehicle limit', 'equalizer-limit': 'Equalizer headroom',
  'feed-unsynchronized': 'Waiting for synchronized feeds', 'charger-current-unavailable': 'Easee current unavailable',
  'shelly-current-unavailable': 'Shelly current unavailable', 'non-additive-currents': 'Load readings disagree',
  'allowance-disagreement': 'Equalizer allowance and property readings disagree',
  'below-minimum-current': 'Below the minimum charging current',
  'telemetry-fallback': 'Load evidence unavailable', 'feed-unavailable': 'Load feed unavailable',
  'limiter-disabled': 'Limiter disabled', 'disconnected': 'No vehicle connected',
  'charger-unavailable': 'Charger unavailable',
};
export function shellyLimiterDisplay(value) {
  if (!value || !Object.hasOwn(SHELLY_LIMITER_STATES, value.mode)) value = null;
  const mode = value?.mode ?? 'unknown';
  const state = SHELLY_LIMITER_STATES[mode];
  const current = number => Number.isInteger(number) && number >= 0 && number <= 80 ? `${number} A` : null;
  const allowance = mode === 'unknown' || mode === 'inactive' ? null : current(value?.loadAllowanceA ?? value?.allowanceA);
  const effective = current(value?.allowanceA);
  const applied = current(value?.appliedCurrentA);
  const reason = reasons[value?.reason] ?? (mode === 'fallback' ? 'Load evidence unavailable'
    : mode === 'limited' || mode === 'paused-by-balancing' ? 'Property load or charger priority' : '');
  const application = ({ confirmed: value?.allowanceA === 0 ? 'Pause instruction confirmed'
    : applied ? `Charger setting: ${applied} confirmed` : 'Charger setting unconfirmed',
    pending: `Awaiting charger confirmation${applied ? ` · last confirmed setting ${applied}` : ''}`,
    blocked: `Application blocked${applied ? ` · charger setting ${applied}` : ''}`,
    inactive: 'No limiter instruction applied', unknown: 'Charger setting unconfirmed' })[value?.applicationStatus]
      ?? 'Charger setting unconfirmed';
  const label = `${state.label}${allowance ? ` · ${allowance}` : ''}`;
  return { mode, color: state.color, pattern: state.pattern, label, allowance, reason, application,
    effectiveAllowance: effective && effective !== allowance ? `Effective allowance: ${effective}` : '',
    detail: [`${state.label}${allowance ? ` · ${allowance} allowance` : ''}${reason ? ` · ${reason}` : ''}`,
      effective && effective !== allowance ? `Effective allowance: ${effective}, respecting other restrictions.` : '',
      application, state.description, 'Allowance is a controller ceiling, not measured charging current. Scheduled and manual stops remain separate.'].filter(Boolean).join('\n\n') };
}

export const shellyLimiterTrack = Object.freeze({
  key: 'shellyLimiter', label: 'Shelly load balancing', color: 'outdoor', keyboard: true,
  detail: 'Recorded current allowance and limiter mode, independent of measured power. Hover or drag to inspect; focus the strip and use Left/Right, Home or End to inspect changes. Scheduled and manual stops are separate from pauses requested by balancing.',
  missingLabel: 'Limiter status unknown at this time',
  values: Object.fromEntries(Object.entries(SHELLY_LIMITER_STATES).map(([key, value]) => [key, value.label])),
  colors: Object.fromEntries(Object.entries(SHELLY_LIMITER_STATES).map(([key, value]) => [key, value.color])),
  patterns: { unknown: 'unknown' },
  legend: Object.entries(SHELLY_LIMITER_STATES).map(([, value]) => ({ ...value })),
});
