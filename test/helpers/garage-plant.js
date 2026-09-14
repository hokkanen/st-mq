/** Independent simulation fixture. This file deliberately imports no garage model.
 * Temperatures are air/mass nodes, never claimed to be pipe temperature. */
export const HOUR = 3_600_000;
export const AUDIT_START = Date.parse('2026-01-01T00:00:00Z');
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
export function randomSource(seed = 731) {
  let value = seed >>> 0;
  return () => { value = (1664525 * value + 1013904223) >>> 0; return value / 4294967296; };
}
export const PLANT_DEFAULTS = Object.freeze({ loss: .025, memoryExchange: .085,
  memoryHours: 23, slabExchange: .025, slabHours: 65, frontRelaxation: .65,
  frontLoss: .010, heatResponse: .72, demand: .65, noiseC: .025, quantizationC: .05,
  weatherOffsetC: 0, doors: false, doorContacts: true, ev: false, gaps: false,
  activityOnly: false, booleanActivity: false });
export function outdoorAt(hour, parameters = {}) {
  return -4 + (parameters.weatherOffsetC ?? 0) + 6 * Math.sin(hour / 61)
    + 2 * Math.sin(hour * Math.PI / 12) + 3 * Math.sin(hour / 193);
}
export function createPlant(parameters = {}) {
  return { parameters: { ...PLANT_DEFAULTS, ...parameters }, state: {
    rearC: 7, frontC: 6.6, coreC: 7, slabC: 7, deliveredKw: .3 },
  };
}
export function plantInputs(plant, hour, { available = true, disturbance = true } = {}) {
  const p = plant.parameters, outdoorC = outdoorAt(hour, p);
  const targetC = 7 + .025 * outdoorC;
  const demand = targetC - plant.state.rearC;
  const powerKw = available ? clamp((.29 + .014 * Math.max(0, -outdoorC) + p.demand * demand)
    * clamp((demand + .35) / .35, 0, 1), 0, 2.1) : 0;
  const minuteOfDay = Math.floor((hour % 24) * 60 + 1e-6);
  const day = Math.floor(hour / 24);
  const doorFront = disturbance && p.doors && day % 3 === 1 && minuteOfDay >= 1065 && minuteOfDay < 1071;
  const doorRear = disturbance && p.doors && day % 11 === 4 && minuteOfDay >= 470 && minuteOfDay < 474;
  const ev1Kw = disturbance && p.ev && day % 3 === 0 && hour % 24 >= 20 && hour % 24 < 23 ? 7 : 0;
  const ev2Kw = disturbance && p.ev && day % 4 === 2 && hour % 24 >= 1 && hour % 24 < 4 ? 5 : 0;
  return { outdoorC, available, powerKw, activity: clamp(powerKw / .8, 0, 1),
    ev1Kw, ev2Kw, doorFront, doorRear, baselineVerified: true, powerQuality: 'simulated' };
}
/** Advance physical equations at one minute or finer, with two different slow
 * masses, direct inter-room coupling, COP/weather mismatch and heat-output lag. */
export function stepPlant(plant, input, hours = 1 / 60) {
  const p = plant.parameters, s = plant.state, dt = hours;
  const copFactor = clamp(1 + .010 * (input.outdoorC + 4), .7, 1.2);
  const delivered = input.available ? input.powerKw * copFactor : 0;
  const heat = p.heatResponse * s.deliveredKw;
  const rearRate = p.loss * (input.outdoorC - s.rearC) + p.memoryExchange * (s.coreC - s.rearC)
    + p.slabExchange * (s.slabC - s.rearC) + .02 * (s.frontC - s.rearC) + heat
    + .018 * input.ev1Kw + .029 * input.ev2Kw + (input.doorRear ? 2.5 * (input.outdoorC - s.rearC) : 0);
  const frontRate = rearRate + p.frontRelaxation * (s.rearC - s.frontC)
    + p.frontLoss * (input.outdoorC - s.frontC) + .065 * s.deliveredKw
    + .006 * input.ev1Kw - .003 * input.ev2Kw
    + (input.doorFront ? 7 * (input.outdoorC - s.frontC) : 0);
  plant.state = { rearC: s.rearC + rearRate * dt, frontC: s.frontC + frontRate * dt,
    coreC: s.coreC + ((s.rearC - s.coreC) / p.memoryHours + .0008 * (input.outdoorC - s.coreC)) * dt,
    slabC: s.slabC + (s.rearC - s.slabC) / p.slabHours * dt,
    deliveredKw: s.deliveredKw + (delivered - s.deliveredKw) * Math.min(1, dt / .09) };
  return input.powerKw * dt;
}
export function observedPlant(plant, hour, input, random = () => .5) {
  const p = plant.parameters;
  const measure = value => {
    const noisy = value + (random() + random() + random() - 1.5) * 2 * p.noiseC;
    return p.quantizationC ? Math.round(noisy / p.quantizationC) * p.quantizationC : noisy;
  };
  return { at: AUDIT_START + hour * HOUR, rearC: measure(plant.state.rearC),
    frontC: measure(plant.state.frontC), ...input, sourceEpoch: 'independent-plant-v1',
    ...(p.activityOnly ? { powerKw: null, powerQuality: null } : {}),
    ...(p.booleanActivity ? { activity: input.activity > .02 } : {}),
    ...(p.doorContacts === false ? { doorFront: null, doorRear: null } : {}) };
}
export function pauseSchedule(hour, frequency = 'three-weekly') {
  const period = frequency === 'three-weekly' ? 56 : frequency === 'weekly' ? 168 : 336;
  const index = Math.floor(Math.max(0, hour - 40) / period), since = hour - 40 - index * period;
  const duration = [2, 4, 8][index % 3];
  return { available: since < 0 || since >= duration, recovering: since >= duration && since < duration + 24,
    managedPause: since >= 0 && since < duration, duration };
}
export function observationGap(hour, parameters) {
  return parameters.gaps && Math.floor(hour / 24) % 9 === 5 && hour % 24 >= 11 && hour % 24 < 14;
}
