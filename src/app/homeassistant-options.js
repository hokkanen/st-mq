const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Supervisor requires object and list containers even when their contents are
// optional. Complete the current schema's empty containers before saving a
// sparse import; never invent a required scalar, translate fields, or enable a
// control. Supplied values are validated separately by validateOptionFields.
export function homeAssistantOptions(options, schema, prefix = '') {
  if (!object(options)) throw new Error(`Invalid Home Assistant configuration section: ${prefix || 'root'}.`);
  const result = structuredClone(options);
  for (const [key, rule] of Object.entries(schema)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const supplied = Object.hasOwn(options, key);
    if (object(rule)) {
      result[key] = homeAssistantOptions(supplied ? options[key] : {}, rule, path);
    } else if (Array.isArray(rule)) {
      if (!supplied && typeof rule[0] === 'string' && rule[0].endsWith('?')) continue;
      const items = supplied ? options[key] : [];
      if (!Array.isArray(items)) throw new Error(`Home Assistant configuration requires an array: ${path}.`);
      result[key] = object(rule[0]) ? items.map(item => homeAssistantOptions(item, rule[0], path)) : structuredClone(items);
    } else if (!supplied && !String(rule).endsWith('?')) {
      throw new Error(`Missing required Home Assistant configuration field: ${path}.`);
    }
  }
  return result;
}
