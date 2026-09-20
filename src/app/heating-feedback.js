/** Relay output readback verifies tariff selection, never compressor activity. */
export function heatingFeedback({ equipment, configured = [], executor = {}, applied = {}, h66 = {}, now }) {
  const manual = executor.manualRequested;
  const requestedPhase = manual?.confirmed && manual.at >= (applied.at ?? -Infinity) ? manual.phase : applied.phase;
  const requestedAt = executor.tariffRequested?.at ?? applied.at ?? null;
  const devices = (equipment?.devices ?? []).filter(row => row.enabled !== false && (row.controls?.tariff || row.controlsHeat));
  const rows = devices.map(device => {
    const config = configured.find(row => row.id === device.id);
    const reading = device.readings?.[config?.stateSignal ?? `${device.id}_active`];
    const usable = device.available && reading && !reading.stale && [0, 1].includes(reading.value)
      && Number.isFinite(reading.observedAt) && reading.observedAt <= now;
    return { reading, usable, mode: usable ? Boolean(reading.value) === (config?.reductionOn ?? true) ? 'reduction' : 'normal' : 'unknown' };
  });
  if (!rows.length) return { mode: requestedAt === null ? 'unknown' : requestedPhase === 'reduction' ? 'reduction' : 'normal',
    phase: requestedPhase, requestedPhase, requestedAt, verified: false, source: 'mqtt-request', observedAt: requestedAt };
  const usable = rows.every(row => row.usable) && rows.every(row => row.mode === rows[0].mode);
  const verified = usable && rows.every(row => requestedAt === null
    || row.reading.observedAt >= requestedAt && (row.reading.receivedAt ?? row.reading.observedAt) >= requestedAt);
  const mode = usable ? rows[0].mode : 'unknown';
  const nativeMatches = h66.connected === true
    && (h66.phase === requestedPhase || requestedPhase === 'preheat' && h66.manualPreheat?.confirmed === true)
    && Object.entries(h66.requested ?? {}).every(([register, value]) => {
      const reading = h66.readings?.[register];
      return reading?.available === true && reading.value === value;
    });
  const phase = mode === 'normal' && ['preheat', 'recovery'].includes(requestedPhase) && nativeMatches ? requestedPhase : mode;
  return { mode, phase, requestedPhase, requestedAt, verified, source: 'equipment-state-readback', stale: !usable,
    observedAt: usable ? Math.min(...rows.map(row => row.reading.observedAt)) : null };
}
