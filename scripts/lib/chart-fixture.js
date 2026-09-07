// Artificial visual-test observations only. Never called by application startup.
export function seedChartFixture(store, now) {
  const minute = 60_000;
  const start = Math.floor((now - 40 * 60 * minute) / (5 * minute)) * 5 * minute;
  const add = (signal, value, unit, at, source = 'simulation', device = 'visual-test-house') => store.observation({
    source, device, signal, value, unit, sourceTime: at, receivedAt: at,
    quality: ['simulated'], raw: { verified: 'Synthetic visual test fixture', usableForControl: true },
  });
  store.transaction(() => {
    for (let at = start, i = 0; at <= now; at += 5 * minute, i++) {
      const cycle = i % 48, charging = cycle >= 12 && cycle < 24;
      const currents = [4 + 2 * Math.sin(i / 7), 5 + Math.sin(i / 9), 3 + 2 * Math.cos(i / 10)];
      for (let phase = 0; phase < 3; phase++) {
        const charger = charging ? 8 + phase : 0;
        add(`ev1_current_l${phase + 1}`, charger, 'A', at, 'simulation', 'visual-test-charger');
        add(`property_current_l${phase + 1}`, currents[phase] + charger, 'A', at, 'simulation', 'visual-test-property');
      }
      add('indoor_temperature', 21.1 + Math.sin(i / 15) * 0.25, 'degC', at);
      add('garage_temperature', 13.2 + Math.sin(i / 20) * 0.6, 'degC', at);
      add('outdoor_temperature', 2 + Math.sin(i / 28) * 4, 'degC', at);
      add('heating_integral', -40 - (i % 30) * 5, 'degree-minutes', at);
      add('auxiliary_output', cycle >= 30 && cycle <= 33 ? 33 : 0, '%', at);
      add('requested_heat_mode', cycle >= 18 && cycle < 27 ? 0 : i % 12 === 0 ? 60 : 15, 'legacy_command', at);
      add('spot_price', -2 + Math.round((1 + Math.sin(i / 15)) * 30) / 2, 'c/kWh_ex_vat', at);
    }
  });
}
