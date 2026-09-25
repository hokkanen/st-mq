/** Explicit synthetic evidence for planner/adapter unit tests. These assigned
 * statistics isolate scheduling and protocol behavior; learner accuracy is
 * tested independently against the garage plant simulator. */
export function assignGaragePlanningEvidence(model, { at = model.at ?? 0, hours = 4 } = {}) {
  const HOUR = 3_600_000;
  model.rear.active[0] = true;
  model.front.active[0] = true; model.native.active[0] = true;
  model.native.hours = Math.max(24, model.native.hours);
  // This fixture declares observed normal service explicitly. Production
  // seeds remain unknown until a current room setting is selected.
  model.normalReference.roomTargetC ??= 10;
  model.normalReference.interceptC ??= model.normalReference.roomTargetC;
  model.normalReference.frontC ??= model.normalReference.roomTargetC;
  model.normalReference.initialized = true;
  for (const metrics of Object.values(model.heldOut)) Object.assign(metrics,
    { n: 30, hours: 8, absolute: .4, square: .04, signed: 0 });
  model.validation.active = null;
  model.validation.nextId = 3;
  model.validation.episodes = [0, 1, 2].map(id => ({ id, role: id === 2 ? 'validation' : 'training',
    startedAt: at - (4 - id) * 48 * HOUR, endedAt: at - (4 - id) * 48 * HOUR + (hours + Math.max(3, 1.25 * hours)) * HOUR,
    offHours: hours, recoveryHours: Math.max(3, 1.25 * hours), complete: true, clean: true, metered: true,
    thermalPassed: true, electricalPassed: true, trainingSupportHours: id === 2 ? hours : 0,
    rearRmse: .05, frontRmse: .08, rearBias: 0, frontBias: 0, offRearRmse: .05, offFrontRmse: .08,
    rearMaximum: .1, frontMaximum: .16, observedKwh: 1, predictedKwh: 1 }));
  return model;
}
