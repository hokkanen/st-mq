const instant = value => typeof value === 'number' ? value : Date.parse(value);
const finite = Number.isFinite;
const helsinki = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** Eligibility is Finnish local time, separate from electricity tariff hours. */
export function dhwrEligible(now, lastPulseAt, action = 'normal') {
  const timestamp = instant(now);
  if (!finite(timestamp) || action !== 'normal') return false;
  const parts = Object.fromEntries(helsinki.formatToParts(new Date(timestamp)).map(part => [part.type, part.value]));
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  if (minute < 345 || minute > 1185) return false;
  if (lastPulseAt === null || lastPulseAt === undefined) return true;
  const previous = instant(lastPulseAt);
  // Invalid/future recency is uncertain, not permission to send an extra circulation pulse.
  return finite(previous) && timestamp - previous >= 52.5 * 60_000;
}
