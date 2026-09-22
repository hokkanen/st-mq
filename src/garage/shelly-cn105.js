import { SHELLY_CN105_CONTRACT, garageAdapterSettings } from './contract.js';

const transports = new WeakSet();
export const SHELLY_CN105_COMMISSIONING = Object.freeze([
  'selectivePowerVerified', 'lowHeatVerified', 'expiryVerified', 'restartVerified',
]);

/** The production transport is selected explicitly, independently of host
 * fixtures. Device commissioning and native evidence remain adapter gates. */
export function createShellyCn105Transport({ settings, publish }) {
  const config = garageAdapterSettings(settings);
  if (config.driver !== 'shelly-cn105' || !config.commandTopic) return null;
  if (typeof publish !== 'function') throw new TypeError('Shelly CN105 requires an MQTT publisher');
  const transport = Object.freeze({
    send(command) {
      if (command.schema !== SHELLY_CN105_CONTRACT || !['claim', 'start', 'renew', 'release', 'manual', 'remote-temperature'].includes(command.action))
        throw new TypeError('Unsupported Shelly CN105 command');
      // QoS 0 and queueQoSZero:false prevent offline replay; native results and
      // protocol challenges handle an uncertain publication outcome.
      return publish(config.commandTopic, JSON.stringify(command), { qos: 0, retain: false, noReplay: true });
    },
  });
  transports.add(transport);
  return transport;
}

export const isShellyCn105Transport = value => transports.has(value);
