import assert from 'node:assert/strict';

const types = { current_limit: 'number', start_charging: 'boolean', work_state: 'enum', phase_info: 'object' };

// Synthetic device wire response. Build only requested rows so a control read
// cannot accidentally run a fixture's physical or notification side effects.
export function shellyComponentReply(keys, { service, serviceStatus, components, status }) {
  return { cfg_rev: 1, offset: 0, total: keys.length, components: keys.map(key => {
    if (key === `service:${service.id}`) return { key, config: structuredClone(service), status: structuredClone(serviceStatus) };
    const role = Object.keys(components).find(role => `${types[role]}:${components[role].id}` === key);
    assert(role, 'Synthetic device received an unknown component key');
    return { key, attrs: { owner: `service:${service.id}`, role }, config: structuredClone(components[role]), status: status(role) };
  }) };
}
