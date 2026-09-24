// Live equipment details and retired duplicate feeds do not belong in recorded
// telemetry. Caravan monitoring has an explicit, small history contract.
const LIVE_ONLY = new Set(['caravan_active', 'caravan_power', 'caravan_current',
  'heat_savings_active', 'garage_relay_active', 'blu_ht_battery', 'blu_ht_rssi']);
const RETIRED = new Set(['garage_temperature_ha']);
const CARAVAN_RECORDED = new Set(['caravan_energy', 'caravan_temperature', 'caravan_humidity',
  'caravan_dehumidifier_running_state']);

export function isRecordedDataset({ source, signal }) {
  return !LIVE_ONLY.has(signal) && !RETIRED.has(signal)
    && !(signal?.startsWith('caravan_') && !CARAVAN_RECORDED.has(signal))
    && !signal?.startsWith('garage_heat_pump_')
    && source !== 'mqtt-temperature-ha'
    && !(source === 'husdata-h66' && signal === 'indoor_temperature');
}
