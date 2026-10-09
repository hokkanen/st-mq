import { createHash } from 'node:crypto';

export const HEATING_COMMANDS = Object.freeze(['reduction', 'normal', 'circulation']);
const MESSAGES = {
  SHELLY_IDENTITY_UNAVAILABLE: 'The relay identity has not been confirmed. Wait for a fresh device report.',
  SHELLY_READBACK_UNAVAILABLE: 'Relay feedback became unavailable. The command may have reached the relay; check its reported state.',
  SHELLY_READBACK_TIMEOUT: 'The relay did not confirm this command before the timeout. It may already have changed; check its reported state.',
  SHELLY_COMMAND_UNCONFIRMED: 'The relay command could not be confirmed. It may have reached the device; check its reported state.',
  SHELLY_CONTROL_FAILED: 'The relay request failed. Check its current availability and reported state.',
  FLOOR_PENDING: 'Waiting for the previous floor-heating override to be restored.',
  EXECUTOR_BUSY: 'A heating request is already in progress. Wait for its result.',
  EXECUTOR_UNCONFIRMED: 'The heating request could not be confirmed. Check the reported equipment state.',

  MQTT_COMMAND_INVALID: 'Choose normal heating, reduced heating, or circulation.',
  MQTT_RELAY_UNAVAILABLE: 'Configure a direct tariff relay with live device readback before requesting heating.',
  MQTT_UNAVAILABLE: 'MQTT acknowledgement was not received. The command may have reached the device; check its state before retrying.',
  MQTT_STORAGE_PENDING: 'The device command was not sent because received readings are still waiting to be saved.',
  MQTT_STORAGE_FAILED: 'The device command was not sent because an incoming observation could not be saved. Waiting for fresh recorded evidence.',
  MQTT_CLOSED: 'MQTT command transport is closed. Check device state if a test was in progress.',
  MQTT_BUSY: 'An MQTT test is already in progress. Wait for its result before trying again.',
  MQTT_AUTHORITY_LOST: 'This instance no longer owns device control.',
  MQTT_DHWR_UNAVAILABLE: 'Configure a direct circulation relay with live device readback before starting circulation.',
  EXECUTOR_TARGET_CHANGED: 'The original heating target is unavailable or changed. Its restoration remains pending until the original target is available.',
  EXECUTOR_EXPIRED: 'The heating action expired before dispatch. Its temporary settings are being restored.',
  EXECUTOR_RESTORATION_PENDING: 'Wait for the previous heating settings to be restored.',
};
function failure(code) {
  return Object.assign(new Error(MESSAGES[code]), { code });
}
export function heatingErrorMessage(code) {
  return Object.hasOwn(MESSAGES, code) ? MESSAGES[code]
    : 'The heating request could not be confirmed. Check the reported equipment state.';
}
export const heatingErrorCode = code => typeof code === 'string' && Object.hasOwn(MESSAGES, code) ? code : null;

// Equipment acquisition owns direct native RPC, command fencing and readback.
// This dispatcher gives timed circulation and heating one exclusive command lane.
export function createHeatingTransport({ canControl = () => true } = {}) {
  let active = null, closed = false;
  let heatingRelay = null, heatingIdentity = null, dhwrRelay = null, dhwrIdentity = null;
  const digest = value => value ? createHash('sha256').update(JSON.stringify(value)).digest('hex') : null;
  const identity = value => typeof value === 'function' ? value() : value;
  async function dispatch(handler, value, { validUntil = Infinity, clock = Date.now, expectedTarget = null, target } = {}) {
    if (closed) throw failure('MQTT_CLOSED');
    if (!canControl()) throw failure('MQTT_AUTHORITY_LOST');
    if (active) throw failure('MQTT_BUSY');
    if (!handler) throw failure(target === 'dhwr' ? 'MQTT_DHWR_UNAVAILABLE' : 'MQTT_RELAY_UNAVAILABLE');
    const beforePublish = () => {
      if (closed) throw failure('MQTT_CLOSED');
      if (!canControl()) throw failure('MQTT_AUTHORITY_LOST');
      if (clock() >= validUntil || expectedTarget && transport.targetIdentity[target] !== expectedTarget)
        throw failure('EXECUTOR_EXPIRED');
    };
    const completion = Promise.resolve().then(() => {
      beforePublish();
      return handler(value, { beforePublish });
    });
    active = completion;
    try {
      const result = await completion;
      if (closed) throw failure('MQTT_CLOSED');
      if (!canControl()) throw failure('MQTT_AUTHORITY_LOST');
      return result;
    } finally { active = null; }
  }
  const transport = {
    get targetIdentity() {
      const tariff = identity(heatingIdentity), dhwr = identity(dhwrIdentity);
      return { tariff: tariff ? digest({ protocol: 'mqtt-tariff', route: tariff }) : null,
        dhwr: dhwr ? digest({ protocol: 'shelly-circulation', route: dhwr }) : null };
    },
    setHeatingRelay(handler, route) { heatingRelay = handler; heatingIdentity = route; },
    setDhwrRelay(handler, route) { dhwrRelay = handler; dhwrIdentity = route; },
    async publish(commands, options = {}) {
      const batch = Array.isArray(commands) ? [...commands] : [];
      if (!batch.length || batch.some(command => !['reduction', 'normal'].includes(command)))
        throw failure('MQTT_COMMAND_INVALID');
      return dispatch(heatingRelay, batch, { ...options, target: 'tariff' });
    },
    async publishDhwr(on, { expectedTarget = transport.targetIdentity.dhwr, validUntil = Infinity, clock = Date.now } = {}) {
      if (typeof on !== 'boolean') throw failure('MQTT_COMMAND_INVALID');
      return dispatch(dhwrRelay, on, { target: 'dhwr', expectedTarget, validUntil, clock });
    },
    // Native requests have bounded readback deadlines. Drain their handler before
    // closing acquisition so a later step cannot outlive this dispatcher.
    async close() { closed = true; await active?.catch(() => {}); },
  };
  return transport;
}
