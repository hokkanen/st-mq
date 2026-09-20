// A two-reservoir test plant, deliberately independent of the learned controller.
// Electrical and thermal quantities here are fictional, never house savings.
export class SimulatedPlant {
  constructor(state = {}) {
    this.state = { indoorC: 21, slabC: 22, action: 'normal', phase: 'normal', roomBoostC: 0, lastAt: null, pulseUntil: 0, ...state };
  }
  sample(now) {
    const s = this.state;
    const elapsedHours = s.lastAt === null ? 0 : Math.max(0, Math.min(6, (now - s.lastAt) / 3_600_000));
    const outdoorC = -4 + 4 * Math.sin(now / 86_400_000 * 2 * Math.PI);
    for (let remaining = elapsedHours; remaining > 0; remaining -= 1 / 60) {
      const dt = Math.min(remaining, 1 / 60);
      // Restoring normal only restores the native thermostat's target.
      const thermostatDemand = s.indoorC < (s.action === 'normal' ? 21.2 + (s.phase === 'preheat' ? s.roomBoostC*0.4 : 0) : 19.6);
      const auxKw = s.action === 'normal' && !(s.phase === 'recovery' && s.recoveryCompressorOnly)
        && s.indoorC < 19.4 ? 3 : 0;
      const heatKw = (thermostatDemand ? 8 : 0) + auxKw + (s.phase === 'preheat' ? 0.8 : 0);
      s.compressorDuty = thermostatDemand ? 1 : 0; s.auxKw = auxKw;
      const exchangeKw = (s.slabC - s.indoorC) * 1.6;
      s.slabC += (heatKw - exchangeKw) / 24 * dt;
      s.indoorC += (exchangeKw - (s.indoorC - outdoorC) * 0.12 + 0.5) / 6 * dt;
    }
    s.lastAt = now;
    return { indoor: { value: s.indoorC, observedAt: now }, outdoor: { value: outdoorC, observedAt: now },
      actual: { mode: s.action, dhwr: now < s.pulseUntil, verified: true, source: 'simulation', compressorDuty:s.compressorDuty??0, auxKw:s.auxKw??0, auxRoute:'space',
        powerKw:(s.compressorDuty??0)*3+(s.auxKw??0)+(now<s.pulseUntil?0.025:0) } };
  }
  apply(commands, now, dhwrDurationMs = 600_000) {
    for (const command of commands) {
      if (!['reduction', 'normal', 'circulation'].includes(command)) throw new Error('Unknown simulated command');
      this.state.action = command === 'reduction' ? 'reduction' : 'normal';
      if (command === 'circulation') this.state.pulseUntil = now + dhwrDurationMs;
    }
    return { mode: this.state.action, observedAt: now, source: 'simulation', verified: true };
  }
}

export function simulatedOutlook(now) {
  const start = Math.floor(now / 900_000) * 900_000;
  return {
    prices: Array.from({ length: 192 }, (_, i) => ({ start: start + i * 900_000, end: start + (i + 1) * 900_000,
      allInCentsPerKWh: 8 + 6 * Math.sin((start + i * 900_000) / 86_400_000 * 2 * Math.PI), source: 'simulation' })),
    forecast: Array.from({ length: 48 }, (_, i) => ({ start: start + i * 3_600_000, end: start + (i + 1) * 3_600_000,
      outdoorC: -4 + 4 * Math.sin((start + i * 3_600_000) / 86_400_000 * 2 * Math.PI),
      solarRadiationWm2: Math.max(0,400*Math.sin(((start+i*3600000)/86400000%1-0.25)*Math.PI*2)), issuedAt: now, source: 'simulation' })),
  };
}
