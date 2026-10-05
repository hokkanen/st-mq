// These integrations are hosted by Home Assistant in the supported installation
// contract. Direct hardware and all other MQTT measurements stay on primary.
export const haBackedEquipment = device => device.protocol === 'mqtt'
  && (device.area === 'garage' && device.kind === 'door' || device.kind === 'dehumidifier');

export function mqttRouting(config) {
  const connection = config.connections.mqtt;
  const ha = connection.ha?.address ? connection.ha : null;
  const equipmentBroker = device => ha && haBackedEquipment(device) ? 'ha' : 'primary';
  const vehicleBroker = route => ha && route.provider === 'bmw-cardata' ? 'ha' : 'primary';
  const teslaBroker = ha ? 'ha' : 'primary';
  const identity = source => mqttSourceIdentity(config, source);
  const equipmentIdentity = device => identity(haBackedEquipment(device) ? 'ha' : 'primary');
  return { ha, equipmentBroker, vehicleBroker, teslaBroker, identity, equipmentIdentity };
}
import { mqttSourceIdentity } from '../pairing/mqtt-source-context.js';
