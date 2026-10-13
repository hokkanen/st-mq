import { createHash } from 'node:crypto';
import { validateChargingRuntimeState } from './runtime-state.js';

// Charging owns this representation. The shared Store/journal still sees normal
// state rows and publishes every changed field in one ordinary transaction.
export const CHARGING_RUNTIME_VERSION = 7;
export const CHARGING_VIEW_INTERVAL_MS = 30_000;
const projections = new WeakMap();
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

function validateProjectionDate(view) {
  if (view && Object.hasOwn(view, 'recordedAt') && (!Number.isSafeInteger(view.recordedAt) || view.recordedAt < 0)) fail();
}
const receiptClocks = new Set(['receivedAt', 'readAt', 'lastReadAt', 'lastLiveAt', 'ageMs', 'evaluatedAt', 'recordedAt']);
const electricalFields = new Set(['powerKw', 'actualCurrentA', 'voltageV',
  'phaseCurrentA', 'phasePowerKw', 'phaseVoltageV', 'phaseMeasurements']);
const nativeSignals = new Set(['connected', 'charging', 'currentA', 'availableCurrentA',
  'maxCurrentA', 'maximumCurrentA']);
function withoutReceiptClocks(value) {
  if (Array.isArray(value)) return value.map(withoutReceiptClocks);
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !receiptClocks.has(key))
    .map(([key, value]) => [key, withoutReceiptClocks(value)]));
}
function measurementMetadata(value) {
  if (typeof value === 'number') return { available: Number.isFinite(value) };
  if (Array.isArray(value)) return { phases: value.length, available: value.every(Number.isFinite) };
  if (!object(value)) return value;
  if (!Object.hasOwn(value, 'value')) return withoutReceiptClocks(value);
  const { value: measurement, measuredAt, sourceTime, readback, admittedAt, ...metadata } = value;
  // Derived OCPP phase measurements retain their individual provenance, but
  // another admitted meter timestamp is not a new control/session boundary.
  if (Array.isArray(metadata.inputs)) metadata.inputs = metadata.inputs.map(input => {
    if (!object(input)) return input;
    const { measuredAt, sourceTime, ...context } = input;
    return context;
  });
  return withoutReceiptClocks(metadata);
}
function signalMeaning(value, key) {
  const record = withoutReceiptClocks(value);
  if (!object(record)) return record;
  // Correlated native queries confirm an unchanged setting without renewing
  // its instruction clock. Keep measuredAt, instructionAt and native values.
  if (object(record.readback)) {
    delete record.readback.requestedAt;
    delete record.readback.admittedAt;
  }
  // Shelly's verified hardware maximum is dated by the service/config query,
  // unlike its adjustable currentA setting's native last-change timestamp.
  if (key === 'maximumCurrentA' && record.source === 'shelly-evse') delete record.measuredAt;
  return record;
}
function receptionMeaning(value) {
  const record = withoutReceiptClocks(value);
  if (object(record)) for (const key of ['lastMessageAt', 'lastRetainedAt', 'lastValidAt', 'lastValidLiveAt']) delete record[key];
  return record;
}
function supplyMeaning(value) {
  const record = withoutReceiptClocks(value);
  if (!object(record)) return record;
  // Easee dates this container when the native/property query completes. The
  // contributing measurements keep their own clocks in observationTimes.
  delete record.observedAt;
  for (const key of ['propertyCurrentA', 'reportedPropertyCurrentA', 'chargerCurrentA', 'voltageV'])
    if (Object.hasOwn(record, key)) record[key] = measurementMetadata(record[key]);
  if (object(record.observationTimes)) record.observationTimes = Object.fromEntries(
    Object.entries(record.observationTimes).map(([key, times]) => [key,
      ['property', 'charger', 'voltage', 'allowance'].includes(key) ? measurementMetadata(times) : times]));
  if (object(record.estimate)) {
    // The complete estimate remains an immediate durable charging fragment.
    // Its presentation follows the view cadence; quality/configuration changes
    // still publish early, and plans retain their independent exact fence.
    const { samples, budgetCurrentA, measuredAt, observedAt, ...estimate } = record.estimate;
    record.estimate = { ...estimate, ...(budgetCurrentA !== undefined
      ? { budgetCurrentA: measurementMetadata(budgetCurrentA) } : {}) };
  }
  return record;
}
const phaseMeasurements = new Set(['current', 'voltage', 'power', 'act_energy', 'total_power', 'total_act_energy']);
function phaseMetadata(value) {
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, value]) => [key,
    phaseMeasurements.has(key) && typeof value === 'number' ? { available: Number.isFinite(value) }
      : ['phase_a', 'phase_b', 'phase_c'].includes(key) ? phaseMetadata(value) : value]));
}
function telemetryMeaning(value) {
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !receiptClocks.has(key)
    && !['powerAt', 'powerReceivedAt', 'statusReceivedAt'].includes(key))
    .map(([key, value]) => [key, key === 'phaseMeasurements' ? phaseMetadata(value)
      : electricalFields.has(key) ? measurementMetadata(value)
      : nativeSignals.has(key) ? signalMeaning(value, key)
      : key === 'supply' ? supplyMeaning(value)
      : ['mqtt', 'reception'].includes(key) ? receptionMeaning(value) : withoutReceiptClocks(value)]));
}
function nativeSnapshotMeaning(snapshot) {
  const value = telemetryMeaning(snapshot);
  if (!object(value)) return value;
  // phase_info is metering, not permission, native current, or plug evidence.
  // A correlated query's clocks are bookkeeping; native instruction clocks
  // on the other fields retain their meaning and force early publication.
  delete value.powerAt;
  if (object(snapshot.fields)) value.fields = Object.fromEntries(Object.entries(snapshot.fields).map(([role, field]) => {
    let record = role === 'phase_info' ? measurementMetadata(field) : signalMeaning(field, role);
    if (object(record?.readback)) {
      record = { ...record, readback: { ...record.readback } };
      delete record.readback.requestedAt; delete record.readback.admittedAt;
      if (role === 'phase_info') delete record.readback.measuredAt;
    }
    if (role === 'phase_info' && object(record)) { delete record.admittedAt; delete record.readback; }
    return [role, record];
  }));
  return value;
}
/** Conservative early-publication fence. Only repeated receipt clocks and
 * already-durable metering/progress are allowed to wait for the view cadence.
 * Unknown fields remain in the comparison rather than silently being batched. */
function projectionMeaning(saved) {
  const chargers = Object.fromEntries(Object.entries(saved.chargers ?? {}).map(([id, record]) => {
    const { progress, supplyEstimate, sessionCost, ...durable } = record;
    return [id, { ...durable, ...(progress ? { battery: { connected: progress.connected,
      reference: progress.reference, batteryInputs: progress.batteryInputs } } : {}) }];
  }));
  const { recordedAt, diagnostics, chargers: cards, ...view } = saved.view ?? {};
  if (diagnostics) view.reportStatus = { available: diagnostics.available !== false, error: diagnostics.error ?? null,
    retentionDays: diagnostics.retention?.days };
  if (view.physicalTests) {
    view.physicalTests = structuredClone(view.physicalTests);
    for (const run of view.physicalTests.runs ?? []) delete run.observedAt;
  }
  if (Array.isArray(view.vehicleFeeds)) view.vehicleFeeds = view.vehicleFeeds.map(feed => ({ ...feed,
    ...(feed.reception ? { reception: receptionMeaning(feed.reception) } : {}) }));
  const cardMeaning = (cards ?? []).map(card => {
    const { progress, sessionCost, requiredGridKwh, referenceGridKwh, automaticSoc, automatic,
      telemetry, values, control, ...rest } = card;
    const snapshot = control?.snapshot;
    const projectedControl = control ? { ...control, ...(snapshot ? { snapshot: nativeSnapshotMeaning(snapshot) } : {}) } : control;
    if (projectedControl?.session) {
      projectedControl.session = { ...projectedControl.session }; delete projectedControl.session.observedAt;
    }
    return { ...rest, ...(rest.mqtt ? { mqtt: receptionMeaning(rest.mqtt) } : {}),
      ...(rest.vehicleMqtt ? { vehicleMqtt: receptionMeaning(rest.vehicleMqtt) } : {}),
      control: projectedControl, telemetry: telemetryMeaning(telemetry),
      values: Object.fromEntries(Object.entries(values ?? {}).map(([key, value]) => [key,
        electricalFields.has(key) ? measurementMetadata(value)
          : nativeSignals.has(key) ? signalMeaning(value, key) : withoutReceiptClocks(value)])) };
  });
  return digest(withoutReceiptClocks({ revision: saved.revision, controls: saved.controls, chargers,
    view: { ...view, chargers: cardMeaning } }));
}

function encode(saved) {
  validateChargingRuntimeState(saved);
  validateProjectionDate(saved.view);
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
  validateProjectionDate(saved.view);
  if (saved.view?.reportRetentionDays !== undefined && (!Number.isSafeInteger(saved.view.reportRetentionDays)
    || saved.view.reportRetentionDays < 1 || saved.view.reportRetentionDays > 3650)) fail();
  if (saved.view?.reportStatus !== undefined && (!exact(saved.view.reportStatus, ['available', 'error'])
    || typeof saved.view.reportStatus.available !== 'boolean'
    || saved.view.reportStatus.error !== null && saved.view.reportStatus.error !== 'Session diagnostics could not be saved.')) fail();
  return saved;
}

export function writeChargingRuntime(store, key, saved, { at, viewIntervalMs = CHARGING_VIEW_INTERVAL_MS, forceView = false } = {}) {
  validateChargingRuntimeState(saved);
  validateProjectionDate(saved.view);
  if (at !== undefined && (!Number.isSafeInteger(at) || at < 0)
    || !Number.isSafeInteger(viewIntervalMs) || viewIntervalMs < 0 || typeof forceView !== 'boolean') fail();
  if (store.readOnly) throw new Error('Charging runtime storage is read-only');
  const base = prefix(key), meaning = saved.view && at !== undefined ? projectionMeaning(saved) : null;
  let state = projections.get(store);
  if (!state) { state = new Map(); projections.set(store, state); }
  return store.transaction(() => {
    const previous = store.getState(key);
    if (previous != null) validateManifest(previous);
    else if (store.db.prepare('SELECT 1 FROM state WHERE key=? OR key GLOB ? LIMIT 1').get(key, `${base}*`)) fail();
    const prior = state.get(key);
    const publishView = !saved.view || at === undefined || forceView || !previous?.view || !prior
      || prior.at === undefined || meaning !== prior.meaning || at < prior.at || at - prior.at >= viewIntervalMs;
    const candidate = publishView ? { ...saved, ...(saved.view && at !== undefined
      ? { view: { ...saved.view, recordedAt: at } } : {}) } : { ...saved };
    if (!publishView) delete candidate.view;
    const next = encode(candidate);
    if (!publishView) {
      next.manifest.roots.push('view');
      next.manifest.view = previous.view;
      next.manifest.plans = [...new Set([...next.manifest.plans, ...previous.plans])].sort();
      next.manifest.contexts = [...new Set([...next.manifest.contexts, ...previous.contexts])].sort();
    }
    validateManifest(next.manifest);
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
    if (publishView) {
      store.afterRollback(() => { if (prior) state.set(key, prior); else state.delete(key); });
      state.set(key, { at, meaning });
    }
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
