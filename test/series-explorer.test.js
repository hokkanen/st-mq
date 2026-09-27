import test from 'node:test';
import assert from 'node:assert/strict';
import { HISTORY_AXES, HISTORY_AXIS_BY_KEY, ENERGY_SIGNALS } from '../src/domain/history-series.js';
import { EXPLORER_SERIES, EXPLORER_SERIES_BY_KEY, filterExplorerSeries,
  compatibleExplorerSeries, explorerSelection } from '../chart/series-explorer.js';

test('explorer exposes every supported history once and resolves a bounded catalogue query', () => {
  assert.deepEqual(new Set(EXPLORER_SERIES.map(row => row.signal)), new Set(HISTORY_AXES.flatMap(row => row.signals)));
  assert.equal(new Set(EXPLORER_SERIES.map(row => row.key)).size, EXPLORER_SERIES.length);
  for (const row of EXPLORER_SERIES) {
    assert(HISTORY_AXIS_BY_KEY[row.requestKey].signals.includes(row.signal));
    assert(row.unit && row.basis && row.description, row.signal);
  }
  for (const signal of [...ENERGY_SIGNALS, 'garage_native_indoor_temperature', 'dhwr_active', 'floor_storage_1_active'])
    assert(EXPLORER_SERIES_BY_KEY[signal], signal);
  assert(!EXPLORER_SERIES_BY_KEY.garage_power, 'live-only power does not acquire fabricated history');
});

test('explorer searches original labels and canonical identifiers with explicit history meanings', () => {
  assert.equal(filterExplorerSeries('pump interpreted')[0].signal, 'garage_native_indoor_temperature');
  assert.equal(filterExplorerSeries('property_energy_l2')[0].basis, 'Recording-interval energy');
  assert.equal(filterExplorerSeries('garage native energy counter')[0].signal, 'garage_native_energy');
  assert.equal(filterExplorerSeries('secret api token').length, 0);
  assert.equal(filterExplorerSeries('   ').length, EXPLORER_SERIES.length);
});

test('compatible comparisons respect units, temporal basis and physical meaning', () => {
  assert(compatibleExplorerSeries('property_energy_l1', 'ev1_energy_l1'));
  assert(!compatibleExplorerSeries('caravan_energy', 'property_import_energy_counter'));
  assert(!compatibleExplorerSeries('caravan_energy', 'ev1_session_energy_check'));
  assert(!compatibleExplorerSeries('caravan_humidity', 'heating_pump_speed'));
  assert(!compatibleExplorerSeries('model_hydronic_heat', 'model_auxiliary_power'));
  assert(!compatibleExplorerSeries('garage_model_difference', 'garage_model_rear'));
  assert(!compatibleExplorerSeries('constructor', 'constructor'));
  assert(!compatibleExplorerSeries('unsupported', 'unsupported'));
});

test('single-series selections isolate the selected subject and use rows for categorical evidence', () => {
  const pump = explorerSelection('garage_native_indoor_temperature');
  assert.deepEqual(pump.leftSignals, []);
  assert.deepEqual(pump.rightSignals, ['garage_native_indoor_temperature', 'all_in_price', 'spot_price']);
  assert.equal(pump.requestKey, 'garage_native_indoor_temperature');
  const state = explorerSelection('garage_native_defrost');
  assert.deepEqual(state.leftSignals, []);
  assert.deepEqual(state.tracks, ['garage_native_defrost']);
  assert.throws(() => explorerSelection('database_password'), /supported historical series/);
  assert.throws(() => explorerSelection('constructor'), /supported historical series/);
  assert.throws(() => explorerSelection('__proto__'), /supported historical series/);
  assert.deepEqual(explorerSelection('spot_price').leftSignals, ['all_in_price', 'spot_price']);
  assert.deepEqual(explorerSelection('spot_price').rightSignals, []);
  assert.deepEqual(explorerSelection('model_room_boost').leftSignals, ['model_room_boost']);
  assert.equal(explorerSelection('model_room_boost').unit, 'Δ°C');
});
