import { createHash } from 'node:crypto';

export const HEATING_COMMANDS = Object.freeze(['reduction', 'normal', 'circulation']);
import { heatingErrorMessage } from '../domain/heating-errors.js';
export { heatingErrorMessage, heatingErrorCode } from '../domain/heating-errors.js';

const failure = code => Object.assign(new Error(heatingErrorMessage(code)), { code });

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
