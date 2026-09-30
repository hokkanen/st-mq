import { createHash } from 'node:crypto';
import { garageSettings } from './settings.js';
import { validateGarageNativeSetting } from './native-settings.js';
import { validateGarageModeState, validGarageTarget, GARAGE_WARMING_WARNING } from './room-temperature.js';
import { confirmedGarageDoor, GARAGE_DOOR_SIGNALS } from './door-state.js';
import { temperatureReportMaxAge } from '../domain/temperature-reports.js';

const finite = Number.isFinite;
const copy = value => structuredClone(value);
const observationView = (row, now, maxAge) => ({ value: finite(row?.value) ? row.value : null,
  observedAt: row?.sourceTime ?? null, source: row?.source ?? null,
  stale: !row || !finite(row.sourceTime) || row.sourceTime > now || !finite(row.receivedAt) || row.receivedAt > now
    || now - row.sourceTime >= Math.min(maxAge, temperatureReportMaxAge(row) ?? maxAge)
    || row.raw?.retained === true || row.raw?.auditOnly === true
    || (row.quality ?? []).some(flag => !['good', 'simulated', 'historical', 'converted_fahrenheit', 'estimated'].includes(flag)) });

/** Manual, equipment-bound intent. Heat-pump controller readback describes actual
 * regulation; neither a saved mode nor a reconnect grants permission to send commands. */
export class GarageRuntime {
  constructor({ engine, store, config, clock = Date.now, canControl = () => true }) {
    this.engine = engine; this.store = store; this.config = config; this.clock = clock; this.canControl = canControl;
    const { adapter: _adapter, sender: _sender, ...settings } = config.garage ?? {};
    this.settings = garageSettings(settings); this.input = config.input;
    this.keys = { mode: `garage:mode:${this.input}`, adapter: `garage:adapter:${this.input}`, sender: `garage:sender:${this.input}` };
    this.adapterKey = createHash('sha256').update(JSON.stringify({ adapter: Object.fromEntries(
      ['driver', 'stateTopic', 'telemetryTopic', 'commandTopic'].map(key => [key, config.garage?.adapter?.[key] ?? null])),
      broker: { address: config.connections?.mqtt?.address ?? null, user: config.connections?.mqtt?.user ?? null } })).digest('hex');
    const saved = validateGarageModeState(store.getState(this.keys.mode));
    this.selection = saved?.adapterKey === this.adapterKey ? saved : null;
    this.closed = false; this.busy = false;
    store.setState(`garage:configuration:${this.input}`, this.settings);
  }
  setAdapter(adapter) { this.adapter = adapter; this.sync(); }
  setSender(sender) { this.sender = sender; }
  adapterChanged(snapshot) {
    this.store.setState(this.keys.adapter, snapshot);
    this.sync();
  }
  senderChanged(snapshot) { this.store.setState(this.keys.sender, snapshot); }
  sync(now = this.clock()) {
    const adapter = this.adapter?.status(now), control = adapter?.control;
    if (!adapter?.targetIdentity || !control || !validGarageTarget(control.targetC)) return;
    if (this.selection && this.selection.targetIdentity !== adapter.targetIdentity) {
      // Keep the earlier record until an explicit selection replaces it. It is
      // history belonging to other equipment, never this device's intent.
      this.identityChanged = true; return;
    }
    this.identityChanged = false;
    if (!this.selection) {
      this.selection = { version: 1, adapterKey: this.adapterKey, targetIdentity: adapter.targetIdentity,
        mode: 'normal', normalTargetC: control.targetC, awayTargetC: this.settings.awayTargetC,
        changedAt: now, warmingWarning: null };
      this.store.setState(this.keys.mode, this.selection);
    }
    if (this.lastEffectiveTargetC !== undefined && control.effectiveTargetC > this.lastEffectiveTargetC)
      this.warn(this.lastEffectiveTargetC, control.effectiveTargetC, now);
    this.lastEffectiveTargetC = control.effectiveTargetC;
  }
  warn(fromC, toC, now) {
    if (!this.selection || !validGarageTarget(fromC) || !validGarageTarget(toC) || toC <= fromC) return;
    this.selection = { ...this.selection, warmingWarning: { fromC, toC, since: now,
      until: now + 86_400_000, message: GARAGE_WARMING_WARNING } };
    this.store.setState(this.keys.mode, this.selection);
  }
  controlReason(now = this.clock()) {
    if (!this.settings.enabled) return 'Garage control is disabled in configuration.';
    if (!this.canControl() || this.input === 'offline') return 'This instance is read-only.';
    if (this.closed) return 'Garage control is closed.';
    if (this.busy) return 'Wait for the current garage request to finish.';
    return this.adapter?.status(now).blockedReasons[0] ?? (!this.adapter ? 'Waiting for the heat-pump controller connection.' : null);
  }
  async setHeating(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['mode', 'targetC'].includes(key))
      || !['normal', 'away'].includes(input.mode)
      || Object.hasOwn(input, 'targetC') && (input.mode !== 'normal' || !validGarageTarget(input.targetC)))
      throw new Error('Choose Normal or Away, with an optional Normal target between 0 and 31°C in half-degree steps.');
    const now = this.clock(); this.sync(now);
    const reason = this.controlReason(now);
    if (reason) throw Object.assign(new Error(reason), { statusCode: 409 });
    const adapter = this.adapter.status(now), previous = this.identityChanged ? null : this.selection;
    const normalTargetC = input.targetC ?? previous?.normalTargetC ?? adapter.control?.targetC;
    if (!validGarageTarget(normalTargetC)) throw new Error('Wait for the saved room target to be reported or choose a Normal temperature.');
    const targetC = input.mode === 'away' ? this.settings.awayTargetC : normalTargetC;
    const fromC = adapter.control?.effectiveTargetC ?? (previous?.mode === 'away' ? previous.awayTargetC : previous?.normalTargetC);
    this.busy = true;
    try {
      const result = await this.adapter.setControl({ targetC, externalEnabled: true }, now);
      const next = { version: 1, adapterKey: this.adapterKey, targetIdentity: adapter.targetIdentity,
        mode: input.mode, normalTargetC, awayTargetC: this.settings.awayTargetC, changedAt: now,
        warmingWarning: previous?.warmingWarning ?? null };
      this.store.transaction(() => {
        this.store.setState(this.keys.mode, next);
        this.store.event('garage-mode-changed', { mode: input.mode, targetC, previousTargetC: fromC ?? null,
          commandId: result.commandId, status: result.status }, now);
      });
      this.selection = next; this.identityChanged = false;
      this.engine.ingest({ source: 'stmq', device: adapter.targetIdentity, signal: 'garage_away_mode',
        value: input.mode === 'away' ? 1 : 0, unit: 'state', sourceTime: now, receivedAt: now, quality: ['good'],
        raw: { requested: true, commandId: result.commandId, usableForControl: false } });
      this.warn(fromC, targetC, now);

      return this.status(now);
    } finally { this.busy = false; }
  }
  nativeControls(now = this.clock()) {
    const controls = this.adapter?.nativeControls(now) ?? { available: false, settings: {}, reason: 'Waiting for the heat-pump controller connection.' };
    const reason = this.controlReason(now);
    return { ...controls, available: !reason && controls.available, busy: this.busy || controls.busy,
      reason: reason ?? controls.reason,
      settings: Object.fromEntries(Object.entries(controls.settings).map(([key, value]) => [key,
        reason ? { ...value, available: false, reason } : value])) };
  }
  async setNativeSettings(input) {
    const request = validateGarageNativeSetting(input, .5), now = this.clock(), reason = this.controlReason(now);
    if (reason) throw Object.assign(new Error(reason), { statusCode: 409 });
    this.busy = true;
    try {
      const prior = this.adapter.status(now).native;
      const result = await this.adapter.setNativeSetting(request, now);
      this.store.event('garage-native-setting-requested', { ...request, commandId: result.commandId, status: result.status }, now);
      if (request.setting === 'targetC') this.warn(prior.targetC, request.value, now);

      return result;
    } finally { this.busy = false; }
  }
  tick({ now = this.clock() } = {}) {
    this.sync(now);
    if (!this.closed) void this.sender?.reconcile(now).catch(() => {});
  }
  ingestEnergy(observation) { return this.engine.recorder.recordEnergy(observation); }
  fail(reason) { this.lastError = reason; }
  status(now = this.clock()) {
    const adapter = this.adapter?.status(now), control = adapter?.control;
    const changed = this.selection && adapter?.targetIdentity && adapter.targetIdentity !== this.selection.targetIdentity;
    const selection = changed ? null : this.selection;
    const requestedTargetC = selection ? selection.mode === 'away' ? selection.awayTargetC : selection.normalTargetC : null;
    const reason = this.controlReason(now);
    const row = signal => observationView(this.engine.latest[signal] ?? this.engine.lastKnownTemperatures?.[signal], now, this.settings.maxSensorAgeMs);
    const regulationReason = {
      starting: 'The heat-pump controller is initializing local temperature regulation.',
      disabled: 'Local room regulation is disabled on the heat-pump controller.',
      'sensor-stale': 'The Bluetooth temperature is unavailable. The heat-pump controller has selected its native 16°C fallback; the saved room target is unchanged.',
      'sensor-range': 'The Bluetooth temperature cannot be used for local regulation. The heat-pump controller has selected its native 16°C fallback.',
      'frost-unavailable': 'The configured frost-protection feed is unavailable. The heat-pump controller has selected its native 16°C fallback.',
      'native-stale': 'The heat-pump controller is waiting for fresh heat-pump readback.',
      'suspended-mode': 'Local room regulation is suspended by the heat pump’s native operating mode.',
      'setting-native-target': 'The heat-pump controller is preparing the native thermostat for local room regulation.',
      'frost-rescue': 'Local frost rescue is selecting heating and a protective target.',
    }[control?.status] ?? null;
    const sender = this.sender?.status(now);
    const protection = { available: control?.frostAvailable === true, active: control?.frostActive === true,
      status: !control?.frostAvailable ? 'unavailable' : control.frostActive ? 'active' : 'ready',
      reason: !control?.frostAvailable ? 'Local frost protection is unavailable. A commissioned local frost-protection unit and fresh protection feed are required.'
        : control.frostActive ? 'The heat-pump controller is applying the local frost-protection demand.' : 'Local frost protection is ready.',
      locations: sender?.protection?.locations ?? null, settings: sender?.settings ?? null,
      configuration: sender?.configuration ?? { status: 'unknown', reason: 'Waiting for fresh local frost-protection unit status.', attempts: 0 },
      configuredSettings: copy(this.settings.protection), sender: sender ?? null };
    return { settings: copy(this.settings), status: control?.status ?? 'unavailable', reason: this.lastError ?? reason,
      mode: selection?.mode ?? null, normalTargetC: selection?.normalTargetC ?? null,
      awayTargetC: this.settings.awayTargetC,
      requestedTargetC, effectiveTargetC: control?.effectiveTargetC ?? null,
      targetConfirmed: Boolean(control && control.externalEnabled && control.targetC === requestedTargetC),
      changedAt: selection?.changedAt ?? null,
      warmingWarning: selection?.warmingWarning?.until > now ? copy(selection.warmingWarning) : null,
      controlAvailable: !reason, controlReason: reason, regulationReason,
      nativeControls: this.nativeControls(now), protection,
      observations: { rear: row('garage_temperature'), front: row('garage_temperature_2'), outdoor: row('outdoor_temperature') },
      doors: Object.fromEntries(GARAGE_DOOR_SIGNALS.map(signal => { const observed = this.engine.latest[signal];
        return [signal, { open: confirmedGarageDoor(observed, now) ? observed.value === 1 : null,
          observedAt: observed?.sourceTime ?? null }]; })),
      adapter: adapter ?? { phase: 'unavailable', contractStatus: 'missing', connected: false, blockedReasons: ['Waiting for the heat-pump controller connection.'] } };
  }
  async close() { this.closed = true; await this.sender?.close(); }
}
