import { HEATING_COMMANDS } from '../control/mqtt.js';

const REFRESH_MS = 600_000;
const copy = value => structuredClone(value);
const time = value => typeof value === 'number' ? value : Date.parse(value);
const failure = (code, message) => Object.assign(new Error(message), { code });

// The tariff relay and H66 are separate transports. Broker acknowledgements
// prove delivery to MQTT, not physical relay or compressor operation.
export class Executor {
  constructor({ input, store, plant, commandTransport = null, h66 = null, config = {}, clock = Date.now, deliveryBoundMs = 10_000 }) {
    if (!Number.isFinite(deliveryBoundMs) || deliveryBoundMs <= 0) throw new Error('A positive command delivery bound is required');
    Object.assign(this, { input, store, plant, commandTransport, h66, clock, deliveryBoundMs });
    const minutes = config.dhwrPulseMinutes ?? 10;
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 60) throw new Error('DHWR duration must be 1–60 minutes');
    this.pulseMs = minutes * 60_000;
    this.key = `executor:${input}`;
    let saved;
    try { saved = store.getState(this.key); } catch { saved = null; }
    this.state = saved?.version === 1 ? copy(saved) : { version: 1, phase: 'normal',
      pulseUntil: 0, expiresAt: null, legacyOutstanding: false, requested: null, acknowledgedAt: null, lastResult: null };
    this.restartRestore = Boolean(this.state.legacyOutstanding || this.state.dhwrOutstanding);
    this.pending = null; this.timer = null; this.closed = false;
  }
  persist() { this.store.setState(this.key, copy(this.state)); }
  status() { return { ...copy(this.state), busy: Boolean(this.pending), restorationPending: this.restartRestore }; }
  execute(decision, { mode, now = this.clock(), manualTest = false }) {
    if (!['monitoring', 'shadow', 'active'].includes(mode)) throw new Error('Invalid execution mode');
    if (manualTest) {
      if (!['mqtt', 'providers'].includes(this.input) || !this.commandTransport) throw new Error('Real MQTT tests require live input and a configured MQTT broker.');
      this.validateCommands(decision.commands);
      return this.exclusive(() => this.manual(decision.commands, now));
    }
    if (mode === 'monitoring') return { status: 'monitoring', sent: false, actual: null };
    if (mode === 'shadow') return { status: 'shadow', sent: false, actual: null };
    if (this.input === 'simulated') {
      this.plant.state.phase = decision.phase ?? decision.action;
      this.plant.state.roomBoostC = decision.roomBoostC ?? 0;
      this.plant.state.recoveryCompressorOnly = decision.recoveryCompressorOnly === true;
      return this.sendCommands(decision.commands, { now });
    }
    if (!['mqtt', 'providers'].includes(this.input) || !this.commandTransport)
      throw failure('EXECUTOR_UNAVAILABLE', 'Active control requires live input and a configured heating-command transport.');
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
      this.restartRestore = Boolean(this.state.legacyOutstanding || this.state.dhwrOutstanding);
      this.persist(); throw error;
    } finally { this.pending = null; this.armExpiry(); }
  }
  armExpiry() {
    clearTimeout(this.timer);
    const ends = [this.state.legacyOutstanding ? time(this.state.expiresAt) : NaN,
      this.state.dhwrOutstanding ? this.state.pulseUntil : NaN,
      this.restartRestore && (this.state.dhwrOutstanding || this.state.legacyOutstanding)
        ? this.clock() + 10_000 : NaN].filter(Number.isFinite);
    const end = Math.min(...ends);
    if (!this.closed && Number.isFinite(end)) {
      this.timer = setTimeout(() => this.restore({ reason: 'expiry' }).catch(() => {}), Math.max(1000, end - this.clock()));
      this.timer.unref?.();
    }
  }
  async publish(commands, now) {
    this.validateCommands(commands);
    if (commands.includes('heatoff') && now < this.state.pulseUntil)
      throw failure('DHWR_ACTIVE', 'Reduction is waiting for the configured DHWR run to end.');
    const pulse = commands.includes('heaton60');
    if ((pulse || commands.includes('heatoff')) && this.state.dhwrOutstanding && now >= this.state.pulseUntil)
      await this.stopDhwr(now);
    if (pulse && typeof this.commandTransport.publishDhwr !== 'function')
      throw failure('DHWR_UNAVAILABLE', 'MQTT switch control is required for DHWR.');
    // A lost PUBACK may still mean ON delivery. Persist the OFF obligation first.
    if (pulse) {
      this.state.dhwrOutstanding = true;
      this.state.pulseUntil = now + this.pulseMs + this.deliveryBoundMs;
    }
    this.state.requested = { commands: [...commands], at: now }; this.persist();
    let result;
    try {
      if (pulse) {
        try { result = await this.commandTransport.publishDhwr(true); }
        finally { this.state.pulseUntil = this.clock() + this.pulseMs; this.persist(); }
        if (result?.sent !== true) throw failure('EXECUTOR_UNCONFIRMED', 'DHWR switch delivery is unconfirmed.');
      }
      const heating = commands.filter(command => command !== 'heaton60');
      if (heating.length) result = await this.commandTransport.publish(heating);
    }
    finally { this.persist(); }
    if (result?.sent !== true) throw failure('EXECUTOR_UNCONFIRMED', 'Heating-command delivery is unconfirmed.');
    this.state.acknowledgedAt = this.clock(); this.persist();
    return result;
  }
  async stopDhwr(now = this.clock()) {
    if (!this.state.dhwrOutstanding) return false;
    if (typeof this.commandTransport?.publishDhwr !== 'function')
      throw failure('DHWR_UNAVAILABLE', 'DHWR OFF is pending until MQTT switch control is available.');
    const result = await this.commandTransport.publishDhwr(false);
    if (result?.sent !== true) throw failure('EXECUTOR_UNCONFIRMED', 'DHWR OFF delivery is unconfirmed.');
    this.state.dhwrOutstanding = false; this.state.pulseUntil = 0;
    this.state.dhwrStoppedAt = this.clock(); this.persist();
    this.store.observation?.({ source: 'controller', device: this.input, signal: 'dhwr_request', value: 0,
      unit: 'state', sourceTime: this.state.dhwrStoppedAt, receivedAt: this.state.dhwrStoppedAt,
      quality: ['requested'], raw: { verified: false, basis: 'MQTT OFF acknowledged by broker; physical pump state is not observed' } });
    return true;
  }
  async manual(commands, now) {
    // Circulation has its own obligation; it does not restore a tariff reduction.
    if (commands.every(command => command === 'heaton60')) return this.publish(commands, now);
    const reduction = commands.at(-1) === 'heatoff';
    this.state.manualRequested = { phase: reduction ? 'reduction' : 'normal', at: now, confirmed: false };
    // A manual reduction has a bounded restoration obligation too; failed delivery
    // stays uncertain until the next normal request or restart reconciliation.
    if (reduction) { this.state.legacyOutstanding = true; this.state.expiresAt = now + 900_000; }
    this.persist();
    const result = await this.publish(commands, now);
    this.state.phase = reduction ? 'reduction' : 'normal';
    this.state.manualRequested.confirmed = true;
    this.state.legacyOutstanding = reduction;
    if (!reduction) this.state.expiresAt = null;
    this.persist();
    return result;
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
    const phase = decision.phase ?? decision.action ?? (decision.commands.includes('heatoff') ? 'reduction' : 'normal');
    if (!['normal', 'recovery', 'preheat', 'reduction'].includes(phase)) throw new Error('Invalid heating phase');
    const expiresAt = decision.expiresAt == null ? now + 1_800_000 : time(decision.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt - now > 86_400_000)
      throw failure('EXECUTOR_EXPIRY', 'Automatic heating actions require a future bounded expiry.');
    if (this.restartRestore || this.h66?.status(now).restorationPending) {
      const restored = await this.restoreInternal({ now, reason: 'restart-or-interrupted-transition' });
      if (restored.restorationPending) return restored;
    }
    if (this.state.dhwrOutstanding && now >= this.state.pulseUntil) await this.stopDhwr(now);
    if (phase === 'recovery' && decision.recoveryCompressorOnly === true
      && this.h66?.status(now).controlsReady && this.h66.status(now).writesEnabled === true) {
      const native = await this.h66.setPhase({ phase, compressorOnly: true, now, expiresAt });
      const refresh = this.state.phase !== phase || this.state.legacyOutstanding
        || this.state.acknowledgedAt == null || now - this.state.acknowledgedAt >= REFRESH_MS;
      if (refresh) await this.publish(['heaton15'], now);
      this.state.phase = phase; this.state.legacyOutstanding = false; this.state.expiresAt = expiresAt;
      this.restartRestore = false;
      return this.result(phase, refresh || native.changed?.length > 0, { native, recoveryCompressorOnly: true });
    }
    if (phase === 'normal' || phase === 'recovery') return this.normal(now, phase, {
      ...(phase === 'recovery' ? { recoveryCompressorOnly: false, recoveryFallbackReason: decision.recoveryFallbackReason
        ?? (decision.recoveryCompressorOnly ? 'native-settings-unavailable' : null) } : {}),
    }, decision.commands);
    if (phase === 'preheat') {
      const status = this.h66?.status(now);
      if (!status?.controlsReady || status.writesEnabled !== true)
        return this.normal(now, 'normal', { reason: 'Coupled preheat requires fresh writable H66 native settings.' });
      if (this.state.phase === 'reduction') {
        const restored = await this.restoreInternal({ now, reason: 'reduction-to-preheat' });
        if (restored.restorationPending) return restored;
      }
      const needsPulse = now >= this.state.pulseUntil;
      if (needsPulse && now + this.pulseMs > expiresAt)
        return this.normal(now, 'normal', { reason: 'Less than the configured DHWR duration remains in the preheat window.' });
      this.state.legacyOutstanding = true;
      this.state.expiresAt = Math.min(expiresAt, needsPulse ? now + this.pulseMs : this.state.pulseUntil);
      this.persist();
      let sent = false;
      if (needsPulse) {
        await this.publish(['heaton60', 'heaton15'], now); sent = true;
        this.state.expiresAt = Math.min(expiresAt, this.state.pulseUntil); this.persist();
      }
      try {
        const native = await this.h66.setPhase({ phase, roomBoostC: decision.roomBoostC ?? 1, now:this.clock(),
          expiresAt: this.state.expiresAt });
        this.state.phase = phase; this.restartRestore = false;
        return this.result(phase, sent || native.changed?.length > 0, { native,
          coupling: 'ROOM readback follows the DHWR request; independent transports cannot switch atomically.' });
      } catch (error) {
        try { await this.restoreInternal({ now: this.clock(), reason: 'preheat-activation-failed' }); } catch { /* Retain restoration obligation. */ }
        throw error;
      }
    }
    // ROOM restoration precedes tariff reduction; an already requested pulse runs to its end.
    let restoredBeforeReduction = null;
    const roomOwned = Boolean(this.h66?.status(now).obligations?.['0203']);
    if (this.state.phase === 'preheat' || roomOwned) {
      const restored = await this.restoreInternal({ now, reason: 'preheat-complete' });
      if (restored.restorationPending) return restored;
      restoredBeforeReduction = restored;
    }
    if (now < this.state.pulseUntil) return this.result('normal', restoredBeforeReduction?.sent ?? false, { status: 'waiting',
      requestedPhase: 'reduction', reason: 'Waiting for the configured DHWR run to end.', resumeAt: this.state.pulseUntil });
    const nativeStatus = this.h66?.status(now);
    let native = null;
    if (nativeStatus?.controlsReady && nativeStatus.writesEnabled === true)
      native = await this.h66.setPhase({ phase, now, expiresAt });
    const refresh = this.state.phase !== phase || this.state.acknowledgedAt == null || now - this.state.acknowledgedAt >= REFRESH_MS;
    this.state.legacyOutstanding = true; this.state.expiresAt = expiresAt; this.persist();
    if (refresh) await this.publish(['heatoff'], now);
    this.state.phase = phase; this.restartRestore = false;
    return this.result(phase, refresh || native?.changed?.length > 0, { native,
      ...(native ? {} : { nativeSettings: 'unavailable; base tariff reduction only' }) });
  }
  async normal(now, phase = 'normal', detail = {}, commands = []) {
    if (this.state.legacyOutstanding || Object.keys(this.h66?.status(now).obligations ?? {}).length) {
      const restored = await this.restoreInternal({ now, phase, reason: phase, detail });
      if (restored.restorationPending || !commands.includes('heaton60')) return restored;
    }
    const native = this.h66 ? await this.h66.setPhase({ phase, now }) : null;
    const pulse = commands.includes('heaton60') && now >= this.state.pulseUntil;
    const refresh = pulse || this.state.phase !== phase || this.state.acknowledgedAt == null || now - this.state.acknowledgedAt >= REFRESH_MS;
    if (refresh) await this.publish(pulse ? ['heaton60', 'heaton15'] : ['heaton15'], now);
    this.state.phase = phase; this.state.expiresAt = null;
    return this.result(phase, refresh, { native, ...detail });
  }
  async restoreInternal({ now = this.clock(), reason = 'restore-normal', phase = 'normal', detail = {} } = {}) {
    let native = null, nativeError = null, dhwrError = null, sent = false;
    try { if (this.state.dhwrOutstanding) sent = await this.stopDhwr(now); }
    catch (error) { dhwrError = error.code ?? 'DHWR_OFF_FAILED'; }
    try { if (this.h66) native = await this.h66.restore({ now, reason, phase }); }
    catch (error) { nativeError = error.code ?? 'H66_RESTORATION_FAILED'; }
    // Restore the tariff relay even if native-setting restoration is temporarily offline.
    if (this.state.legacyOutstanding || this.state.phase === 'reduction' || this.state.phase === 'preheat') {
      await this.publish(['heaton15'], now); sent = true; this.state.legacyOutstanding = false;
    }
    const restorationPending = Boolean(dhwrError || this.state.dhwrOutstanding || nativeError || native?.restorationPending);
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
