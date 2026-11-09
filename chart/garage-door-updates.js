/** Merge only live door evidence; other equipment and unsaved controls keep their owners. */
export function mergeDoorUpdate(status, update) {
  if (!status || status.input !== update?.input || !update.equipment?.doorRevision) return status;
  const current = status.equipment?.doorRevision, next = update.equipment.doorRevision;
  if (current?.generation === next.generation && current.revision > next.revision) return status;
  return { ...status, now: Math.max(status.now, update.now), equipment: { ...status.equipment,
    doorRevision: next, devices: [...(status.equipment?.devices ?? []).filter(d => d.kind !== 'door'),
      ...update.equipment.devices.filter(d => d.kind === 'door')] } };
}

export function retainNewerDoors(result, latest, atRequest) {
  const next = result?.equipment?.doorRevision, current = latest?.equipment?.doorRevision;
  if (!next || !current || result.input !== latest.input) return result;
  const older = next.generation === current.generation ? next.revision < current.revision
    : atRequest?.equipment?.doorRevision?.generation === next.generation
      && atRequest.equipment.doorRevision !== current;
  return older ? mergeDoorUpdate({ ...result, equipment: { ...result.equipment, doorRevision: undefined } },
    { input: latest.input, now: latest.now, equipment: latest.equipment }) : result;
}

/** One held read, renewed without refreshing the dashboard while idle. */
export function createGarageDoorWatch({ request, enabled, onUpdate, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let controller, timer, revision, failures = 0, generation = 0;
  const stop = () => { ++generation; controller?.abort(); controller = null; clearTimer(timer); timer = null; revision = undefined; };
  async function read(run) {
    if (run !== generation || !enabled()) return;
    controller = new AbortController();
    let delay = 0;
    try {
      const update = await request(`/api/garage/doors/watch${revision ? `?revision=${encodeURIComponent(revision)}` : ''}`, undefined, { signal: controller.signal });
      if (run !== generation || !enabled()) return;
      revision = update.revision; failures = 0;
      if (update.equipment) onUpdate(update);
    } catch (error) {
      if (run !== generation || !enabled()) return;
      delay = Math.min(15_000, 1000 * 2 ** Math.min(failures++, 4));
    } finally {
      if (run === generation) {
        controller = null;
        if (enabled()) timer = setTimer(() => { timer = null; void read(run); }, delay);
      }
    }
  }
  return { stop, update() {
    if (!enabled()) { stop(); return; }
    if (!controller && !timer) void read(generation);
  } };
}
