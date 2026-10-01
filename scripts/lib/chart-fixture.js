// Artificial visual-test observations only. Never called by application startup.
export const CHART_FIXTURE_VOLTAGE_V = Object.freeze([228, 230, 232]);

export function seedVoltageFixture(store, { at, input, voltageV }) {
  for (let phase = 0; phase < 3; phase++) store.observation({
    source: 'voltage-estimate', device: input, signal: `voltage_estimate_l${phase + 1}`,
    value: voltageV[phase], unit: 'V', sourceTime: at, receivedAt: at,
    quality: ['estimated', ...(input === 'simulated' ? ['simulated'] : [])],
    raw: { fixture: true, basis: 'time-weighted-voltage-estimate', voltageMature: true,
      voltageSource: 'synthetic-visual-voltage', voltageAvailability: 'reporting',
      voltageEstimate: { phase: phase + 1, coverageMs: 3600_000 } },
  });
}

export function seedChartFixture(store, now) {
  const minute = 60_000;
  const start = Math.floor((now - 40 * 60 * minute) / (5 * minute)) * 5 * minute;
  const add = (signal, value, unit, at, source = 'simulation', device = 'visual-test-house', raw = {}) => store.observation({
    source, device, signal, value, unit, sourceTime: at, receivedAt: at,
    quality: ['simulated'], raw: { verified: 'Synthetic visual test fixture', usableForControl: true, ...raw },
  });
  store.transaction(() => {
    seedVoltageFixture(store, { at: start, input: 'simulated', voltageV: CHART_FIXTURE_VOLTAGE_V });
    for (let at = start, i = 0; at <= now; at += 5 * minute, i++) {
      const cycle = i % 48, charging = cycle >= 12 && cycle < 24;
      const auxiliaryKw = cycle >= 20 && cycle < 24 || cycle >= 30 && cycle <= 33 ? 3 : 0;
      const currents = [4 + 2 * Math.sin(i / 7), 5 + Math.sin(i / 9), 3 + 2 * Math.cos(i / 10)];
      for (let phase = 0; phase < 3; phase++) {
        const charger = charging ? 8 + phase : 0;
        add(`ev1_current_l${phase + 1}`, charger, 'A', at, 'simulation', 'visual-test-charger');
        add(`property_current_l${phase + 1}`, currents[phase] + charger
          + auxiliaryKw * 1000 / (3 * CHART_FIXTURE_VOLTAGE_V[phase]), 'A', at, 'simulation', 'visual-test-property');
      }
      add('indoor_temperature', 21.1 + Math.sin(i / 15) * 0.25, 'degC', at);
      add('garage_temperature', 13.2 + Math.sin(i / 20) * 0.6, 'degC', at);
      add('outdoor_temperature', 2 + Math.sin(i / 28) * 4, 'degC', at);
      add('heating_integral', -40 - (i % 30) * 5, 'degree-minutes', at);
      add('auxiliary_output', auxiliaryKw ? 33 : 0, '%', at);
      add('auxiliary_power', auxiliaryKw, 'kW', at);
      add('compressor_active', cycle < 40 ? 1 : 0, 'state', at);
      add('dhw_routing', cycle >= 34 ? 1 : 0, 'state', at);
      add('operating_mode', cycle >= 18 && cycle < 27 ? 4 : 1, 'state', at);
      add('solar_radiation', Math.max(0, 300 * Math.sin(i / 15)), 'W/m²', at);
      add('controller_phase', cycle >= 18 && cycle < 27 ? 2 : 0, 'state', at,
        'controller', 'simulated', { expiresAt: at + 5 * minute });
      if (i % 12 === 0) add('dhwr_request', 1, 'state', at,
        'controller', 'simulated', { expiresAt: at + 10 * minute });
      add('spot_price', -2 + Math.round((1 + Math.sin(i / 15)) * 30) / 2, 'c/kWh_ex_vat', at);
      if (i % 12 === 0) for (const [signal, value, unit] of [['learning_profit', Math.sin(i / 60), 'EUR/cycle'],
        ['learning_aux_profit', Math.sin(i / 60) - 0.3, 'EUR/cycle'], ['learning_recovery_error', 1 / (1 + i / 48), 'EUR/cycle'], ['learning_indoor_temperature', 21.1, 'degC']])
        add(signal, value, unit, at, 'controller-learning', 'simulated');
    }
  });
}
