import { createHash } from 'node:crypto';
import { validateChargingRuntimeState } from './runtime-state.js';

// Charging owns this representation. The shared Store/journal still sees normal
// state rows and publishes every changed field in one ordinary transaction.
export const CHARGING_RUNTIME_VERSION = 7;
const inputs = /^charging:(mqtt|providers|simulated|offline)$/;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const name = value => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9]*$/.test(value)
  && !['constructor', 'prototype', '__proto__'].includes(value);
const fail = () => { throw new Error('Unsupported or incomplete charging state; preserve this database and use an intact current-version backup or a fresh development database'); };
const exact = (value, keys) => object(value) && Object.keys(value).sort().join(',') === keys.slice().sort().join(',');
const names = values => Array.isArray(values) && values.length <= 128 && values.every(name) && new Set(values).size === values.length;
const hashes = values => Array.isArray(values) && values.length <= 16 && values.every(hash) && new Set(values).size === values.length;
const prefix = key => { if (!inputs.test(key)) fail(); return `${key}:runtime:`; };
const rootFields = ['revision', 'controls', 'consumedTeslaPower', 'consumedTeslaCurrent', 'chargers', 'vehicleFeeds', 'view'];
const mappings = (value, ids) => object(value) && Object.entries(value).every(([id, fields]) => ids.includes(id) && names(fields));
function validateManifest(value) {
  if (!exact(value, ['version', 'roots', 'chargers', 'vehicleFeeds', 'view', 'plans', 'contexts'])
    || value.version !== CHARGING_RUNTIME_VERSION || !names(value.roots) || value.roots.some(field => !rootFields.includes(field))
    || !mappings(value.chargers, ['charger1', 'charger2']) || !mappings(value.vehicleFeeds, ['bmw'])
    || !hashes(value.plans) || !hashes(value.contexts)) fail();
  if (value.view !== null && (!exact(value.view, ['fields', 'chargers']) || !names(value.view.fields)
    || value.view.fields.some(field => ['chargers', 'diagnostics'].includes(field))
    || !mappings(value.view.chargers, ['charger1', 'charger2']))) fail();
  if (value.roots.includes('view') !== (value.view !== null)
    || !value.roots.includes('chargers') && Object.keys(value.chargers).length
    || !value.roots.includes('vehicleFeeds') && Object.keys(value.vehicleFeeds).length) fail();
  return value;
}
function paths(manifest) {
  return [...manifest.roots.filter(field => !['chargers', 'vehicleFeeds', 'view'].includes(field)).map(field => `root/${field}`),
    ...Object.entries(manifest.chargers).flatMap(([id, fields]) => fields.map(field => `charger/${id}/${field}`)),
    ...Object.entries(manifest.vehicleFeeds).flatMap(([id, fields]) => fields.map(field => `vehicle/${id}/${field}`)),
    ...(manifest.view?.fields ?? []).map(field => `view/${field}`),
    ...Object.entries(manifest.view?.chargers ?? {}).flatMap(([id, fields]) => fields.map(field => `view/charger/${id}/${field}`))];
}
const planPath = path => /^(?:charger\/charger[12]\/plan|view\/charger\/charger[12]\/(?:plan|forecast))$/.test(path);
const ownedKeys = (key, manifest) => [...paths(manifest).map(path => prefix(key) + path),
  ...manifest.plans.map(id => `${prefix(key)}plan/${id}`), ...manifest.contexts.map(id => `${prefix(key)}context/${id}`)];

function encode(saved) {
  validateChargingRuntimeState(saved);
  if (saved?.version !== CHARGING_RUNTIME_VERSION) fail();
  const records = new Map(), plans = new Map(), contexts = new Map();
  const put = (path, value) => {
    if (planPath(path) && value != null) {
      if (!object(value)) fail();
      const plan = structuredClone(value), context = [];
      if (Array.isArray(plan.intervals)) plan.intervals = plan.intervals.map((row, index) => {
        const { scenarios, reference, ...compact } = row;
        if (scenarios !== undefined || reference !== undefined) context.push({ index,
          ...(scenarios !== undefined ? { scenarios } : {}), ...(reference !== undefined ? { reference } : {}) });
        return compact;
      });
      const contextId = context.length ? digest(context) : null;
      if (contextId) contexts.set(contextId, context);
      const record = { value: plan, context: contextId }, id = digest(record);
      plans.set(id, record); records.set(path, { value: { ref: id } });
    } else records.set(path, { value });
  };
  const manifest = { version: CHARGING_RUNTIME_VERSION, roots: Object.keys(saved).filter(field => field !== 'version'),
    chargers: {}, vehicleFeeds: {}, view: null, plans: [], contexts: [] };
  for (const field of manifest.roots) {
    if (field === 'chargers' || field === 'vehicleFeeds') {
      const group = field === 'chargers' ? 'charger' : 'vehicle';
      for (const [id, record] of Object.entries(saved[field])) {
        manifest[field][id] = Object.keys(record).filter(name => record[name] !== undefined);
        for (const name of manifest[field][id]) put(`${group}/${id}/${name}`, record[name]);
      }
    } else if (field === 'view') {
      const { chargers, diagnostics, ...view } = saved.view;
      if (diagnostics) {
        view.reportRetentionDays = diagnostics.retention.days;
        view.reportStatus = { available: diagnostics.available !== false, error: diagnostics.error ?? null };
      }
      manifest.view = { fields: Object.keys(view).filter(name => view[name] !== undefined), chargers: {} };
      for (const name of manifest.view.fields) put(`view/${name}`, view[name]);
      for (const record of chargers) {
        if (Object.hasOwn(manifest.view.chargers, record.id)) fail();
        manifest.view.chargers[record.id] = Object.keys(record).filter(name => record[name] !== undefined);
        for (const name of manifest.view.chargers[record.id]) put(`view/charger/${record.id}/${name}`, record[name]);
      }
    } else put(`root/${field}`, saved[field]);
  }
  manifest.plans = [...plans.keys()].sort(); manifest.contexts = [...contexts.keys()].sort();
  validateManifest(manifest);
  return { manifest, records, plans, contexts };
}

/** One current format. No old aggregate reader or automatic conversion exists. */
export function readChargingRuntime(store, key) {
  const root = store.getState(key);
  if (root == null) {
    if (store.db?.prepare('SELECT 1 FROM state WHERE key=? OR key GLOB ? LIMIT 1').get(key, `${prefix(key)}*`)) fail();
    return null;
  }
  const manifest = validateManifest(root), plans = new Map(), usedPlans = new Set(), usedContexts = new Set();
  const read = path => {
    const record = store.getState(prefix(key) + path);
    if (!exact(record, ['value'])) fail();
    if (!planPath(path) || record.value === null) return record.value;
    if (!exact(record.value, ['ref']) || !manifest.plans.includes(record.value.ref)) fail();
    const id = record.value.ref; usedPlans.add(id);
    if (!plans.has(id)) {
      const plan = store.getState(`${prefix(key)}plan/${id}`);
      if (!exact(plan, ['value', 'context']) || !object(plan.value) || digest(plan) !== id
        || plan.context !== null && !manifest.contexts.includes(plan.context)) fail();
      const expanded = structuredClone(plan.value);
      if (plan.context !== null) {
        usedContexts.add(plan.context);
        const context = store.getState(`${prefix(key)}context/${plan.context}`);
        if (!Array.isArray(context) || !context.length || digest(context) !== plan.context || !Array.isArray(expanded.intervals)) fail();
        const seen = new Set();
        for (const row of context) {
          if (!object(row) || Object.keys(row).some(field => !['index', 'scenarios', 'reference'].includes(field))
            || !Number.isSafeInteger(row.index) || row.index < 0 || row.index >= expanded.intervals.length
            || seen.has(row.index) || !Object.hasOwn(row, 'scenarios') && !Object.hasOwn(row, 'reference')) fail();
          seen.add(row.index);
          const { index, ...fields } = row;
          if (Object.keys(fields).some(field => Object.hasOwn(expanded.intervals[index], field))) fail();
          Object.assign(expanded.intervals[index], fields);
        }
      }
      plans.set(id, expanded);
    }
    return structuredClone(plans.get(id));
  };
  const saved = { version: CHARGING_RUNTIME_VERSION };
  for (const field of manifest.roots) {
    if (field === 'chargers' || field === 'vehicleFeeds') {
      const group = field === 'chargers' ? 'charger' : 'vehicle';
      saved[field] = Object.fromEntries(Object.entries(manifest[field]).map(([id, fields]) => [id,
        Object.fromEntries(fields.map(name => [name, read(`${group}/${id}/${name}`)]))]));
    } else if (field === 'view') {
      saved.view = Object.fromEntries(manifest.view.fields.map(name => [name, read(`view/${name}`)]));
      saved.view.chargers = Object.entries(manifest.view.chargers).map(([id, fields]) => {
        const record = Object.fromEntries(fields.map(name => [name, read(`view/charger/${id}/${name}`)]));
        if (record.id !== id) fail();
        return record;
      });
    } else saved[field] = read(`root/${field}`);
  }
  if (usedPlans.size !== manifest.plans.length || usedContexts.size !== manifest.contexts.length) fail();
  validateChargingRuntimeState(saved);
  if (saved.view?.reportRetentionDays !== undefined && (!Number.isSafeInteger(saved.view.reportRetentionDays)
    || saved.view.reportRetentionDays < 1 || saved.view.reportRetentionDays > 3650)) fail();
  if (saved.view?.reportStatus !== undefined && (!exact(saved.view.reportStatus, ['available', 'error'])
    || typeof saved.view.reportStatus.available !== 'boolean'
    || saved.view.reportStatus.error !== null && saved.view.reportStatus.error !== 'Session diagnostics could not be saved.')) fail();
  return saved;
}

export function writeChargingRuntime(store, key, saved) {
  const next = encode(saved), base = prefix(key);
  return store.transaction(() => {
    const previous = store.getState(key);
    if (previous != null) validateManifest(previous);
    else if (store.db.prepare('SELECT 1 FROM state WHERE key=? OR key GLOB ? LIMIT 1').get(key, `${base}*`)) fail();
    const retained = new Set(ownedKeys(key, next.manifest));
    for (const [kind, entries] of [['context', next.contexts], ['plan', next.plans]])
      for (const [id, record] of entries) {
        const recordKey = `${base}${kind}/${id}`;
        // Content-addressed records are immutable. Avoid loading/serializing a
        // large unchanged context on every device receipt just to compare it.
        if (!store.db.prepare('SELECT 1 FROM state WHERE key=?').get(recordKey)) store.setState(recordKey, record);
      }
    for (const [path, record] of next.records) store.setState(base + path, record);
    store.setState(key, next.manifest);
    if (previous) for (const obsolete of ownedKeys(key, previous)) if (!retained.has(obsolete))
      store.db.prepare('DELETE FROM state WHERE key=?').run(obsolete);
  });
}

/** Read-only preflight includes inactive inputs and orphan fragments. */
export function validateChargingRuntimeStorage(db) {
  const store = { db, getState: key => { const row = db.prepare('SELECT value FROM state WHERE key=?').get(key); return row ? JSON.parse(row.value) : null; } };
  const roots = db.prepare("SELECT key FROM state WHERE key IN ('charging:mqtt','charging:providers','charging:simulated','charging:offline')").all();
  const expected = new Set();
  for (const { key } of roots) {
    readChargingRuntime(store, key);
    for (const part of ownedKeys(key, validateManifest(store.getState(key)))) expected.add(part);
  }
  for (const { key } of db.prepare("SELECT key FROM state WHERE key GLOB 'charging:*:runtime:*'").iterate())
    if (!expected.has(key)) fail();
}
