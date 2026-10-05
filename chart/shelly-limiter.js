/** Presentation of recorded controller decisions. Never infer a limiter mode
 * from actual power, charging permission, or today's configuration. */
const SHELLY_LIMITER_STATES = Object.freeze({
  unrestricted: { label: 'Unrestricted', description: 'Load balancing allows the full configured ceiling. The vehicle may draw less.' },
  limited: { label: 'Limited', description: 'Property load or charger priority reduces the current allowance.' },
  'paused-by-balancing': { label: 'Paused by balancing', description: 'Available room is below the minimum charging current. A pause is requested; charger confirmation is separate.' },
  fallback: { label: 'Fallback', description: 'Usable load evidence is unavailable. The configured fallback cap applies, respecting tighter limits.' },
  inactive: { label: 'Inactive', description: 'Load balancing is disabled or has no connected session.' },
  unknown: { label: 'Unknown', description: 'No reliable limiter status is available. This does not establish the charger setting or actual draw.' },
});
const reasons = {
  'unobserved': 'No recorded observation', 'history-detail-required': 'Zoom in to inspect earlier changes',
  'invalid-history': 'Recorded status unavailable', 'overlapping-history': 'Conflicting recorded status',
  'limiter-unavailable': 'Limiter status unavailable',
  'fuse-limit': 'Property headroom', 'priority-allocation': 'Charger priority',
  'hardware-restriction': 'Full configured ceiling', 'native-current-limit': 'Charger current choice',
  'vehicle-current-limit': 'Vehicle limit',
  'feed-unsynchronized': 'Waiting for synchronized feeds', 'charger-current-unavailable': 'Easee current unavailable',
  'shelly-current-unavailable': 'Shelly current unavailable', 'non-additive-currents': 'Load readings disagree',
  'measurement-pair-pending': 'Awaiting measurements',
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
  const pending = mode === 'unknown' && value?.reason === 'measurement-pair-pending';
  const reason = reasons[value?.reason] ?? (mode === 'fallback' ? 'Load evidence unavailable'
    : mode === 'limited' || mode === 'paused-by-balancing' ? 'Property load or charger priority' : '');
  const application = ({ confirmed: value?.allowanceA === 0 ? 'Pause instruction confirmed'
    : applied ? `Charger setting: ${applied} confirmed` : 'Charger setting unconfirmed',
    pending: `Awaiting charger confirmation${applied ? ` · last confirmed setting ${applied}` : ''}`,
    blocked: `Application blocked${applied ? ` · charger setting ${applied}` : ''}`,
    inactive: 'No limiter instruction applied', unknown: 'Charger setting unconfirmed' })[value?.applicationStatus]
      ?? 'Charger setting unconfirmed';
  const setting = value?.applicationStatus === 'confirmed' && value?.allowanceA !== 0 && applied
    ? `${applied} confirmed` : application;
  const label = pending ? 'Awaiting measurements' : `${state.label}${allowance ? ` · ${allowance}` : ''}`;
  const effectiveAllowance = effective && effective !== allowance ? `${pending ? 'Held ceiling' : 'Effective allowance'}: ${effective}` : '';
  const description = pending
    ? 'Property and charger changes have arrived separately. The previous confirmed ceiling is retained and cannot increase while measurements are paired. Waiting alone does not trigger fallback or take balancing over from Equalizer.'
    : state.description;
  return { mode, label, allowance, reason, reasonInLabel: pending, application, setting,
    effectiveAllowance,
    detail: [`${state.label}${allowance ? ` · ${allowance} allowance` : ''}${reason ? ` · ${reason}` : ''}`,
      effectiveAllowance ? `${effectiveAllowance}, respecting other restrictions.` : '',
      application, description, 'Allowance is a controller ceiling, not measured charging current. Scheduled and manual stops remain separate.'].filter(Boolean).join('\n\n') };
}
