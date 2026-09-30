import { bmwHomeContext } from './vehicle.js';

const finite = Number.isFinite;
const timestamp = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const percentage = value => finite(value) && value >= 0 && value <= 100;
const boolean = value => typeof value === 'boolean';

// This projection is deliberately an allowlist. Provider identifiers, reading
// IDs, coordinates, topic names and raw messages never enter setup evidence.
function field(value, metadata, { available, now, valid = finite, receiptOnly = false, maxAge = Infinity } = {}) {
  const measuredAt = receiptOnly ? null : timestamp(metadata?.measuredAt);
  const receivedAt = timestamp(metadata?.receivedAt);
  const at = receiptOnly ? receivedAt : measuredAt;
  const usable = available === true && valid(value) && at !== null && at <= now
    && now - at <= maxAge && (receivedAt === null || receivedAt <= now);
  return { value: usable ? value : null, available: usable, measuredAt, receivedAt,
    timeBasis: receiptOnly ? 'receipt-only' : 'measurement',
    retained: typeof metadata?.retained === 'boolean' ? metadata.retained : null };
}

/** Read-only feed capability view; this never associates a car with a charger. */
export function bmwVehicleSetup(reading, { available = false, now = Date.now() } = {}) {
  const options = { available, now };
  const home = available ? bmwHomeContext(reading, now) : null;
  return { available: available === true, fields: {
    soc: field(reading?.soc, reading, { ...options, valid: percentage }),
    minimumSoc: field(reading?.chargeLimitSoc, reading?.fields?.chargeLimitSoc, { ...options, valid: percentage }),
    capacityKwh: field(reading?.usableCapacityKwh, reading?.fields?.usableCapacityKwh,
      { ...options, valid: value => finite(value) && value >= 1 && value <= 300 }),
    pluggedIn: field(reading?.pluggedIn, reading?.fields?.pluggedIn, { ...options, valid: boolean, maxAge: 86_400_000 }),
    charging: field(reading?.charging, reading?.fields?.charging, { ...options, valid: boolean, maxAge: 900_000 }),
    atHome: field(reading?.atHome, reading?.fields?.atHome, { ...options, valid: boolean, maxAge: 86_400_000 }),
  }, homeContext: home ? { source: home.source, measuredAt: home.measuredAt, receivedAt: home.receivedAt } : null };
}

export function teslaVehicleSetup(snapshot = {}, { now = Date.now() } = {}) {
  const available = snapshot.connected === true && snapshot.healthy === true;
  const options = { available, now, receiptOnly: true };
  const read = (key, value, valid = finite) => field(value, snapshot.fields?.[key], { ...options, valid });
  const chargingKey = ['state', 'charging_state'].filter(key => snapshot.fields?.[key])
    .sort((a, b) => (snapshot.fields[b].sequence ?? 0) - (snapshot.fields[a].sequence ?? 0))[0];
  const states = ['charging', 'online', 'offline', 'asleep', 'suspended', 'driving', 'updating'];
  return { available, healthy: snapshot.healthy === true,
    state: states.includes(snapshot.fields?.state?.value) ? snapshot.fields.state.value : null,
    fields: {
      soc: read('battery_level', snapshot.batteryLevel, percentage),
      minimumSoc: read('charge_limit_soc', snapshot.chargeLimitSoc, percentage),
      pluggedIn: read('plugged_in', snapshot.pluggedIn, boolean),
      charging: read(chargingKey, snapshot.charging, boolean),
      atHome: read('geofence', snapshot.atHome, boolean),
      powerKw: read('charger_power', snapshot.actualPowerKw, value => finite(value) && value >= 0),
      requestedCurrentA: read('charge_current_request', snapshot.requestedCurrentA, value => finite(value) && value >= 0),
      maxCurrentA: read('charge_current_request_max', snapshot.maxCurrentA, value => finite(value) && value >= 0),
      vehicleNotBefore: read('scheduled_charging_start_time', snapshot.scheduledStartAt,
        value => timestamp(value) !== null && value > now),
    } };
}
