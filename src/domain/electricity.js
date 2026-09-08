// Acquisition-only integration. Counter observations are audit data and never
// participate in this calculation. All durable learning inputs are the three
// interval energies emitted here and subsequently committed by the recorder.
const HOUR = 3_600_000;
const BAD = new Set(['provider_error', 'missing', 'invalid_unit', 'invalid_numeric', 'conflicting_duplicate', 'future_source_time']);
const time = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => Number.isFinite(value) && value >= 0;

export class ElectricityAccumulator {
  constructor({ maxAgeMs = 300_000, maxGapMs = 60_000, checkpoint } = {}) {
    if (![maxAgeMs, maxGapMs].every(value => Number.isFinite(value) && value > 0)) throw new RangeError('Electricity intervals must be positive');
    this.maxAgeMs = maxAgeMs;
    this.maxGapMs = maxGapMs;
    this.devices = {};
    this.auditHeads = {};
    this.availability = {};
    if (checkpoint?.version === 1) {
      for (const [key, previous] of Object.entries(checkpoint.devices ?? {})) {
        if (time(previous?.at) && Array.isArray(previous.powers) && previous.powers.length === 3 && previous.powers.every(positive)
          && time(previous.sourceTime) && ['ev1', 'property'].includes(previous.prefix)) this.devices[key] = structuredClone(previous);
      }
      for (const [key, head] of Object.entries(checkpoint.auditHeads ?? {})) {
        if (time(head?.sourceTime) && positive(head.value)) this.auditHeads[key] = { sourceTime: head.sourceTime, value: head.value };
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
      if (!prefix) continue;
      const key = `${prefix}:${row.device}`;
      if (!groups.has(key)) groups.set(key, { device: row.device, prefix, rows: [] });
      groups.get(key).rows.push(row);
      if (!/_energy_counter$/.test(row.signal) || !positive(row.value) || !time(row.sourceTime) || row.sourceTime > now
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
      if (previous && now > previous.at && now - previous.at <= this.maxGapMs && previous.sourceTime <= snapshot.sourceTime
        && now - previous.sourceTime <= this.maxAgeMs) {
        const hours = (now - previous.at) / HOUR;
        const energies = snapshot.powers.map((power, index) => (previous.powers[index] + power) * 0.5 * hours);
        const quality = [...new Set([...previous.quality, ...snapshot.quality,
          ...(previous.sourceTime === snapshot.sourceTime ? ['held_source_values'] : [])])];
        intervals.push({ source: 'easee', device: group.device, prefix: group.prefix, start: previous.at, end: now,
          energies, powers: snapshot.powers, receivedAt: now, sourceTime: snapshot.sourceTime, quality,
          force: snapshot.powers.some((power, index) => (power === 0) !== (previous.powers[index] === 0)) });
      } else if (previous && now !== previous.at) {
        gaps.push({ device: group.device, prefix: group.prefix, start: Math.min(previous.at, now), end: Math.max(previous.at, now),
          quality: [now < previous.at ? 'clock_rollback' : snapshot.sourceTime < previous.sourceTime ? 'source_time_rollback' : 'electricity_gap'] });
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
    let used, powers;
    const quality = ['estimated', 'phase_allocation_estimated'];
    if (usable(power) && power.value === 0) {
      used = [power]; powers = [0, 0, 0]; quality.push('reported_active_power');
    } else {
      // Easee may retain old timestamps for unused phases. An old exact zero
      // can estimate that phase's share only when fresh reported total power
      // anchors consumption and every nonzero phase current is still fresh.
      // It cannot establish fresh measurements or support VI-only integration.
      const staleZeros = currents.filter(row => !usable(row) && valid(row) && row.value === 0);
      if (!currents.every(row => usable(row) || usable(power) && staleZeros.includes(row))) return null;
      const haveVoltage = voltages.every(row => usable(row) && row.raw?.voltageMapping !== 'terminal-pair-unverified');
      const weights = currents.map((row, index) => row.value * (haveVoltage ? voltages[index].value : 1));
      const sum = weights.reduce((total, value) => total + value, 0);
      if (usable(power)) {
        if (sum <= 0) return null; // Positive total with unknown phase split is a gap, not invented phase energy.
        powers = weights.map(value => power.value * value / sum);
        // Assign the rounding remainder to the last phase so total power is conserved.
        powers[2] = Math.max(0, power.value - powers[0] - powers[1]);
        used = [power, ...currents.filter(row => !staleZeros.includes(row)), ...(haveVoltage ? voltages : [])];
        quality.push('reported_active_power', haveVoltage ? 'voltage_current_phase_weights' : 'current_phase_weights');
        if (staleZeros.length) quality.push('last_reported_zero_phase_weights');
      } else if (haveVoltage) {
        powers = weights.map(value => value / 1000);
        used = [...currents, ...voltages];
        quality.push('voltage_current_power_estimate', 'unity_power_factor_assumed');
      } else return null;
    }
    const times = used.map(row => row.sourceTime);
    if (Math.max(...times) - Math.min(...times) > 30_000) quality.push('asynchronous_snapshot');
    if (used.some(row => row.sourceTime < now)) quality.push('last_reported_observations');
    return { device, prefix, at: now, sourceTime: Math.min(...times), powers, quality };
  }
}
