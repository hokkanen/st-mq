#!/usr/bin/env node
// Independent sensitivity calculation. Never imported by the controller and
// never interpreted as a measured pipe temperature or a safe exposure timer.
import { pathToFileURL } from 'node:url';

export function pipeThermalProperties({ outsideDiameterMm = 21, wallMm = 1,
  insulationMm = 0, insulationWPerMK = .035, surfaceTransferWPerM2K = 10 } = {}) {
  const outside = outsideDiameterMm / 2000, inside = outside - wallMm / 1000;
  if (![outsideDiameterMm, wallMm, insulationMm, insulationWPerMK, surfaceTransferWPerM2K].every(Number.isFinite)
    || inside <= 0 || wallMm <= 0 || insulationMm < 0 || insulationWPerMK <= 0 || surfaceTransferWPerM2K <= 0)
    throw new Error('Invalid pipe sensitivity geometry or material properties');
  const insulated = outside + insulationMm / 1000;
  const waterKgPerM = Math.PI * inside ** 2 * 1000;
  const copperKgPerM = Math.PI * (outside ** 2 - inside ** 2) * 8960;
  const capacityJPerMK = waterKgPerM * 4180 + copperKgPerM * 385;
  const insulationResistance = Math.log(insulated / outside) / (2 * Math.PI * insulationWPerMK);
  const conductanceWPerMK = 1 / (insulationResistance + 1 / (2 * Math.PI * insulated * surfaceTransferWPerM2K));
  return { waterKgPerM, copperKgPerM, capacityJPerMK, conductanceWPerMK,
    latentJPerM: waterKgPerM * 333_550, timeConstantMinutes: capacityJPerMK / conductanceWPerMK / 60 };
}

/** Uniform bulk temperature, fixed surrounding air and surface conductance.
 * Full phase change is a heat-transfer result, never a time-to-damage estimate.
 * Internal water gradients, localized plugs, fittings and axial heat are absent. */
export function pipeCoolingEstimate({ initialC = 10, airC = -10, ...options } = {}) {
  if (!Number.isFinite(initialC) || !Number.isFinite(airC) || initialC < 0 || airC >= 0)
    throw new Error('Cooling estimate requires nonnegative initial water and negative air temperature');
  const properties = pipeThermalProperties(options);
  const bulkZeroMinutes = properties.timeConstantMinutes * Math.log((initialC - airC) / -airC);
  const latentMinutes = properties.latentJPerM / (properties.conductanceWPerMK * -airC) / 60;
  return { ...properties, bulkZeroMinutes, latentMinutes, fullPhaseChangeMinutes: bulkZeroMinutes + latentMinutes };
}

/** Exact constant-air sensible segments with a separate isothermal latent phase.
 * Stops at complete phase change; no post-freeze pressure/damage model exists. */
export function simulatePipePulses({ initialC = 10, segments = [], ...options } = {}) {
  if (!Number.isFinite(initialC) || initialC < 0) throw new Error('Invalid initial water temperature');
  let temperatureC = initialC, iceFraction = 0, minute = 0, bulkZeroAtMinute = null, fullPhaseChangeAtMinute = null;
  let minimumBulkC = initialC, maximumIceFraction = 0;
  const trace = [];
  for (const segment of segments) {
    const { airC, durationMinutes } = segment;
    if (!Number.isFinite(airC) || !Number.isFinite(durationMinutes) || durationMinutes <= 0)
      throw new Error('Invalid air segment');
    const properties = pipeThermalProperties({ ...options,
      ...(segment.surfaceTransferWPerM2K === undefined ? {} : { surfaceTransferWPerM2K: segment.surfaceTransferWPerM2K }) });
    const { timeConstantMinutes: tau, latentJPerM, conductanceWPerMK: conductance } = properties;
    let remaining = durationMinutes;
    if (iceFraction > 0 && airC > 0) {
      const meltMinutes = iceFraction * latentJPerM / (conductance * airC) / 60;
      const elapsed = Math.min(remaining, meltMinutes);
      iceFraction = Math.max(0, iceFraction - elapsed * 60 * conductance * airC / latentJPerM);
      if (remaining >= meltMinutes) iceFraction = 0;
      remaining -= elapsed;
    }
    if (iceFraction === 0 && remaining > 0) {
      const toZero = airC < 0 ? tau * Math.log((temperatureC - airC) / -airC) : Infinity;
      if (toZero <= remaining) {
        if (bulkZeroAtMinute === null) bulkZeroAtMinute = minute + durationMinutes - remaining + toZero;
        temperatureC = 0; remaining -= toZero;
      } else {
        temperatureC = airC + (temperatureC - airC) * Math.exp(-remaining / tau);
        remaining = 0;
      }
    }
    if (airC < 0 && remaining > 0) {
      const freezeMinutes = (1 - iceFraction) * latentJPerM / (conductance * -airC) / 60;
      if (freezeMinutes <= remaining) fullPhaseChangeAtMinute = minute + durationMinutes - remaining + freezeMinutes;
      iceFraction = Math.min(1, iceFraction + remaining * 60 * conductance * -airC / latentJPerM);
    }
    minute += durationMinutes;
    minimumBulkC = Math.min(minimumBulkC, temperatureC); maximumIceFraction = Math.max(maximumIceFraction, iceFraction);
    trace.push({ minute, airC, temperatureC, iceFraction });
    if (fullPhaseChangeAtMinute !== null) break;
  }
  return { bulkZeroAtMinute, fullPhaseChangeAtMinute, minimumBulkC, maximumIceFraction, trace };
}

export function garagePipeSensitivityAudit() {
  const matrix = [];
  for (const wallMm of [.75, 1, 1.5]) for (const insulationMm of [0, 10, 20])
    for (const surfaceTransferWPerM2K of [5, 10, 30, 60]) for (const initialC of [2, 5, 10])
      for (const airC of [-1, -5, -10, -20]) matrix.push({ wallMm, insulationMm, surfaceTransferWPerM2K, initialC, airC,
        ...pipeCoolingEstimate({ wallMm, insulationMm, surfaceTransferWPerM2K, initialC, airC }) });
  const pulses = [];
  for (const initialC of [2, 10]) for (const surfaceTransferWPerM2K of [10, 30, 60])
    for (const durationMinutes of [2, 5, 10]) pulses.push({ initialC, surfaceTransferWPerM2K, durationMinutes,
      ...simulatePipePulses({ initialC, surfaceTransferWPerM2K, segments: [
        { airC: -10, durationMinutes }, { airC: 8, durationMinutes: 60, surfaceTransferWPerM2K: 10 },
      ] }) });
  return { matrix, pulses };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const audit = garagePipeSensitivityAudit();
  const selected = audit.matrix.filter(row => row.wallMm === 1 && row.insulationMm === 0 && row.airC === -10
    && [2, 10].includes(row.initialC));
  process.stdout.write(`${JSON.stringify({ scenarioCount: audit.matrix.length, pulseCount: audit.pulses.length,
    barePipeAtMinus10C: selected, pulses: audit.pulses }, null, 2)}\n`);
}
