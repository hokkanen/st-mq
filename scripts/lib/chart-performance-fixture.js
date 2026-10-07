import { seedVoltageFixture } from './chart-fixture.js';

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
export const CHART_PERFORMANCE_NOW = Date.parse('2026-10-07T12:00:00Z');
export const CHART_PERFORMANCE_CONTRACT = { periods: [{ from: '2025-01-01T00:00:00Z',
  marginCtPerKwh: 1, taxCtPerKwh: 2, vatRate: 0.2, tariff: 'day-night',
  transferRates: { vatIncluded: false, dayCtPerKwh: 3, nightCtPerKwh: 1, winterDayCtPerKwh: 4, otherCtPerKwh: 2 } }] };

/** Fixed synthetic evidence, never configuration or household exports. Includes
 * unequal phase loads, short peaks, gaps, original energy intervals and prices.
 * Bulk seeding is not a measurement of acquisition or adaptive recorder density. */
export function seedChartPerformanceFixture(store, { days = 90, now = CHART_PERFORMANCE_NOW } = {}) {
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new RangeError('Use 1–365 synthetic days');
  const start = now - days * DAY;
  let count = 0;
  const add = (source, device, signal, value, unit, at, raw = {}) => {
    store.insertObservation.run(source, device, signal, value, unit, at, at,
      '["simulated"]', JSON.stringify(raw), null, null);
    count++;
  };
  seedVoltageFixture(store, { at: start - HOUR, input: 'providers', voltageV: [228, 230, 232] });
  for (let day = 0; day < days; day++) store.transaction(() => {
    for (let slot = 0; slot < 288; slot++) {
      const at = start + day * DAY + slot * 5 * MINUTE;
      // A real six-hour acquisition gap: it must not be filled by optimization.
      if (day % 17 === 8 && slot >= 72 && slot < 144) continue;
      const charging = slot >= 100 && slot < 136, peak = slot % 97 === 0 ? 5 : 0;
      for (const [prefix, source] of [['property', 'easee'], ['ev1', 'easee'], ['ev2', 'shelly-evse']]) {
        for (let phase = 1; phase <= 3; phase++) {
          const kw = prefix === 'property' ? 0.4 + phase * 0.15 + Math.abs(Math.sin(slot / 13)) + peak + (charging ? 3 : 0)
            : charging ? (prefix === 'ev1' ? 1.2 : 0.8) + phase * 0.1 : 0;
          add(source, `synthetic-${prefix}`, `${prefix}_energy_l${phase}`, kw / 12, 'kWh', at + 5 * MINUTE,
            { intervalStart: at, intervalEnd: at + 5 * MINUTE, durationMs: 5 * MINUTE,
              basis: 'synthetic-measured-interval', recorder: { policy: 'adaptive-energy' } });
        }
      }
      const outdoors = 4 + Math.sin(slot / 40) * 5;
      for (const [signal, value] of [['indoor_temperature', 21 + Math.sin(slot / 40) * 0.2],
        ['bedroom_temperature', 20.8 + Math.sin(slot / 47) * 0.3], ['downstairs_temperature', 21.2],
        ['garage_temperature', 13 + Math.sin(slot / 35)], ['garage_temperature_2', 12.8 + Math.sin(slot / 36)],
        ['outdoor_temperature', outdoors], ['supply_temperature', 32 + Math.sin(slot / 9)], ['return_temperature', 27]])
        add('mqtt-temperature', 'synthetic-temperatures', signal, value, 'degC', at);
      add('garage-adapter', 'synthetic-garage', 'garage_compressor_frequency', slot % 48 < 30 ? 32 : 0, 'Hz', at);
      add('garage-adapter', 'synthetic-garage', 'garage_compressor_active', slot % 48 < 30 ? 1 : 0, 'state', at);
      if (slot % 3 === 0) add('synthetic-market', 'synthetic-prices', 'spot_price', 5 + 8 * Math.sin(slot / 25), 'c/kWh_ex_vat', at);
      for (const [signal, value, unit] of [['compressor_active', slot % 48 < 35 ? 1 : 0, 'state'],
        ['dhw_routing', slot % 48 > 30 ? 1 : 0, 'state'], ['operating_mode', 1, 'code'],
        ['auxiliary_output', slot % 97 === 0 ? 33 : 0, '%']])
        add('husdata-h66', 'synthetic-pump', signal, value, unit, at, { verified: true, usableForControl: true, ratedPowerKw: 9 });
    }
  });
  return { days, observations: count + 3, now, start };
}
