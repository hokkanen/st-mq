export const FAMILY_FIREWOOD_REMOVAL_MS = 15 * 60_000;

const reads = new Set(['/api/status', '/api/pair', '/api/fireplace', '/api/sensor-changes', '/api/heating/explorer',
  '/api/recording-overview', '/api/energy-audits', '/api/chart', '/api/contract', '/api/events', '/api/history']);
const writes = new Set(['/api/automation', '/api/fireplace', '/api/fireplace/remove', '/api/temporary', '/api/heating/explorer/simulate',
  '/api/heating-test', '/api/dhwr/stop',
  '/api/garage/heating', '/api/equipment/cover', '/api/charging/settings']);

// New endpoints receive no family write or download authority by default.
export function familyRouteAllowed(method, path) {
  return method === 'GET' ? reads.has(path) || /^\/api\/charging\/reports(?:\/[^/]+(?:\/events)?)?$/.test(path)
    : method === 'POST' && (writes.has(path)
    || /^\/api\/charging\/tests\/(preview|start|schedule|target|cancel)$/.test(path)
    || /^\/api\/charging\/chargers\/[^/]+\/(settings|control|resume|use-automatic|charge-now|identify)$/.test(path));
}

export function familyActionAllowed(path, input, engine) {
  if (path === '/api/equipment/cover') {
    const device = engine.equipmentStatus().devices.find(row => row.id === input?.deviceId);
    return device?.area === 'garage' && device.kind === 'door' && device.enabled !== false
      && ['open', 'close', 'stop'].includes(input?.action) && device.controls?.cover?.[input.action] === true;
  }
  if (path === '/api/heating-test')
    return ['normal', 'reduction', 'preheat', 'circulation'].includes(input?.command);
  if (path === '/api/garage/heating') return ['normal', 'away'].includes(input?.mode);
  // Input shape and current device/session authority are checked by each owner.
  return true;
}

export function fireplaceAccess(view, webAccess, now) {
  if (!view) return view;
  return { ...view, entries: (view.entries ?? []).map(entry => {
    const removalUntil = entry.at + FAMILY_FIREWOOD_REMOVAL_MS;
    return { ...entry, canRemove: view.readOnly !== true && entry.removedAt == null && (webAccess.role === 'admin'
      || Number.isSafeInteger(entry.at) && entry.at <= now && now <= removalUntil),
    ...(webAccess.role === 'family' ? { removalUntil } : {}) };
  }) };
}
