import { EventEmitter } from 'node:events';

// Controller discovery is a distinct MQTT connection from acquisition and
// explicit commands. Lifecycle fixtures keep those three roles distinguishable.
export const identityConnection = options => options?.clientId?.startsWith('stmq-identity-');
export function idleIdentityClient() {
  const client = new EventEmitter();
  client.connected = false;
  client.subscribe = (_topic, _options, done) => done?.();
  client.publish = (_topic, _value, _options, done) => done?.();
  client.end = (_force, _options, done) => done?.();
  return client;
}
