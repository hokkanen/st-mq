import { predictThermalStep } from '../control/adaptive-learning.js';
import { estimateHeatPumpPerformance } from '../domain/heat-pump-performance.js';
import { auxiliaryPowerFromOutput } from '../domain/telemetry.js';

const HOUR = 3600000;
const finite = Number.isFinite;
export function controlObservations({ latest, now, observations, outlook, checkpoint, phase, roomBoostC = 0, config, h66 }) {
  const fresh = (signal, age = 300000) => {
    const o = latest[signal];
    return o && finite(o.value) && o.sourceTime <= now && now - o.sourceTime <= age
      && (o.source === 'husdata-h66' ? o.raw?.usableForControl === true : !(o.quality ?? []).some(q => !['good','simulated','estimated','current_snapshot_not_energy'].includes(q))) ? o : null;
  };
  const value = signal => fresh(signal)?.value ?? null;
  const w = outlook.forecast.find(row => row.start <= now && row.end > now);
  const issuedAt = w?.issuedAt ?? w?.fetchedAt;
  const weatherFresh = finite(issuedAt) && issuedAt <= now && now - issuedAt <= 6 * HOUR;
  const radiation = weatherFresh && finite(w?.solarRadiationWm2) ? w.solarRadiationWm2 : null;
  const indoorC = observations.indoor?.stale ? null : observations.indoor?.value ?? null;
  const outdoorC = !observations.outdoor?.stale && finite(observations.outdoor?.value) ? observations.outdoor.value : null;
  const h = h66 ?? {}, connected = h.connected ?? h.brokerConnected;
  const compressor = connected ? value('compressor_active') : null, route = connected ? value('dhw_routing') : null;
  const output = connected ? value('auxiliary_output') : null;
  const integral = connected ? value('heating_integral') : null;
  const supply = connected ? value('supply_temperature') : null, targetSupply = connected ? value('heating_setpoint') : null;
  const currentMode = connected ? value('operating_mode') : null;
  const nativeMode = connected ? h.baseline?.['2201'] ?? currentMode : null;
  const equipment = { observedPhase: phase,externalChangeRevision:h.externalChangeRevision??0,
    h66Available: h.controlsReady === true && h.writesEnabled === true,
    preheatAvailable: h.controlsReady === true && h.writesEnabled === true,
    nativeAuxAllowed: nativeMode === 2 ? false : nativeMode === 1 ? true : null,
    roomSettingC: h.baseline?.['0203'] ?? h.readings?.['0203']?.value ?? null,
    supplyC: supply, normalSupplyC: finite(supply) ? supply - (phase === 'preheat' ? 3 * roomBoostC : 0) : null,
    observedRoomBoostC: phase === 'preheat' ? roomBoostC : 0, brineC: value('brine_in_temperature'),
    integral, supplyShortfallC: finite(supply) && finite(targetSupply) ? targetSupply - supply : null,
    compressorOn: compressor, dhwRouting: route, alarmActive: connected && value('alarm_active') === 1,
    operatingMode: connected ? value('operating_mode') : null };
  if (observations.actual?.source === 'simulation') Object.assign(equipment, {
    h66Available:true,preheatAvailable:true,compressorOn:observations.actual.compressorDuty,
    dhwRouting:observations.actual.auxRoute==='dhw'?1:0,nativeAuxAllowed:true,
  });
  let predicted = null;
  if (finite(indoorC) && finite(outdoorC)) predicted = predictThermalStep(checkpoint.model,
    { indoorC, reserveC: checkpoint.state?.reserveC ?? indoorC, slabC: checkpoint.state?.slabC }, { outdoorC, solarRadiationWm2: radiation,
      targetC: checkpoint.baselineC ?? indoorC, phase, roomBoostC, supplyC: supply, brineC: equipment.brineC }, 1 / 60);
  const compressorDuty = observations.actual?.source === 'simulation' ? observations.actual.compressorDuty
    : compressor ?? predicted?.compressorDuty ?? null;
  const auxiliaryObserved = output !== null || observations.actual?.source === 'simulation';
  const auxiliaryPower = auxiliaryPowerFromOutput(output, config.auxRatedKw);
  const auxKw = observations.actual?.source === 'simulation' ? observations.actual.auxKw ?? 0 : auxiliaryPower?.kw ?? null;
  // A dedicated power observation may replace nominal component estimates. Whole-house current never does.
  const meter = fresh('heat_pump_meter_power');
  const simulation = observations.actual?.source === 'simulation';
  const powerBasis = simulation ? 'simulated' : meter ? 'measured' : compressor !== null ? 'observed'
    : finite(compressorDuty) ? 'modelled' : 'unknown';
  const powerInput = meter ?? (powerBasis === 'observed' ? fresh('compressor_active') : null);
  const source = estimateHeatPumpPerformance({ supplyC: supply, brineC: equipment.brineC, modelConfirmed: config.heatPumpModelConfirmed });
  const powerKw = meter ? meter.value : finite(compressorDuty) ? compressorDuty * source.electricalKw
    + (auxKw ?? (currentMode === 2 ? 0 : (phase === 'recovery' ? 0.03 : 0.015) * config.auxRatedKw * (checkpoint.model.energy.auxiliaryRiskScale ?? 1)))
    + (source.pumpsIncluded ? 0 : config.circulationKw * compressorDuty) : null;
  const priceRow = outlook.prices.find(row => row.start <= now && row.end > now);
  const price = priceRow?.allInCentsPerKWh ?? null;
  const sample = { timestamp: now, indoorC, outdoorC, supplyC: supply, brineC: equipment.brineC, solarRadiationWm2: radiation, phase, roomBoostC,
    targetC: checkpoint.baselineC, quality: finite(indoorC) && finite(outdoorC) ? [] : ['missing'],
    powerKw: observations.actual?.source === 'simulation' ? observations.actual.powerKw : powerKw,
    powerBasis, powerSourceTime: simulation || powerBasis === 'modelled' ? now
      : powerInput?.sourceTime ?? null,
    powerReceivedAt: simulation || powerBasis === 'modelled' ? now
      : powerInput?.receivedAt ?? null,
    auxiliaryAssumed: !simulation && !meter && auxKw === null,
    compressorPowerKw: source.electricalKw, compressorDuty,
    thermalCompressorDuty: compressor !== null && route !== null ? (route === 0 ? compressor : 0) : null,
    thermalAuxKw: auxKw !== null && route !== null ? (route === 0 ? auxKw : 0) : null,
    auxKw, auxRoute: observations.actual?.source === 'simulation' ? observations.actual.auxRoute : route === 1 ? 'dhw' : route === 0 ? 'space' : 'unknown',
    auxiliaryStage: auxiliaryPower?.stage ?? null, auxiliaryPowerBasis: auxiliaryPower?.basis ?? 'simulation',
    compressorActivityObserved: compressor !== null || observations.actual?.source === 'simulation',
    auxiliaryObserved, auxiliaryRouteKnown: route !== null || observations.actual?.source === 'simulation',
    energyBasis: meter ? 'measured' : 'estimated', priceCents: price, priceStart:priceRow?.start, priceEnd:priceRow?.end,
    actualModeKnown: observations.actual?.verified === true,
    heating: { verified:compressor !== null && route !== null, compressorActive:compressor===1, route:route===1?'dhw':route===0?'space-heating':'unknown',quality:[] } };
  return { sample, equipment, radiation, weather: w };
}

export function deriveChargerPower(latest, now) {
  const rows = [1,2,3].map(i => latest[`ev1_current_l${i}`]);
  if (rows.some(o => !o || !finite(o.value) || o.value < 0 || o.value > 1000 || !finite(o.sourceTime)
    || o.sourceTime > now || now - o.sourceTime > 300000
    || (o.quality ?? []).some(q => !['good','estimated','current_snapshot_not_energy'].includes(q)))) return null;
  if (Math.max(...rows.map(o => o.sourceTime)) - Math.min(...rows.map(o => o.sourceTime)) > 60000) return null;
  return { source: 'controller-estimate', device: 'ev1', signal: 'charger_power',
    value: rows.reduce((sum,o) => sum+o.value,0) * 230 / 1000, unit: 'kW', sourceTime: Math.min(...rows.map(o => o.sourceTime)),
    receivedAt: now, quality: ['estimated'], raw: { basis: 'Three coherent phase currents × nominal 230 V; not an energy meter', powerBasis: 'currents',
      phaseTimes: rows.map(o => o.sourceTime) } };
}
