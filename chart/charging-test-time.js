// Vehicle timers use the installation timezone, independently of the browser.
export function chargingTestLocalTime(at, timezone = 'Europe/Helsinki') {
  if (!Number.isFinite(at)) return '';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(at).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export function parseChargingTestTime(value, timezone = 'Europe/Helsinki') {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error('Enter the vehicle start date and time.');
  const base = Date.parse(`${value}:00Z`), candidates = new Set();
  if (Number.isFinite(base)) for (const hours of [-36, 0, 36]) {
    const probe = base + hours * 3600_000;
    const offset = Date.parse(`${chargingTestLocalTime(probe, timezone)}:00Z`) - probe;
    const at = base - offset;
    if (chargingTestLocalTime(at, timezone) === value) candidates.add(at);
  }
  if (candidates.size !== 1) throw new Error('Choose an unambiguous local time outside the daylight-saving clock change.');
  return [...candidates][0];
}
