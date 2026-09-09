// Acquisition-only integration. The property import counter is audit data and never
// participates in this calculation. All durable learning inputs are the three
// interval energies emitted here and subsequently committed by the recorder.
const HOUR = 3_600_000;
const BAD = new Set(['provider_error', 'missing', 'invalid_unit', 'invalid_numeric', 'conflicting_duplicate', 'future_source_time']);
const time = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => Number.isFinite(value) && value >= 0;

export class ElectricityAccumulator {
  constructor({ maxAgeMs = 300_000, maxTelemetryAgeMs = 17 * 60_000, maxGapMs = 60_000, checkpoint } = {}) {
    if (![maxAgeMs, maxTelemetryAgeMs, maxGapMs].every(value => Number.isFinite(value) && value > 0)) throw new RangeError('Electricity intervals must be positive');
    this.maxAgeMs = maxAgeMs;
    this.maxTelemetryAgeMs = maxTelemetryAgeMs;
    this.maxGapMs = maxGapMs;
    this.devices = {};
    this.auditHeads = {};
    this.availability = {};
    if (checkpoint?.version === 1) {
      for (const [key, previous] of Object.entries(checkpoint.devices ?? {})) {
        if (time(previous?.at) && Array.isArray(previous.powers) && previous.powers.length === 3 && previous.powers.every(positive)
          && time(previous.sourceTime) && (previous.telemetryAt === undefined || time(previous.telemetryAt))
          && ['ev1', 'property'].includes(previous.prefix)) this.devices[key] = structuredClone(previous);
      }
      for (const [key, head] of Object.entries(checkpoint.auditHeads ?? {})) {
        if (key.startsWith('property:') && key.endsWith(':property_import_energy_counter')
          && time(head?.sourceTime) && positive(head.value)) this.auditHeads[key] = { sourceTime: head.sourceTime, value: head.value };
      }
      for (const [key, available] of Object.entries(checkpoint.availability ?? {})) {
        if (typeof available === 'boolean') this.availability[key] = available;
      }
    }
  }

  checkpoint() { return { version: 1, devices: structuredClone(this.devices), auditHeads: structuredClone(this.auditHeads), availability: { ...this.availability } }; }

  sample(rows, now) {
    if (!Array.isArray(rows) || !time(now)) throw new TypeError('Electrical rows and a valid timestamp are required');
    const groups = new Map(), audits = [], intervals = [], gaps = [];
    for (const row of rows) {
      if (row?.source !== 'easee' || typeof row.device !== 'string') continue;
      const prefix = /^ev1_/.test(row.signal) ? 'ev1' : /^property_/.test(row.signal) ? 'property' : null;
      if (!prefix || /_energy_counter$/.test(row.signal) && row.signal !== 'property_import_energy_counter') continue;
      const key = `${prefix}:${row.device}`;
      if (!groups.has(key)) groups.set(key, { device: row.device, prefix, rows: [] });
      groups.get(key).rows.push(row);
      if (row.signal !== 'property_import_energy_counter' || !positive(row.value) || !time(row.sourceTime) || row.sourceTime > now
        || (row.quality ?? []).some(flag => BAD.has(flag))) continue;
      const auditKey = `${key}:${row.signal}`, previous = this.auditHeads[auditKey];
      if (previous?.sourceTime === row.sourceTime && previous.value === row.value) continue;
      const quality = [...(row.quality ?? []).filter(flag => flag !== 'stale')];
      if (previous && row.sourceTime <= previous.sourceTime) quality.push('counter_time_not_increasing');
      if (previous && row.value < previous.value) quality.push('counter_reset');
      audits.push({ source: 'easee', device: row.device, signal: row.signal, sourceTime: row.sourceTime,
        receivedAt: now, value: row.value, quality, comparison: null });
      if (!previous || row.sourceTime > previous.sourceTime) this.auditHeads[auditKey] = { sourceTime: row.sourceTime, value: row.value };
    }
    for (const [key, group] of groups) {
      const previous = this.devices[key];
      const snapshot = this.snapshot(group, now);
      if (!snapshot) {
        if (this.availability[key] !== false) gaps.push({ device: group.device, prefix: group.prefix, start: Math.min(previous?.at ?? now, now), end: Math.max(previous?.at ?? now, now),
          quality: ['electricity_unavailable', ...new Set(group.rows.flatMap(row => (row.quality ?? []).filter(flag => BAD.has(flag) || flag === 'stale')))] });
        this.availability[key] = false;
        delete this.devices[key];
        continue;
      }
      this.availability[key] = true;
      // Reported power and VI inputs have independent clocks; changing the
      // estimation basis is not a reversal of the same source measurement.
      const sameBasis = previous?.quality.includes('reported_active_power') === snapshot.quality.includes('reported_active_power');
      const sourceRolledBack = previous && sameBasis && snapshot.sourceTime < previous.sourceTime;
      const previousMaxAge = previous?.quality.includes('device_telemetry_confirmed') ? this.maxTelemetryAgeMs : this.maxAgeMs;
      if (previous && now > previous.at && now - previous.at <= this.maxGapMs && !sourceRolledBack
        && now - (previous.telemetryAt ?? previous.sourceTime) <= previousMaxAge) {
        const hours = (now - previous.at) / HOUR;
        const energies = snapshot.powers.map((power, index) => (previous.powers[index] + power) * 0.5 * hours);
        const quality = [...new Set([...previous.quality, ...snapshot.quality,
          ...(previous.sourceTime === snapshot.sourceTime ? ['held_source_values'] : [])])];
        intervals.push({ source: 'easee', device: group.device, prefix: group.prefix, start: previous.at, end: now,
          energies, powers: snapshot.powers, receivedAt: now, sourceTime: snapshot.sourceTime, telemetryAt: snapshot.telemetryAt, quality,
          force: snapshot.powers.some((power, index) => (power === 0) !== (previous.powers[index] === 0)) });
      } else if (previous && now !== previous.at) {
        gaps.push({ device: group.device, prefix: group.prefix, start: Math.min(previous.at, now), end: Math.max(previous.at, now),
          quality: [now < previous.at ? 'clock_rollback' : sourceRolledBack ? 'source_time_rollback' : 'electricity_gap'] });
      }
      if (!previous || now >= previous.at) this.devices[key] = snapshot;
      else delete this.devices[key];
    }
    return { intervals, audits, gaps };
  }

  snapshot({ device, prefix, rows }, now) {
    const get = signal => rows.find(row => row.signal === `${prefix}_${signal}`);
    const valid = row => row && positive(row.value) && time(row.sourceTime) && row.sourceTime <= now
      && !(row.quality ?? []).some(flag => BAD.has(flag));
    const usable = row => valid(row) && now - row.sourceTime <= this.maxAgeMs;
    const currents = [1, 2, 3].map(phase => get(`current_l${phase}`));
    const voltages = [1, 2, 3].map(phase => get(`voltage_l${phase}`));
    const power = get('active_power');
    const connectionValid = value => typeof value?.connected === 'boolean' && time(value.observedAt) && value.observedAt <= now;
    if (rows.some(row => connectionValid(row.raw?.deviceConnection) && row.raw.deviceConnection.connected === false)) return null;
    const connection = power?.raw?.deviceConnection;
    // These are device measurement timestamps, never HTTP receipt time or
    // cumulative counter timestamps. A cached online flag alone proves nothing.
    const telemetry = [[power, 'kW'], ...currents.map(row => [row, 'A']), ...voltages.map(row => [row, 'V'])]
      .filter(([row, unit]) => row?.unit === unit && valid(row)).map(([row]) => row.sourceTime);
    const diagnosticTime = power?.raw?.deviceTelemetryAt;
    if (prefix === 'ev1' && time(diagnosticTime) && diagnosticTime <= now) telemetry.push(diagnosticTime);
    const latestTelemetry = telemetry.length ? Math.max(...telemetry) : null;
    const confirmed = connectionValid(connection) && connection.connected && valid(power)
      && latestTelemetry !== null && now - latestTelemetry <= this.maxTelemetryAgeMs;
    const reportedPower = usable(power) || confirmed;
    let used, powers;
    const quality = ['estimated', 'phase_allocation_estimated'];
    if (confirmed) quality.push('device_telemetry_confirmed');
    if (reportedPower && !usable(power)) quality.push('held_power_with_live_telemetry');
    if (reportedPower && power.value === 0) {
      used = [power]; powers = [0, 0, 0]; quality.push('reported_active_power');
    } else {
      // Last-reported phase values can remain unchanged while total power is
      // updated. Older valid currents may estimate phase shares when reported
      // total power is usable; they cannot supply VI-only energy.
      const heldCurrents = currents.filter(row => !usable(row) && valid(row));
      if (!currents.every(row => usable(row) || reportedPower && heldCurrents.includes(row))) return null;
      const haveVoltage = voltages.every(row => usable(row) && row.raw?.voltageMapping !== 'terminal-pair-unverified');
      const weights = currents.map((row, index) => row.value * (haveVoltage ? voltages[index].value : 1));
      const sum = weights.reduce((total, value) => total + value, 0);
      if (reportedPower) {
        if (sum <= 0) return null; // Positive total with unknown phase split is a gap, not invented phase energy.
        powers = weights.map(value => power.value * value / sum);
        // Assign the rounding remainder to the last phase so total power is conserved.
        powers[2] = Math.max(0, power.value - powers[0] - powers[1]);
        used = [power, ...currents, ...(haveVoltage ? voltages : [])];
        quality.push('reported_active_power', haveVoltage ? 'voltage_current_phase_weights' : 'current_phase_weights');
        if (heldCurrents.some(row => row.value === 0)) quality.push('last_reported_zero_phase_weights');
        if (heldCurrents.some(row => row.value !== 0)) quality.push('last_reported_phase_weights');
      } else if (haveVoltage) {
        powers = weights.map(value => value / 1000);
        used = [...currents, ...voltages];
        quality.push('voltage_current_power_estimate', 'unity_power_factor_assumed');
      } else return null;
    }
    const times = used.map(row => row.sourceTime);
    if (Math.max(...times) - Math.min(...times) > 30_000) quality.push('asynchronous_snapshot');
    if (used.some(row => row.sourceTime < now)) quality.push('last_reported_observations');
    // Keep the power's original clock for ordering; independent device evidence
    // can confirm an unchanged value without rewriting any measurement time.
    const sourceTime = reportedPower ? power.sourceTime : Math.min(...times);
    const telemetryAt = reportedPower && confirmed ? latestTelemetry : sourceTime;
    return { device, prefix, at: now, sourceTime, telemetryAt, powers, quality };
  }
}
