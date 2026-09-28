import { randomUUID } from 'node:crypto';
import { HEATING_COMMANDS } from '../control/mqtt.js';

const REFRESH_MS = 600_000;
const copy = value => structuredClone(value);
const time = value => typeof value === 'number' ? value : Date.parse(value);
const failure = (code, message) => Object.assign(new Error(message), { code });

// The tariff relay and H66 are separate transports. Broker acknowledgements
// prove delivery to MQTT, not physical relay or compressor operation.
export class Executor {
  constructor({ input, store, plant, commandTransport = null, h66 = null, floorOverride = null, config = {}, clock = Date.now, monotonicClock = () => performance.now(), deliveryBoundMs = 10_000 }) {
    if (!Number.isFinite(deliveryBoundMs) || deliveryBoundMs <= 0) throw new Error('A positive command delivery bound is required');
    Object.assign(this, { input, store, plant, commandTransport, h66, floorOverride, clock, monotonicClock, deliveryBoundMs });
    this.elapsedDeadlines = new Map();
    const minutes = config.dhwrPulseMinutes ?? 10;
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 60) throw new Error('DHWR duration must be 1–60 minutes');
    this.pulseMs = minutes * 60_000;
    this.preheatRoomBoostC = config.preheatRoomBoostC ?? 5;
    this.recoveryHoldMinutes = config.recoveryHoldMinutes ?? 60;
    this.recoveryCompressorOnly = config.recoveryCompressorOnly ?? true;
    this.key = input === 'simulated' ? 'executor:simulated' : 'executor:home';
    let saved;
    try { saved = store.getState(this.key); } catch { saved = null; }
    if (saved != null && (saved.version !== 2 || !saved.targetBindings
      || saved.dhwrOutstanding && !saved.targetBindings.dhwr?.identity
      || saved.legacyOutstanding && !saved.targetBindings.tariff?.identity))
      throw failure('EXECUTOR_STATE_UNSUPPORTED', 'Unsupported heating state. Safely stop existing equipment, then start with a fresh development database.');
    this.state = saved != null ? copy(saved) : { version: 2, targetBindings: {}, phase: 'normal',
      pulseUntil: 0, expiresAt: null, legacyOutstanding: false, requested: null, acknowledgedAt: null, lastResult: null };
    this.restartRestore = Boolean(this.state.legacyOutstanding || this.state.dhwrOutstanding || this.state.manualPause || this.state.manualTemporary || this.state.manualBaseline);
    this.manualRestorePending = false;
    this.pending = null; this.timer = null; this.closed = false;
  }
  persist() {
    this.remaining('temporary', this.state.manualTemporary?.expiresAt);
    this.remaining('pause', this.state.manualPause?.expiresAt);
    this.remaining('dhwr', this.state.dhwrOutstanding ? this.state.pulseUntil : undefined);
    this.remaining('tariff', this.state.legacyOutstanding ? time(this.state.expiresAt) : undefined);
    this.store.setState(this.key, copy(this.state));
  }
  target(kind, { acquire = false } = {}) {
    const identity = this.commandTransport?.targetIdentity?.[kind];
    const saved = this.state.targetBindings[kind];
    if (typeof identity !== 'string' || !/^[a-f0-9]{64}$/.test(identity) || saved && saved.identity !== identity)
      throw failure('EXECUTOR_TARGET_CHANGED', 'The original heating target is unavailable or changed; its restoration obligation remains pending.');
    if (!saved && acquire) this.state.targetBindings[kind] = { identity, generation: randomUUID() };
    return identity;
  }
  remaining(name, wallEnd) {
    if (!Number.isFinite(wallEnd)) { this.elapsedDeadlines.delete(name); return Infinity; }
    let saved = this.elapsedDeadlines.get(name);
    if (saved?.wallEnd !== wallEnd) {
      saved = { wallEnd, end: this.monotonicClock() + Math.max(0, wallEnd - this.clock()) };
      this.elapsedDeadlines.set(name, saved);
    }
    return Math.min(wallEnd - this.clock(), saved.end - this.monotonicClock());
  }
  expired(name, wallEnd) { return this.remaining(name, wallEnd) <= 0; }
  status() { return { ...copy(this.state), busy: Boolean(this.pending), restorationPending: this.restartRestore }; }
  execute(decision, { automationEnabled = false, now = this.clock(), manualTest = false, pause = null }) {
    if (typeof automationEnabled !== 'boolean') throw new Error('Invalid heating automation permission');
    if (manualTest) {
      if (!['mqtt', 'providers'].includes(this.input) || !this.commandTransport) throw new Error('Real MQTT tests require live input and a configured MQTT broker.');
      this.validateCommands(decision.commands);
      return this.exclusive(() => this.manual(decision.commands, now, pause, decision));
    }
    if (!automationEnabled) return { status: 'plan-only', sent: false, actual: null };
    if (this.input === 'simulated') {
      this.plant.state.phase = decision.phase ?? decision.action;
      this.plant.state.roomBoostC = decision.roomBoostC ?? 0;
      this.plant.state.recoveryCompressorOnly = decision.recoveryCompressorOnly === true;
      this.plant.state.recoveryHoldActive = decision.recoveryHoldActive === true;
      return this.sendCommands(decision.commands, { now });
    }
    if (!['mqtt', 'providers'].includes(this.input) || !this.commandTransport)
      throw failure('EXECUTOR_UNAVAILABLE', 'Automatic heating requires live input and a configured heating-command transport.');
    this.validateCommands(decision.commands);
    return this.exclusive(() => this.executePhysical(decision, now));
  }
  validateCommands(commands) {
    if (!Array.isArray(commands) || !commands.length || commands.some(command => !HEATING_COMMANDS.includes(command))) throw new Error('Invalid heating command');
  }
  async exclusive(operation) {
    if (this.closed) throw failure('EXECUTOR_CLOSED', 'Heating control is closed.');
    if (this.pending) throw failure('EXECUTOR_BUSY', 'A heating transition or test is already in progress.');
    const promise = Promise.resolve().then(operation);
    this.pending = promise;
    try { return await promise; }
    catch (error) {
      this.state.lastResult = { status: 'failed', code: error.code ?? 'EXECUTOR_UNCONFIRMED', at: this.clock(), actual: null };
      this.restartRestore = Boolean(this.state.legacyOutstanding || this.state.dhwrOutstanding || this.state.manualBaseline);
      this.manualRestorePending = false;
      this.persist(); throw error;
    } finally { this.pending = null; this.armExpiry(); }
  }
  armExpiry() {
    clearTimeout(this.timer);
    const ends = [this.state.legacyOutstanding && !this.state.manualBaseline ? this.remaining('tariff', time(this.state.expiresAt)) : NaN,
      this.remaining('pause', this.state.manualPause?.expiresAt),
      this.remaining('temporary', this.state.manualTemporary?.expiresAt),
      this.manualRestorePending ? 1000 : NaN,
      this.state.dhwrOutstanding ? this.remaining('dhwr', this.state.pulseUntil) : NaN,
      this.restartRestore && (this.state.dhwrOutstanding || this.state.legacyOutstanding || this.state.manualBaseline)
        ? 10_000 : NaN].filter(Number.isFinite);
    const end = Math.min(...ends);
    if (!this.closed && Number.isFinite(end)) {
      // Long owner-selected pauses must not overflow Node's timer delay.
      this.timer = setTimeout(() => this.exclusive(async () => {
        const now = this.clock();
        if (this.restartRestore)
          return this.manualRestorePending ? this.restoreManualInternal({ now, reason: 'manual-expiry-retry' })
            : this.restoreInternal({ now, reason: 'expiry' });
        if (this.expired('pause', this.state.manualPause?.expiresAt) || this.expired('temporary', this.state.manualTemporary?.expiresAt))
          return this.restoreManualInternal({ now, reason: 'manual-expiry' });
        if (!this.state.manualBaseline && this.state.legacyOutstanding && this.expired('tariff', time(this.state.expiresAt))) {
          const recovery = this.state.recoveryOnExpiry;
          const native = this.h66?.status(now);
          if (this.state.phase === 'reduction' && recovery
            && recovery.externalChangeRevision === (native?.externalChangeRevision ?? 0))
            return this.executePhysical({ phase: 'recovery', commands: ['normal'], owner: recovery.owner,
              recoveryHoldActive: true,
              recoveryCompressorOnly: recovery.compressorOnly && now <= recovery.temperatureValidUntil,
              recoveryFallbackReason: now > recovery.temperatureValidUntil ? 'recovery-temperature-evidence-expired'
                : !recovery.compressorOnly ? 'recovery-comfort-or-native-permission' : null,
              expiresAt: now + this.recoveryHoldMinutes * 60_000 }, now);
          return this.restoreInternal({ now, reason: 'expiry', preserveManualDhwr: true });
        }
        // Circulation ending must not cancel separately held heating parameters.
        if (this.state.dhwrOutstanding && this.expired('dhwr', this.state.pulseUntil)) await this.stopDhwr(now);
      }).catch(() => this.armExpiry()), Math.min(2_147_483_647, Math.max(1000, end)));
      this.timer.unref?.();
    }
  }
  async publish(commands, now, { allowReductionWithCirculation = false, manualCirculation = false, validUntil = Infinity } = {}) {
    this.validateCommands(commands);
    if (commands.includes('reduction') && now < this.state.pulseUntil && !allowReductionWithCirculation)
      throw failure('DHWR_ACTIVE', 'Reduction is waiting for the configured DHWR run to end.');
    const pulse = commands.includes('circulation');
    if (commands.includes('reduction')) this.target('tariff', { acquire: true });
    if (pulse) this.target('dhwr', { acquire: true });
    if ((pulse || commands.includes('reduction')) && this.state.dhwrOutstanding && now >= this.state.pulseUntil)
      await this.stopDhwr(now);
    if (pulse && typeof this.commandTransport.publishDhwr !== 'function')
      throw failure('DHWR_UNAVAILABLE', 'MQTT switch control is required for DHWR.');
    // A lost PUBACK may still mean ON delivery. Persist the OFF obligation first.
    if (pulse) {
      this.state.dhwrOutstanding = true;
      this.state.dhwrRequested = { on: true, at: now };
      this.state.pulseUntil = now + this.pulseMs + this.deliveryBoundMs;
      this.state.manualDhwrUntil = manualCirculation ? this.state.pulseUntil : null;
      this.remaining('dhwr', this.state.pulseUntil);
    }
    this.state.requested = { commands: [...commands], at: now }; this.persist();
    let result;
    try {
      if (pulse) {
        try { result = await this.commandTransport.publishDhwr(true); }
        finally {
          this.state.pulseUntil = this.clock() + this.pulseMs;
          this.state.manualDhwrUntil = manualCirculation ? this.state.pulseUntil : null;
          this.remaining('dhwr', this.state.pulseUntil);
          this.persist();
        }
        if (result?.sent !== true) throw failure('EXECUTOR_UNCONFIRMED', 'DHWR switch delivery is unconfirmed.');
      }
      const heating = commands.filter(command => command !== 'circulation');
      if (heating.length) {
        const identity = this.target('tariff', { acquire: heating.includes('reduction') });
        if (this.clock() >= validUntil) throw failure('EXECUTOR_EXPIRED', 'Heating action expired before tariff dispatch.');
        this.state.tariffRequested = { mode: heating.at(-1), at: this.clock() }; this.persist();
        result = await this.commandTransport.publish(heating, { validUntil, clock: this.clock, expectedTarget: identity });
        if (result?.sent === true && heating.at(-1) === 'normal') delete this.state.targetBindings.tariff;
      }
    }
    finally { this.persist(); }
    if (result?.sent !== true) throw failure('EXECUTOR_UNCONFIRMED', 'Heating-command delivery is unconfirmed.');
    this.state.acknowledgedAt = this.clock(); this.persist();
    return result;
  }
  async stopDhwr(now = this.clock(), { force = false } = {}) {
    this.target('dhwr', { acquire: force });
    if (!this.state.dhwrOutstanding) {
      if (!force) return false;
      // An explicit stop can also address a pump started outside ST-MQ. Save
      // its OFF obligation before attempting delivery, just like a timed run.
      this.state.dhwrOutstanding = true; this.state.pulseUntil = now;
      this.persist();
    }
    if (typeof this.commandTransport?.publishDhwr !== 'function')
      throw failure('DHWR_UNAVAILABLE', 'DHWR OFF is pending until MQTT switch control is available.');
    this.state.dhwrRequested = { on: false, at: now };
    this.persist();
    const result = await this.commandTransport.publishDhwr(false);
    if (result?.sent !== true) throw failure('EXECUTOR_UNCONFIRMED', 'DHWR OFF delivery is unconfirmed.');
    delete this.state.targetBindings.dhwr; this.elapsedDeadlines.delete('dhwr');
    this.state.dhwrOutstanding = false; this.state.pulseUntil = 0; this.state.manualDhwrUntil = null;
    this.state.dhwrStoppedAt = this.clock(); this.persist();
    this.store.observation?.({ source: 'controller', device: this.input, signal: 'dhwr_request', value: 0,
      unit: 'state', sourceTime: this.state.dhwrStoppedAt, receivedAt: this.state.dhwrStoppedAt,
      quality: ['requested'], raw: { verified: false, basis: 'MQTT OFF acknowledged by broker; physical pump state is not observed' } });
    return true;
  }
  async beginManual(now, pause) {
    if (pause && (typeof pause.id !== 'string' || !pause.id || !Number.isFinite(pause.expiresAt)
      || pause.expiresAt <= now || pause.expiresAt - now > 366 * 86_400_000))
      throw failure('EXECUTOR_PAUSE_INVALID', 'Choose a current bounded price-control pause.');
    if (this.restartRestore || this.h66?.status(now).restorationPending)
      throw failure('EXECUTOR_RESTORATION_PENDING', 'Wait for the previous heating settings to be restored.');
    const currentEnd = this.state.manualPause?.expiresAt ?? this.state.manualTemporary?.expiresAt;
    if (this.state.manualBaseline && (currentEnd <= now || (this.state.manualPause?.id ?? null) !== (pause?.id ?? null))) {
      const restored = await this.restoreManualInternal({ now, reason: 'manual-owner-changed' });
      if (restored.restorationPending) throw failure('EXECUTOR_RESTORATION_PENDING', 'The previous manual selection is still being restored.');
    }
    if (!this.state.manualBaseline) {
      this.state.manualBaseline = { phase: this.state.phase, expiresAt: this.state.expiresAt,
        legacyOutstanding: this.state.legacyOutstanding, at: now };
      this.state.manualRequested = null;
      const native = this.h66?.status(now);
      const nativeEnd = native?.phase === 'manual-temporary' && native.expiresAt > now ? native.expiresAt : Infinity;
      this.state.manualPause = pause ? { id: pause.id, expiresAt: pause.expiresAt } : null;
      this.state.manualTemporary = pause ? null : { expiresAt: Math.min(now + 60_000, nativeEnd) };
    }
    this.persist();
    return this.state.manualPause?.expiresAt ?? this.state.manualTemporary.expiresAt;
  }
  async manual(commands, now, pause = null, decision = {}) {
    // Explicit circulation always owns its complete configured timer, separately
    // from the short heating-setting hold or a price-control pause.
    if (commands.every(command => command === 'circulation')) return this.publish(commands, now, { manualCirculation: true });
    const end = await this.beginManual(now, pause);
    const phase = decision.phase === 'preheat' ? 'preheat' : commands.at(-1) === 'reduction' ? 'reduction' : 'normal';
    const nativeOptions = { now, expiresAt: end, ...(pause ? { pauseId: pause.id } : {}) };
    if (phase === 'preheat' && typeof this.h66?.setManualPreheat !== 'function')
      throw failure('H66_UNAVAILABLE', 'Preheating requires writable native heat-pump settings.');
    this.state.manualRequested = { phase, at: now, confirmed: false, floorOwner: phase === 'preheat' ? `manual:${randomUUID()}` : null, roomBoostC: phase === 'preheat' ? decision.roomBoostC ?? this.preheatRoomBoostC : 0 };
    this.persist();
    if (phase !== 'preheat' && this.h66?.status(now).manualPreheat)
      await this.h66.setManualPreheat({ enabled: false, ...nativeOptions });
    // Save uncertain tariff delivery before publishing. Explicit circulation and
    // heating choices are independent while the owner holds the controls.
    if (phase === 'reduction') this.target('tariff', { acquire: true });
    this.state.legacyOutstanding = phase === 'reduction' || this.state.legacyOutstanding;
    this.state.expiresAt = end;
    this.persist();
    if (phase === 'preheat') {
      try {
        await this.publish(['normal'], now);
        if (this.floorOverride?.status(now).enabled) await this.floorOverride.lease({ owner: this.state.manualRequested.floorOwner, until: end, now });
        const native = await this.h66.setManualPreheat({ enabled: true, roomBoostC: this.state.manualRequested.roomBoostC, ...nativeOptions });
        this.state.manualRequested.roomBoostC = native?.roomBoostC ?? this.state.manualRequested.roomBoostC;
      } catch (error) {
        await this.floorOverride?.release({ reason: 'manual-preheat-failed', now: this.clock() });
        throw error;
      }
    } else {
      const floor = await this.floorOverride?.release({ reason: 'manual-supersession', now });
      if (floor?.restorationPending) throw failure('FLOOR_PENDING', 'Floor restoration must finish before another heating mode.');
      await this.publish([phase === 'reduction' ? 'reduction' : 'normal'], now, { allowReductionWithCirculation: true });
    }
    this.state.phase = phase;
    this.state.manualRequested.confirmed = true;
    this.state.legacyOutstanding = phase === 'reduction';
    this.persist();
    return this.result(phase, true, { holdUntil: pause ? end : null, roomBoostC: this.state.manualRequested.roomBoostC });
  }
  reconcileManualPreheat(now = this.clock()) {
    if (this.state.manualRequested?.phase !== 'preheat' || this.h66?.status(now).manualPreheat) return false;
    this.state.manualRequested = { ...this.state.manualRequested, phase: 'normal', roomBoostC: 0 };
    this.state.phase = 'normal'; this.persist();
    return true;
  }
  maintainPause(now = this.clock()) {
    return this.exclusive(async () => {
      if (this.restartRestore) return this.manualRestorePending ? this.restoreManualInternal({ now, reason: 'manual-restoration-pending' })
        : this.restoreInternal({ now, reason: 'manual-restoration-pending' });
      if (this.expired('pause', this.state.manualPause?.expiresAt) || this.expired('temporary', this.state.manualTemporary?.expiresAt))
        return this.restoreManualInternal({ now, reason: 'pause-ended' });
      const end = this.state.manualPause?.expiresAt ?? this.state.manualTemporary?.expiresAt;
      if (this.state.dhwrOutstanding && this.expired('dhwr', this.state.pulseUntil)) await this.stopDhwr(now);
      // A later explicit ROOM edit supersedes the preheat boost.
      this.reconcileManualPreheat(now);
      if (this.state.manualRequested?.phase === 'preheat' && this.floorOverride?.status(now).enabled)
        await this.floorOverride.lease({ owner: this.state.manualRequested.floorOwner, until: end, now });
      else await this.floorOverride?.release({ reason: 'manual-preheat-ended', now });
      const refresh = this.state.manualPause && this.state.manualRequested?.confirmed
        && (this.state.acknowledgedAt == null || now - this.state.acknowledgedAt >= REFRESH_MS);
      if (refresh) await this.publish([this.state.manualRequested.phase === 'reduction' ? 'reduction' : 'normal'], now,
        { allowReductionWithCirculation: true });
      return this.result(this.state.phase, refresh, { status: 'paused-manual', holdUntil: this.state.manualPause ? end : null,
        roomBoostC: this.state.manualRequested?.roomBoostC ?? 0 });
    });
  }
  result(phase, sent, detail = {}) {
    const result = { status: 'mqtt', sent: Boolean(sent), actual: null, phase, appliedPhase: phase,
      delivery: 'broker-acknowledged', physicalStateVerified: false,
      pulseUntil: this.state.pulseUntil, expiresAt: this.state.expiresAt, ...detail };
    this.state.lastResult = { ...result, at: this.clock() }; this.persist();
    return result;
  }
  async executePhysical(decision, now) {
    if (!Number.isFinite(now)) throw new Error('A valid execution timestamp is required');
    const phase = decision.phase ?? decision.action ?? (decision.commands.includes('reduction') ? 'reduction' : 'normal');
    if (!['normal', 'recovery', 'preheat', 'reduction'].includes(phase)) throw new Error('Invalid heating phase');
    const expiresAt = decision.expiresAt == null ? now + 1_800_000 : time(decision.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt - now > 86_400_000)
      throw failure('EXECUTOR_EXPIRY', 'Automatic heating actions require a future bounded expiry.');
    const actionElapsedEnd = this.monotonicClock() + Math.max(0, expiresAt - Math.max(now, this.clock()));
    const actionExpired = () => this.clock() >= expiresAt || this.monotonicClock() >= actionElapsedEnd;
    if (this.restartRestore || this.h66?.status(now).restorationPending) {
      const restored = this.manualRestorePending ? await this.restoreManualInternal({ now, reason: 'manual-restoration-retry' })
        : await this.restoreInternal({ now, reason: 'restart-or-interrupted-transition' });
      if (restored.restorationPending) return restored;
    }
    if (this.state.dhwrOutstanding && now >= this.state.pulseUntil) await this.stopDhwr(now);
    if (phase !== 'preheat') {
      const floor = await this.floorOverride?.release({ reason: phase, now });
      if (floor?.restorationPending) return this.result('restoration-pending', false, { restorationPending: true, floor });
    }
    if (['preheat', 'reduction'].includes(phase) && actionExpired())
      return this.restoreInternal({ now: this.clock(), reason: 'expired-before-activation' });
    if (phase === 'recovery' && decision.recoveryHoldActive === true
      && this.h66?.status(now).controlsReady && this.h66.status(now).writesEnabled === true) {
      const refresh = this.state.phase !== phase || this.state.legacyOutstanding
        || this.state.acknowledgedAt == null || now - this.state.acknowledgedAt >= REFRESH_MS;
      if (refresh) await this.publish(['normal'], now);
      // Capture the actual tariff release once. Retries and process restarts use
      // the persisted deadline; ordinary control refreshes cannot extend it.
      if (this.state.recoveryOwner !== decision.owner || !Number.isFinite(this.state.recoveryHoldUntil)) {
        this.state.recoveryOwner = decision.owner;
        this.state.recoveryStartedAt = decision.recoveryStartedAt ?? this.clock();
        this.state.recoveryHoldUntil = decision.recoveryStartedAt != null ? decision.recoveryHoldUntil
          : this.state.recoveryStartedAt + this.recoveryHoldMinutes * 60_000;
        this.state.recoveryAuxReleasedAt = null;
        this.state.recoveryFallbackReason = null;
        this.persist();
      }
      const recoveryHoldUntil = this.state.recoveryHoldUntil;
      if (recoveryHoldUntil <= this.clock()) return this.normal(this.clock(), phase,
        { recoveryHoldActive: false, recoveryHoldUntil, recoveryCompressorOnly: false }, decision.commands);
      if (decision.recoveryCompressorOnly !== true && this.state.recoveryAuxReleasedAt == null) {
        this.state.recoveryAuxReleasedAt = this.clock();
        this.state.recoveryFallbackReason = decision.recoveryFallbackReason ?? 'native-recovery-permitted';
        this.persist();
      }
      const recoveryCompressorOnly = this.state.recoveryAuxReleasedAt == null && decision.recoveryCompressorOnly === true;
      const native = await this.h66.setPhase({ phase, compressorOnly: recoveryCompressorOnly,
        holdDhwReduced: true, now: this.clock(), expiresAt: recoveryHoldUntil });
      this.state.phase = phase; this.state.legacyOutstanding = false; this.state.expiresAt = recoveryHoldUntil;
      this.restartRestore = false;
      return this.result(phase, refresh || native.changed?.length > 0, { native,
        recoveryStartedAt: this.state.recoveryStartedAt, recoveryHoldActive: true, recoveryHoldUntil,
        recoveryCompressorOnly, recoveryFallbackReason: this.state.recoveryFallbackReason ?? decision.recoveryFallbackReason });
    }
    if (phase === 'normal' || phase === 'recovery') return this.normal(now, phase, {
      ...(phase === 'recovery' ? { recoveryHoldActive: false, recoveryHoldUntil: decision.recoveryHoldUntil,
        recoveryCompressorOnly: false, recoveryFallbackReason: decision.recoveryFallbackReason
        ?? (decision.recoveryCompressorOnly ? 'native-settings-unavailable' : null) } : {}),
    }, decision.commands);
    if (phase === 'preheat') {
      const status = this.h66?.status(now);
      if (!status?.controlsReady || status.writesEnabled !== true)
        return this.normal(now, 'normal', { reason: 'Coupled preheat requires fresh writable H66 native settings.' });
      if (this.state.phase === 'reduction') {
        const restored = await this.restoreInternal({ now, reason: 'reduction-to-preheat', preserveManualDhwr: true });
        if (restored.restorationPending) return restored;
      }
      const needsPulse = decision.commands.includes('circulation') && now >= this.state.pulseUntil;
      this.target('tariff', { acquire: true });
      this.state.legacyOutstanding = true;
      this.state.expiresAt = expiresAt;
      this.persist();
      let sent = false;
      try {
        if (decision.floorOverride === true) {
          if (!this.floorOverride?.status(now).enabled) throw failure('FLOOR_UNAVAILABLE', 'Floor preheat is unavailable.');
          await this.floorOverride.lease({ owner: decision.owner ?? `automatic:${expiresAt}`, until: expiresAt, now });
        } else {
          const floor = await this.floorOverride?.release({ reason: 'room-only-preheat', now });
          if (floor?.restorationPending) throw failure('FLOOR_PENDING', 'Floor restoration must finish before ROOM-only preheat.');
        }
        if (actionExpired()) return this.restoreInternal({ now: this.clock(), reason: 'expired-during-preheat' });
        const refresh = needsPulse || this.state.phase !== phase || this.state.acknowledgedAt == null || now - this.state.acknowledgedAt >= REFRESH_MS;
        if (refresh) { await this.publish(needsPulse ? ['circulation', 'normal'] : ['normal'], now); sent = true; }
        const native = await this.h66.setPhase({ phase, roomBoostC: decision.roomBoostC ?? this.preheatRoomBoostC,
          now: this.clock(), expiresAt });
        this.state.phase = phase; this.restartRestore = false;
        return this.result(phase, sent || native.changed?.length > 0, { native, roomBoostC: native.roomBoostC ?? decision.roomBoostC ?? this.preheatRoomBoostC,
          floor: this.floorOverride?.status(this.clock()),
          coupling: 'ROOM and floor override use the preheat deadline; circulation retains its independent pulse timer.' });
      } catch (error) {
        try { await this.restoreInternal({ now: this.clock(), reason: 'preheat-activation-failed', preserveManualDhwr: true }); } catch { /* Retain restoration obligation. */ }
        throw error;
      }
    }
    // ROOM restoration precedes tariff reduction; an already requested pulse runs to its end.
    let restoredBeforeReduction = null;
    const roomOwned = Boolean(this.h66?.status(now).obligations?.['0203']);
    if (this.state.phase === 'preheat' || roomOwned) {
      const restored = await this.restoreInternal({ now, reason: 'preheat-complete', preserveManualDhwr: true });
      if (restored.restorationPending) return restored;
      restoredBeforeReduction = restored;
    }
    if (now < this.state.pulseUntil) return this.result('normal', restoredBeforeReduction?.sent ?? false, { status: 'waiting',
      requestedPhase: 'reduction', reason: 'Waiting for the configured DHWR run to end.', resumeAt: this.state.pulseUntil });
    if (actionExpired()) return this.restoreInternal({ now: this.clock(), reason: 'expired-before-native-reduction' });
    const nativeStatus = this.h66?.status(this.clock());
    let native = null;
    if (nativeStatus?.controlsReady && nativeStatus.writesEnabled === true)
      // The tariff timer ends reduction; native DHW/AUX obligations continue
      // through the bounded recovery hold without a restore/reapply gap.
      try { native = await this.h66.setPhase({ phase, now: this.clock(), activationExpiresAt: expiresAt,
        expiresAt: Math.min(expiresAt + this.recoveryHoldMinutes * 60_000, now + 86_400_000) }); }
      catch (error) {
        if (error.code === 'H66_EXPIRED') return this.restoreInternal({ now: this.clock(), reason: 'expired-during-native-reduction' });
        throw error;
      }
    if (actionExpired()) return this.restoreInternal({ now: this.clock(), reason: 'expired-before-reduction' });
    const refresh = this.state.phase !== phase || this.state.acknowledgedAt == null || now - this.state.acknowledgedAt >= REFRESH_MS;
    this.state.recoveryOnExpiry = { owner: decision.owner,
      compressorOnly: decision.recoveryAuxRestrictionAllowed ?? this.recoveryCompressorOnly,
      temperatureValidUntil: now + 300_000, externalChangeRevision: nativeStatus?.externalChangeRevision ?? 0 };
    this.target('tariff', { acquire: true });
    this.state.legacyOutstanding = true; this.state.expiresAt = expiresAt; this.persist();
    if (refresh) {
      try { await this.publish(['reduction'], this.clock(), { validUntil: expiresAt }); }
      catch (error) {
        if (error.code === 'EXECUTOR_EXPIRED') return this.restoreInternal({ now: this.clock(), reason: 'expired-before-reduction' });
        throw error;
      }
    }
    this.state.phase = phase; this.restartRestore = false;
    return this.result(phase, refresh || native?.changed?.length > 0, { native,
      ...(native ? {} : { nativeSettings: 'unavailable; base tariff reduction only' }) });
  }
  async normal(now, phase = 'normal', detail = {}, commands = []) {
    if (this.state.legacyOutstanding || Object.keys(this.h66?.status(now).obligations ?? {}).length) {
      const restored = await this.restoreInternal({ now, phase, reason: phase, detail, preserveManualDhwr: true });
      if (restored.restorationPending || !commands.includes('circulation')) return restored;
    }
    const native = this.h66 ? await this.h66.setPhase({ phase, now }) : null;
    const pulse = commands.includes('circulation') && now >= this.state.pulseUntil;
    const refresh = pulse || this.state.phase !== phase || this.state.acknowledgedAt == null || now - this.state.acknowledgedAt >= REFRESH_MS;
    if (refresh) await this.publish(pulse ? ['circulation', 'normal'] : ['normal'], now);
    this.state.phase = phase; this.state.expiresAt = null;
    return this.result(phase, refresh, { native, ...detail });
  }
  clearManual() {
    this.state.manualPause = null; this.state.manualTemporary = null;
    this.state.manualBaseline = null; this.state.manualRequested = null;
  }
  async restoreManualInternal({ now = this.clock(), reason = 'manual-ended' } = {}) {
    if (this.restartRestore && !this.manualRestorePending) return this.restoreInternal({ now, reason: 'manual-recovery' });
    const baseline = this.state.manualBaseline;
    let native = null, nativeError = null, dhwrError = null, floor = null, sent = false;
    try { floor = await this.floorOverride?.release({ reason, now }); }
    catch { floor = { restorationPending: true }; }
    // Circulation keeps its independent original end. Restoring settings neither
    // cancels a current pulse nor recreates one that has already finished.
    try { if (this.state.dhwrOutstanding && this.expired('dhwr', this.state.pulseUntil)) sent = await this.stopDhwr(now); }
    catch (error) { dhwrError = error.code ?? 'DHWR_OFF_FAILED'; }
    try { if (this.h66) native = await this.h66.restore({ now, reason, phase: 'normal' }); }
    catch (error) { nativeError = error.code ?? 'H66_RESTORATION_FAILED'; }
    const originalReduction = baseline?.phase === 'reduction' && time(baseline.expiresAt) > this.clock();
    const phase = baseline ? originalReduction ? 'reduction' : 'normal'
      : ['normal', 'recovery', 'reduction', 'preheat'].includes(this.state.phase) ? this.state.phase : 'normal';
    if (baseline && this.state.manualRequested) {
      await this.publish([originalReduction ? 'reduction' : 'normal'], this.clock(), { allowReductionWithCirculation: true });
      sent = true;
      this.state.legacyOutstanding = originalReduction;
      this.state.expiresAt = originalReduction ? baseline.expiresAt : null;
    }
    const restorationPending = Boolean(floor?.restorationPending || nativeError || native?.restorationPending || dhwrError);
    if (!restorationPending) this.clearManual();
    // H66 may already be restoring on its own expiry timer. That overlap is a
    // pending setting restore, not a failed circulation operation.
    this.manualRestorePending = restorationPending && !dhwrError && (!nativeError || nativeError === 'H66_BUSY');
    this.restartRestore = restorationPending;
    this.state.phase = restorationPending ? 'restoration-pending' : phase;
    return this.result(this.state.phase, sent || native?.changed?.length > 0, {
      status: restorationPending ? 'pending' : 'mqtt', restorationPending, native, nativeError,
      ...(dhwrError ? { dhwrError } : {}), roomBoostC: 0 });
  }
  restoreManual({ now = this.clock(), reason = 'manual-ended', decision = null, automationEnabled = false } = {}) {
    return this.exclusive(async () => {
      const restored = await this.restoreManualInternal({ now, reason });
      if (restored.restorationPending || !decision || !automationEnabled) return restored;
      return this.executePhysical(decision, this.clock());
    });
  }
  async restoreInternal({ now = this.clock(), reason = 'restore-normal', phase = 'normal', detail = {}, preserveManualDhwr = false } = {}) {
    this.manualRestorePending = false;
    let native = null, nativeError = null, dhwrError = null, floor = null, sent = false;
    try { floor = await this.floorOverride?.release({ reason, now }); }
    catch { floor = { restorationPending: true }; }
    const keepCirculation = preserveManualDhwr && this.state.pulseUntil > now && this.state.dhwrOutstanding;
    try { if (this.state.dhwrOutstanding && !keepCirculation) sent = await this.stopDhwr(now); }
    catch (error) { dhwrError = error.code ?? 'DHWR_OFF_FAILED'; }
    try { if (this.h66) native = await this.h66.restore({ now, reason, phase }); }
    catch (error) { nativeError = error.code ?? 'H66_RESTORATION_FAILED'; }
    // Restore the tariff relay even if native-setting restoration is temporarily offline.
    if (this.state.legacyOutstanding || this.state.phase === 'reduction' || this.state.phase === 'preheat') {
      try { await this.publish(['normal'], now); sent = true; this.state.legacyOutstanding = false; }
      catch (error) { nativeError ??= error.code ?? 'TARIFF_RESTORATION_FAILED'; }
    }
    const restorationPending = Boolean(floor?.restorationPending || dhwrError || this.state.dhwrOutstanding && !keepCirculation || nativeError || native?.restorationPending);
    if (!restorationPending) this.clearManual();
    this.restartRestore = restorationPending;
    this.state.phase = restorationPending ? 'restoration-pending' : phase; this.state.expiresAt = null;
    return this.result(this.state.phase, sent || native?.changed?.length > 0, {
      status: restorationPending ? 'pending' : 'mqtt', restorationPending, native, nativeError,
      ...(dhwrError ? { dhwrError } : {}), ...detail });
  }
  restore(options = {}) { return this.exclusive(() => this.restoreInternal(options)); }
  async close({ restore = true } = {}) {
    if (this.closed) return;
    if (!restore) {
      this.closed = true; clearTimeout(this.timer);
      await this.commandTransport?.close();
      await this.pending?.catch(() => {});
      return;
    }
    await this.pending?.catch(() => {});
    try { await this.restore({ reason: 'application-shutdown' }); }
    finally { this.closed = true; clearTimeout(this.timer); }
  }
  sendCommands(commands, { now, physical = false }) {
    this.validateCommands(commands);
    if (physical) return this.exclusive(() => this.manual(commands, now));
    const actual = this.plant.apply(commands, now, this.pulseMs);
    this.store.event('simulated-command-readback', { commands, actual }, now);
    return { status: 'simulated', sent: true, actual };
  }
}
