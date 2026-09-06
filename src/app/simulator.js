// A two-reservoir test plant, deliberately independent of the learned controller.
// Electrical and thermal quantities here are fictional, never house savings.
export class SimulatedPlant {
  constructor(state = {}) {
    this.state = { indoorC: 21, slabC: 22, action: 'normal', lastAt: null, pulseUntil: 0, ...state };
  }
  sample(now) {
    const s = this.state;
    const elapsedHours = s.lastAt === null ? 0 : Math.max(0, Math.min(6, (now - s.lastAt) / 3_600_000));
    const outdoorC = -4 + 4 * Math.sin(now / 86_400_000 * 2 * Math.PI);
    for (let remaining = elapsedHours; remaining > 0; remaining -= 1 / 60) {
      const dt = Math.min(remaining, 1 / 60);
      // Restoring normal only restores the native thermostat's target.
      const thermostatDemand = s.indoorC < (s.action === 'normal' ? 21.2 : 19.6);
      const heatKw = thermostatDemand ? 8 : 0;
      const exchangeKw = (s.slabC - s.indoorC) * 1.6;
      s.slabC += (heatKw - exchangeKw) / 24 * dt;
      s.indoorC += (exchangeKw - (s.indoorC - outdoorC) * 0.12 + 0.5) / 6 * dt;
    }
    s.lastAt = now;
    return { indoor: { value: s.indoorC, observedAt: now }, outdoor: { value: outdoorC, observedAt: now },
      actual: { mode: s.action, dhwr: now < s.pulseUntil, verified: true, source: 'simulation' } };
  }
  apply(commands, now) {
    for (const command of commands) {
      if (!['heatoff', 'heaton15', 'heaton60'].includes(command)) throw new Error('Unknown simulated command');
      this.state.action = command === 'heatoff' ? 'reduction' : 'normal';
      if (command === 'heaton60') this.state.pulseUntil = now + 600_000;
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
      outdoorC: -4 + 4 * Math.sin((start + i * 3_600_000) / 86_400_000 * 2 * Math.PI), issuedAt: now, source: 'simulation' })),
  };
}
