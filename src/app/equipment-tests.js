import { createWriteScope } from '../storage/write-scope.js';
import { validateEquipmentTestState } from '../domain/equipment-test-state.js';

const KEY = 'equipment-tests:v1';
const MINUTE = 60_000, RETRY_MS = 5000;
const timestamp = value => Number.isSafeInteger(value) && value >= 0;
const signatureValid = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const idValid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const messages = {
  EQUIPMENT_TEST_CLOSED: 'Equipment control is closed.',
  EQUIPMENT_TEST_BUSY: 'An equipment operation is already in progress.',
  EQUIPMENT_TEST_ACTIVE: 'Restore the current equipment test before starting another.',
  EQUIPMENT_TEST_INPUT: 'Choose a switch, ON or OFF, and a whole duration from 1 to 15 minutes.',
  EQUIPMENT_TEST_UNAVAILABLE: 'This equipment is unavailable for manual control.',
  EQUIPMENT_TEST_TARIFF: 'Heating reduction relays must use the heating controls.',
  EQUIPMENT_TEST_STATE: 'A fresh confirmed switch state is required before manual control.',
  EQUIPMENT_TEST_AUTHORITY: 'This instance does not own equipment control.',
  EQUIPMENT_TEST_ROUTE: 'The original equipment connection is unavailable or has changed. Restoration is pending.',
  EQUIPMENT_TEST_UNCONFIRMED: 'The switch command is unconfirmed. Restoring its previous state is still required.',
  EQUIPMENT_TEST_RESTORE: 'The previous switch state could not be confirmed. Restoration is pending.',
  EQUIPMENT_TEST_STORAGE: 'Equipment test state could not be saved. Restoration may still be required.',
  EQUIPMENT_TEST_NOT_STARTED: 'The test could not start. No switch command was sent.',
  EQUIPMENT_SWITCH_INPUT: 'Choose a configured switch and ON or OFF.',
  EQUIPMENT_SWITCH_UNCONFIRMED: 'The requested switch state was not confirmed. Check the live state before trying again.',
  EQUIPMENT_SWITCH_INTERRUPTED: 'The application restarted before confirming this switch command. Check the live state.',
  EQUIPMENT_SWITCH_STORAGE: 'The switch request could not be saved.',
  EQUIPMENT_SWITCH_ROUTE: 'The equipment connection is unavailable or has changed. Check its live state.',
};
const failure = code => Object.assign(new Error(messages[code]), { code });
const publicActive = active => active ? Object.fromEntries(['deviceId', 'on', 'previousOn', 'until', 'status'].map(key => [key, active[key]])) : null;
const SUPERSEDED_REASON = 'The switch was changed independently after a test that left its state unchanged.';
function publicResult(result) {
  if (!result || !idValid(result.deviceId) || !['starting', 'active', 'restoration-pending', 'restored', 'superseded', 'not-started'].includes(result.status)) return null;
  const visible = { deviceId: result.deviceId, status: result.status };
  for (const key of ['on', 'previousOn', 'confirmed', 'sent']) if (typeof result[key] === 'boolean') visible[key] = result[key];
  for (const key of ['at', 'until']) if (timestamp(result[key])) visible[key] = result[key];
  if (Object.hasOwn(messages, result.code)) { visible.code = result.code; visible.reason = messages[result.code]; }
  else if (result.status === 'superseded') visible.reason = SUPERSEDED_REASON;
  else if (['manual', 'expiry', 'startup', 'shutdown', 'settings-reload'].includes(result.reason)) visible.reason = result.reason;
  return visible;
}
function publicManual(result) {
  if (!result || !idValid(result.deviceId) || !['pending', 'confirmed', 'unconfirmed'].includes(result.status)) return null;
  const visible = { deviceId: result.deviceId, status: result.status };
  for (const key of ['on', 'previousOn', 'confirmed', 'sent']) if (typeof result[key] === 'boolean') visible[key] = result[key];
  for (const key of ['at', 'confirmedAt']) if (timestamp(result[key])) visible[key] = result[key];
  if (Object.hasOwn(messages, result.code)) { visible.code = result.code; visible.reason = messages[result.code]; }
  return visible;
}

function freshState(device, now) {
  if (!device?.available) return null;
  const readings = Object.values(device.readings ?? {}).filter(row => row?.unit === 'state');
  if (readings.length !== 1) return null;
  const row = readings[0];
  return [0, 1].includes(row.value) && row.stale === false && timestamp(row.observedAt) && row.observedAt <= now
    ? Boolean(row.value) : null;
}

/** Explicit, bounded manual switch tests. The saved route is checked again for
 * restoration; neither a broker acknowledgement nor a renamed device transfers
 * this obligation to another output. Construction never sends a command. */
export function createEquipmentTests({ store, clock = Date.now, getEquipment, canControl = () => false, report } = {}) {
  let state = store.getState(KEY) ?? { version: 1, active: null, lastResult: null };
  validateEquipmentTestState(state);
  const saved = state.active;
  state = structuredClone(state);
  // A direct manual request is never replayed or reversed after a restart.
  if (state.lastManual?.status === 'pending') state.lastManual = { ...state.lastManual,
    status: 'unconfirmed', confirmed: false, code: 'EQUIPMENT_SWITCH_INTERRUPTED' };
  let startupRestore = Boolean(saved), pending = null, timer = null, closed = false, closing = false, stopping = false, retryAt = 0;
  const writes = createWriteScope({ runWrite: (operation, options) => store.runWrite(operation, options) });
  let unissued = null;
  const authority = () => { try { return canControl() === true; } catch { return false; } };
  const adapter = () => { try { return getEquipment?.() ?? null; } catch { return null; } };
  const devices = equipment => { try { const list = equipment?.status?.()?.devices; return Array.isArray(list) ? list : []; } catch { return []; } };
  const route = (equipment, id) => { try { return equipment?.signature?.(id) ?? null; } catch { return null; } };
  const notify = result => { try { report?.({ type: 'equipment-test', ...result }); } catch { /* Reporting cannot interrupt restoration. */ } };
  const persist = (next, beforeSave = () => {}) => writes.run(() => {
    beforeSave();
    validateEquipmentTestState(next);
    const previous = state;
    store.afterRollback?.(() => { state = previous; });
    store.setState(KEY, structuredClone(next)); state = next;
  }, { priority: 'control' });
  const record = (active, status, extras = {}) => ({ deviceId: active.deviceId, on: active.on,
    previousOn: active.previousOn, at: clock(), status, ...extras });
  async function markPending(code) {
    if (!state.active) return;
    const active = { ...state.active, status: 'restoration-pending' };
    const lastResult = record(active, 'restoration-pending', { code, reason: messages[code], confirmed: false });
    const next = { ...state, active, lastResult };
    try { await persist(next); } catch { state = next; /* The pre-command obligation remains on disk. */ }
    retryAt = clock() + RETRY_MS;
    notify(lastResult);
  }
  function arm() {
    clearTimeout(timer); timer = null;
    if (closed || stopping || !state.active) return;
    const due = startupRestore || state.active.status === 'restoration-pending' ? Math.max(clock(), retryAt) : state.active.until;
    timer = setTimeout(() => { timer = null; void api.tick(); }, Math.max(1000, due - clock()));
    timer.unref?.();
  }
  async function exclusive(operation) {
    if (closed) throw failure('EQUIPMENT_TEST_CLOSED');
    if (pending) throw failure('EQUIPMENT_TEST_BUSY');
    const completion = Promise.resolve().then(operation);
    pending = completion;
    try { return await completion; }
    finally { pending = null; arm(); }
  }
  function checkRoute(active, equipment) {
    if (!authority()) throw failure('EQUIPMENT_TEST_AUTHORITY');
    if (!equipment || typeof equipment.setSwitch !== 'function' || route(equipment, active.deviceId) !== active.signature)
      throw failure('EQUIPMENT_TEST_ROUTE');
  }
  async function discardUnissued() {
    const lastResult = record(unissued, 'not-started', { confirmed: false, sent: false, code: 'EQUIPMENT_TEST_NOT_STARTED' });
    try {
      await persist({ ...state, active: null, lastResult });
      unissued = null; startupRestore = false; retryAt = 0; notify(lastResult);
      return { ...lastResult, restorationPending: false };
    } catch {
      // Retrying storage cannot turn a known unissued command into permission
      // to overwrite an independently changed switch with its old baseline.
      startupRestore = true; retryAt = clock() + RETRY_MS;
      throw failure('EQUIPMENT_TEST_STORAGE');
    }
  }
  async function restoreInternal(reason) {
    const active = state.active;
    if (!active) return { status: 'idle', restorationPending: false };
    if (unissued && active.requestedAt === unissued.requestedAt && active.signature === unissued.signature
      && active.deviceId === unissued.deviceId) return discardUnissued();
    const equipment = adapter();
    try {
      checkRoute(active, equipment);
      const device = devices(equipment).find(row => row.id === active.deviceId);
      const observedAfterConfirmation = active.status === 'active' && timestamp(active.confirmedAt)
        && Object.values(device?.readings ?? {}).some(row => row?.unit === 'state' && row.observedAt > active.confirmedAt);
      const current = observedAfterConfirmation ? freshState(device, clock()) : null;
      // A fresh observation of the original state already fulfils restoration.
      // A test that never changed state does not own a later external change.
      // An observation received during an uncertain command cannot prove that
      // the device did not apply that command afterward. Restore explicitly.
      const superseded = active.on === active.previousOn && current !== null && current !== active.on;
      let sent = false;
      if (current !== active.previousOn && !superseded) {
        const result = await equipment.setSwitch(active.deviceId, active.previousOn);
        if (result?.confirmed !== true) throw failure('EQUIPMENT_TEST_RESTORE');
        sent = true;
      }
      checkRoute(active, adapter());
      const lastResult = record(active, superseded ? 'superseded' : 'restored', { confirmed: true, sent,
        reason: superseded ? SUPERSEDED_REASON : reason });
      await persist({ ...state, active: null, lastResult });
      startupRestore = false; retryAt = 0; notify(lastResult);
      return { ...lastResult, restorationPending: false };
    } catch (error) {
      const code = ['EQUIPMENT_TEST_AUTHORITY', 'EQUIPMENT_TEST_ROUTE'].includes(error?.code) ? error.code : 'EQUIPMENT_TEST_RESTORE';
      await markPending(code); throw failure(code);
    }
  }
  const api = {
    setSwitch(input) {
      if (closing || stopping) return Promise.reject(failure('EQUIPMENT_TEST_CLOSED'));
      return exclusive(async () => {
        if (!input || typeof input !== 'object' || Array.isArray(input)
          || Object.keys(input).some(key => !['deviceId', 'on'].includes(key))
          || !idValid(input.deviceId) || typeof input.on !== 'boolean') throw failure('EQUIPMENT_SWITCH_INPUT');
        if (state.active) throw failure('EQUIPMENT_TEST_ACTIVE');
        if (!authority()) throw failure('EQUIPMENT_TEST_AUTHORITY');
        const equipment = adapter(), device = devices(equipment).find(row => row.id === input.deviceId);
        if (device?.controls?.tariff) throw failure('EQUIPMENT_TEST_TARIFF');
        if (!device?.controls?.switch || !device.available || typeof equipment?.setSwitch !== 'function')
          throw failure('EQUIPMENT_TEST_UNAVAILABLE');
        const previousOn = freshState(device, clock()), signature = route(equipment, input.deviceId);
        if (previousOn === null) throw failure('EQUIPMENT_TEST_STATE');
        if (!signatureValid(signature)) throw failure('EQUIPMENT_SWITCH_ROUTE');
        const requested = { deviceId: input.deviceId, on: input.on, previousOn,
          at: clock(), status: 'pending', confirmed: false };
        try { await persist({ ...state, lastManual: requested }); }
        catch { throw failure(stopping ? 'EQUIPMENT_TEST_CLOSED' : 'EQUIPMENT_SWITCH_STORAGE'); }
        let sent;
        try {
          if (closed || closing || stopping) throw failure('EQUIPMENT_TEST_CLOSED');
          checkRoute({ deviceId: input.deviceId, signature }, adapter());
          if (freshState(devices(adapter()).find(row => row.id === input.deviceId), clock()) !== previousOn)
            throw failure('EQUIPMENT_TEST_STATE');
          const result = await equipment.setSwitch(input.deviceId, input.on);
          sent = result?.sent;
          if (result?.confirmed !== true) throw failure('EQUIPMENT_SWITCH_UNCONFIRMED');
          checkRoute({ deviceId: input.deviceId, signature }, adapter());
          const lastManual = { ...requested, status: 'confirmed', confirmed: true, sent,
            confirmedAt: clock() };
          await persist({ ...state, lastManual });
          return publicManual(lastManual);
        } catch (error) {
          const code = ['EQUIPMENT_TEST_AUTHORITY', 'EQUIPMENT_TEST_CLOSED'].includes(error?.code) ? error.code
            : error?.code === 'EQUIPMENT_TEST_ROUTE' ? 'EQUIPMENT_SWITCH_ROUTE' : 'EQUIPMENT_SWITCH_UNCONFIRMED';
          const next = { ...state, lastManual: { ...requested, status: 'unconfirmed', confirmed: false, sent, code } };
          try { await persist(next); } catch { state = next; }
          throw failure(code);
        }
      });
    },
    manualStatus() {
      const legacy = api.status();
      return { available: legacy.available, busy: legacy.busy, lastResult: publicManual(state.lastManual),
        reason: legacy.reason };
    },
    start(input) {
      if (closing || stopping) return Promise.reject(failure('EQUIPMENT_TEST_CLOSED'));
      return exclusive(async () => {
        if (!input || typeof input !== 'object' || Array.isArray(input)
          || Object.keys(input).some(key => !['deviceId', 'on', 'durationMinutes'].includes(key))
          || !idValid(input.deviceId) || typeof input.on !== 'boolean'
          || !Number.isInteger(input.durationMinutes) || input.durationMinutes < 1 || input.durationMinutes > 15)
          throw failure('EQUIPMENT_TEST_INPUT');
        if (state.active) throw failure('EQUIPMENT_TEST_ACTIVE');
        if (!authority()) throw failure('EQUIPMENT_TEST_AUTHORITY');
        const equipment = adapter(), device = devices(equipment).find(row => row.id === input.deviceId), now = clock();
        if (device?.controls?.tariff) throw failure('EQUIPMENT_TEST_TARIFF');
        if (!device?.controls?.switch || !device.available || typeof equipment?.setSwitch !== 'function')
          throw failure('EQUIPMENT_TEST_UNAVAILABLE');
        const previousOn = freshState(device, now), signature = route(equipment, input.deviceId);
        if (previousOn === null) throw failure('EQUIPMENT_TEST_STATE');
        if (!signatureValid(signature)) throw failure('EQUIPMENT_TEST_ROUTE');
        const active = { deviceId: input.deviceId, on: input.on, previousOn, signature,
          requestedAt: now, until: now + input.durationMinutes * MINUTE, status: 'starting' };
        const ready = () => {
          if (closed || closing || stopping) throw failure('EQUIPMENT_TEST_CLOSED');
          checkRoute(active, adapter());
          if (clock() >= active.until || freshState(devices(adapter()).find(row => row.id === active.deviceId), clock()) !== previousOn)
            throw failure('EQUIPMENT_TEST_STATE');
        };
        // If this write fails, nothing is dispatched. A later lost response can
        // never erase knowledge of which physical output needs restoration.
        try { await persist({ ...state, active, lastResult: record(active, 'starting', { confirmed: false }) }, ready); }
        catch (error) { throw Object.hasOwn(messages, error?.code) ? error : failure(stopping ? 'EQUIPMENT_TEST_CLOSED' : 'EQUIPMENT_TEST_STORAGE'); }
        unissued = active;
        try {
          ready();
          unissued = null;
          const result = await equipment.setSwitch(active.deviceId, active.on);
          if (result?.confirmed !== true) throw failure('EQUIPMENT_TEST_UNCONFIRMED');
          checkRoute(active, adapter());
          const confirmedAt = clock();
          const running = { ...active, confirmedAt, until: confirmedAt + input.durationMinutes * MINUTE, status: 'active' };
          const lastResult = record(running, 'active', { confirmed: true, until: running.until });
          await persist({ ...state, active: running, lastResult });
          startupRestore = false; retryAt = 0; notify(lastResult);
          return lastResult;
        } catch (error) {
          if (unissued) {
            await discardUnissued();
            throw failure('EQUIPMENT_TEST_NOT_STARTED');
          }
          const code = ['EQUIPMENT_TEST_AUTHORITY', 'EQUIPMENT_TEST_ROUTE'].includes(error?.code) ? error.code : 'EQUIPMENT_TEST_UNCONFIRMED';
          await markPending(code); throw failure(code);
        }
      });
    },
    restore(options = {}) {
      const reason = ['expiry', 'startup', 'shutdown', 'settings-reload'].includes(options.reason) ? options.reason : 'manual';
      return exclusive(() => restoreInternal(reason));
    },
    async tick() {
      if (closed || stopping || pending || !state.active) return api.status();
      if (startupRestore || state.active.status === 'restoration-pending' || clock() >= state.active.until) {
        if (clock() < retryAt) { arm(); return api.status(); }
        if (!authority()) { retryAt = clock() + RETRY_MS; arm(); return api.status(); }
        try { await api.restore({ reason: startupRestore ? 'startup' : 'expiry' }); } catch { /* Saved pending state reports the failure. */ }
      } else arm(); // A backward wall-clock step must not consume the only wake-up.
      return api.status();
    },
    beginShutdown({ restore = true } = {}) {
      stopping = true; clearTimeout(timer); timer = null;
      writes.beginShutdown({ restore });
    },
    async close({ restore = true } = {}) {
      if (closed) return;
      if (closing) throw failure('EQUIPMENT_TEST_BUSY');
      api.beginShutdown({ restore });
      closing = true;
      try {
        await pending?.catch(() => {});
        if (restore && state.active) await api.restore({ reason: 'shutdown' });
        closed = true; writes.close(); clearTimeout(timer); timer = null;
      } finally { closing = false; if (!closed) arm(); }
    },
    status() {
      const equipment = adapter(), allowed = authority();
      const eligible = typeof equipment?.setSwitch === 'function' && devices(equipment).some(device => device.controls?.switch
        && !device.controls?.tariff && signatureValid(route(equipment, device.id)) && freshState(device, clock()) !== null);
      const reason = closed || stopping ? messages.EQUIPMENT_TEST_CLOSED : !allowed ? messages.EQUIPMENT_TEST_AUTHORITY
        : state.active?.status === 'restoration-pending' ? publicResult(state.lastResult)?.reason ?? messages.EQUIPMENT_TEST_RESTORE
        : state.active ? messages.EQUIPMENT_TEST_ACTIVE : !eligible ? messages.EQUIPMENT_TEST_UNAVAILABLE : null;
      return { available: !closed && !stopping && allowed && eligible && !state.active, busy: Boolean(pending || closing),
        active: publicActive(state.active), lastResult: publicResult(state.lastResult), reason };
    },
  };
  return api;
}
