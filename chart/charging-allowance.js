import { shellyLimiterDisplay } from './shelly-limiter.js';

const current = value => Number.isFinite(value) && value >= 0 ? `${Number(value.toFixed(1))} A` : null;
const reasons = {
  'limiter-disabled': 'Automatic current adjustment is disabled.',
  disconnected: 'No vehicle is connected.',
  'charger-unavailable': 'The charger is unavailable.',
};

/** Display the admitted ceiling; the UI never calculates headroom. */
export function chargingAllowanceDisplay(value, { limiter, formatTime = at => new Date(at).toISOString() } = {}) {
  const mode = ['unrestricted', 'limited', 'fallback', 'unknown', 'inactive'].includes(value?.mode) ? value.mode : 'unknown';
  const allowance = ['unknown', 'inactive'].includes(mode) ? null : current(value?.allowanceA);
  const label = allowance ? `${allowance} ${mode === 'fallback' ? 'Fallback' : 'Available'}`
    : mode === 'inactive' ? 'Inactive' : 'Allowance unknown';
  const tone = mode === 'fallback' ? 'fallback' : !allowance ? 'neutral' : value.allowanceA === 0 ? 'zero'
    : mode === 'unrestricted' ? 'full' : 'limited';
  const native = value?.source === 'easee-equalizer';
  const capacityOnly = !native && value?.limiter?.applicationStatus === 'inactive' && allowance !== null;
  const source = native ? 'Source: native Equalizer allowance, using the lowest of all three phase allowances.'
    : value?.source === 'st-mq-load-balancing' ? capacityOnly
      ? 'Source: present property capacity after connected charging commitments, using the limiting phase.'
      : 'Source: the controller’s load-balancing allowance, using the limiting phase and shared charger priority.' : 'Current allowance evidence is unavailable.';
  const maximum = current(value?.maximumCurrentA), reported = current(value?.reportedAllowanceA);
  const measured = Number.isFinite(value?.measuredAt) ? `${native ? 'Oldest phase source time' : 'Decision time'}: ${formatTime(value.measuredAt)}.` : '';
  const received = native && Number.isFinite(value?.receivedAt) ? `Evidence received: ${formatTime(value.receivedAt)}.` : '';
  const explanation = mode === 'fallback' ? 'Fallback is a ceiling used when usable load evidence is unavailable; it is not verified property headroom.'
    : mode === 'unknown' ? 'No current verified allowance is available. A retained charger setting does not establish available headroom.'
      : mode === 'inactive' ? 'Load balancing is disabled.'
        : 'Available is the load-balancing ceiling per phase. Charger settings and vehicle restrictions can lower the effective current. It is not measured draw or permission to start.';
  return { mode, label, tone, detail: [label, source,
    native && reported ? `Reported Equalizer allowance: ${reported} per phase.` : '',
    maximum ? `Equipment ceiling: ${maximum} per phase.` : '', reasons[value?.reason], measured, received,
    capacityOnly ? 'No vehicle is connected. This capacity observation applies no charger instruction; allocation is reassessed on connection.' : '',
    explanation, limiter ? shellyLimiterDisplay(limiter).detail : ''].filter(Boolean).join('\n\n') };
}
