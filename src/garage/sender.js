import { randomUUID } from 'node:crypto';
import { garageSettings } from './settings.js';
import { decodeGarageEnvelope } from './contract.js';

export const GARAGE_SENDER_CONTRACT = 'stmq-garage-sender/v1';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const topic = value => typeof value === 'string' && value.length <= 1024 && !/[+#\u0000]/.test(value);
export function garageSenderSettings(input = {}) {
  if (!object(input) || Object.keys(input).some(key => !['stateTopic', 'commandTopic', 'maxAgeMs'].includes(key)))
    throw new Error('Unsupported Garage sender settings.');
  const value = { stateTopic: '', commandTopic: '', maxAgeMs: 180_000, ...input };
  if (!topic(value.stateTopic) || !topic(value.commandTopic) || value.commandTopic && !value.stateTopic
    || value.stateTopic && value.stateTopic === value.commandTopic
    || !Number.isSafeInteger(value.maxAgeMs) || value.maxAgeMs < 30_000 || value.maxAgeMs > 600_000)
    throw new Error('Garage sender requires distinct exact topics and a 30–600 second maximum age.');
  return value;
}
export function validateSenderProtectionSettings(input) {
  const expected = Object.keys(garageSettings().protection).sort().join(',');
  if (!object(input) || Object.keys(input).sort().join(',') !== expected)
    throw new Error('Send the complete current frost-protection settings.');
  return garageSettings({ protection: input }).protection;
}
function protectionState(value) {
  if (!object(value) || typeof value.available !== 'boolean' || typeof value.active !== 'boolean'
    || !(value.minTargetC === null || Number.isFinite(value.minTargetC) && value.minTargetC >= 0 && value.minTargetC <= 31)
    || !(value.reason === null || typeof value.reason === 'string' && value.reason.length <= 200)
    || !object(value.locations)) return null;
  const locations = {};
  for (const name of ['rear', 'front']) {
    const row = value.locations[name];
    if (!object(row) || typeof row.uncertain !== 'boolean'
      || !['airC', 'estimatedC'].every(key => row[key] === null || Number.isFinite(row[key]) && row[key] >= -60 && row[key] <= 70)) return null;
    if (row.remainingKjPerM != null && (!Number.isFinite(row.remainingKjPerM) || row.remainingKjPerM < 0)) return null;
    locations[name] = { airC: row.airC, estimatedC: row.estimatedC, uncertain: row.uncertain,
      remainingKjPerM: row.uncertain ? null : row.remainingKjPerM ?? null };
  }
  return { available: value.available, active: value.active, minTargetC: value.minTargetC, reason: value.reason, locations };
}

const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f]/.test(value);
const time = value => Number.isSafeInteger(value) && value >= 0;
export function validateGarageSenderSnapshot(value) {
  if (value == null) return value;
  const invalid = () => { throw new Error('Unsupported saved Garage sender state; start a fresh development database.'); };
  if (!object(value) || Object.keys(value).sort().join(',') !== 'lastCommand,schema,state,version'
    || value.version !== 1 || value.schema !== GARAGE_SENDER_CONTRACT) invalid();
  let state = value.state;
  if (state !== null) {
    if (!object(state) || Object.keys(state).sort().join(',') !== 'bootId,challenge,config,deviceId,observedAt,protection,receivedAt,retained,sequence'
      || !identity(state.deviceId) || !identity(state.bootId) || !identity(state.challenge)
      || !time(state.sequence) || !time(state.observedAt) || !time(state.receivedAt)
      || state.observedAt > state.receivedAt || typeof state.retained !== 'boolean') invalid();
    let config;
    try { config = validateSenderProtectionSettings(state.config); } catch { invalid(); }
    const protection = protectionState(state.protection);
    if (!protection) invalid();
    state = { ...state, config, protection };
  }
  const command = value.lastCommand;
  if (command !== null && (!object(command)
    || Object.keys(command).sort().join(',') !== 'commandId,reason,requestedAt,status'
    || !identity(command.commandId) || !time(command.requestedAt)
    || !['published', 'applied', 'rejected', 'failed', 'uncertain'].includes(command.status)
    || !(command.reason === null || typeof command.reason === 'string' && command.reason.length <= 200))) invalid();
  return { ...value, state };
}

/** MQTT is a settings and observation channel. BLE protection and the pipe
 * estimate continue on the sender independently of this application. */
export function createGarageSender({ settings: input = {}, publish, clock = Date.now, canControl = () => true,
  onState = () => {}, onObservation = () => {}, persisted = null } = {}) {
  const settings = garageSenderSettings(input);
  validateGarageSenderSnapshot(persisted);
  let connected = false, state = null, usedChallenge = null, lastCommand = null;
  const retiredBoots = new Set();
  function snapshot() { return { version: 1, schema: GARAGE_SENDER_CONTRACT, state: state ? structuredClone(state) : null,
    lastCommand: lastCommand ? structuredClone(lastCommand) : null }; }
  function status(now = clock()) {
    const available = connected && state && !state.retained && state.observedAt <= now && now - state.observedAt < settings.maxAgeMs;
    if (lastCommand?.status === 'published' && now - lastCommand.requestedAt >= 30_000)
      lastCommand = { ...lastCommand, status: 'uncertain', reason: 'Local frost-protection unit confirmation timed out.' };
    const reason = !canControl() ? 'This instance is read-only.'
      : !available ? 'Waiting for fresh local frost-protection unit status.'
        : !publish || !settings.commandTopic ? 'The local frost-protection settings connection is unavailable.'
          : usedChallenge === state.challenge ? 'Waiting for the local frost-protection unit to accept another command.'
            : lastCommand?.status === 'published' ? 'Waiting for local frost-protection unit confirmation.' : null;
    return { available: Boolean(available), settingsAvailable: reason === null, settingsReason: reason,
      observedAt: state?.observedAt ?? null, receivedAt: state?.receivedAt ?? null,
      settings: available ? structuredClone(state.config) : null,
      protection: available ? structuredClone(state.protection) : null, result: lastCommand ? structuredClone(lastCommand) : null };
  }
  function receive(topicName, payload, packet = {}, receivedAt = clock()) {
    if (!connected || topicName !== settings.stateTopic) return false;
    const value = decodeGarageEnvelope(payload, { receivedAt, schema: GARAGE_SENDER_CONTRACT });
    if (!value || value.observedAt > receivedAt || receivedAt - value.observedAt >= settings.maxAgeMs
      || typeof value.challenge !== 'string' || !value.challenge || value.challenge.length > 128) return false;
    let config;
    try { config = validateSenderProtectionSettings(value.config); } catch { return false; }
    const protection = protectionState(value.protection);
    if (!protection) return false;
    const identity = `${value.deviceId}:${value.bootId}`;
    if (retiredBoots.has(identity)) return false;
    if (state && value.deviceId === state.deviceId && value.bootId === state.bootId && value.sequence <= state.sequence) return false;
    if (state && `${state.deviceId}:${state.bootId}` !== identity) {
      retiredBoots.add(`${state.deviceId}:${state.bootId}`); usedChallenge = null;
      if (retiredBoots.size > 16) retiredBoots.delete(retiredBoots.values().next().value);
      if (lastCommand?.status === 'published') lastCommand = { ...lastCommand, status: 'uncertain', reason: 'The local frost-protection unit restarted.' };
    }
    state = { deviceId: value.deviceId, bootId: value.bootId, sequence: value.sequence,
      observedAt: value.observedAt, receivedAt, retained: packet.retain === true, challenge: value.challenge, config, protection };
    if (lastCommand && value.result?.commandId === lastCommand.commandId
      && ['applied', 'rejected', 'failed'].includes(value.result.status))
      lastCommand = { ...lastCommand, status: value.result.status, reason: value.result.reason ?? null };
    onState(snapshot());
    if (!packet.retain) for (const location of ['rear', 'front']) {
      const row = protection.locations[location];
      onObservation({ source: 'garage-sender', device: value.deviceId, signal: `garage_pipe_${location}_temperature`,
        value: row.uncertain ? null : row.estimatedC, unit: 'degC', sourceTime: value.observedAt, receivedAt,
        quality: row.uncertain || row.estimatedC === null ? ['unknown'] : ['estimated'],
        raw: { usableForControl: false, estimated: true, schema: GARAGE_SENDER_CONTRACT,
          reportIntervalMs: 30_000, reportGraceMs: settings.maxAgeMs - 30_000 } });
    }
    return true;
  }
  return { topics: settings.stateTopic ? [settings.stateTopic] : [], receive, snapshot, status,
    setConnected(value) { connected = Boolean(value); state = null; usedChallenge = null; },
    subscriptionFailed() { connected = false; },
    async setConfiguration(input) {
      const config = validateSenderProtectionSettings(input), now = clock(), view = status(now);
      if (!view.settingsAvailable) throw Object.assign(new Error(view.settingsReason), { statusCode: 409 });
      const command = { schema: GARAGE_SENDER_CONTRACT, bootId: state.bootId, challenge: state.challenge,
        commandId: randomUUID(), action: 'configure', config };
      usedChallenge = state.challenge; lastCommand = { commandId: command.commandId, requestedAt: now, status: 'published', reason: null };
      onState(snapshot());
      try { await publish(settings.commandTopic, JSON.stringify(command), { qos: 0, retain: false, noReplay: true }); }
      catch { lastCommand = { ...lastCommand, status: 'uncertain', reason: 'Local frost-protection settings delivery is unconfirmed.' }; onState(snapshot());
        throw Object.assign(new Error(lastCommand.reason), { statusCode: 503 }); }
      return { ...lastCommand };
    },
    async close() { connected = false; },
  };
}
