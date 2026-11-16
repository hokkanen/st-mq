/** Give an EventEmitter MQTT fixture the byte-write boundary used by the
 * production publication gate. The supplied publisher still owns its replies
 * and broker acknowledgement; neither is evidence that bytes were written. */
export function withMqttWriteBoundary(client) {
  const publish = client.publish;
  let messageId = 0;
  client.connected ??= true;
  client.stream = { write: () => true };
  client.getLastMessageId = () => messageId;
  client._sendPacket = function(packet, callback) { return this._writePacket(packet, callback); };
  client._writePacket = function(packet, callback) {
    this.emit('packetsend', packet);
    this.stream.write(Buffer.from(String(packet.payload)));
    return publish.call(this, packet.topic, packet.payload, packet.options, callback);
  };
  client.publish = function(topic, payload, options, callback) {
    return this._sendPacket({ cmd: 'publish', topic, payload, qos: options?.qos ?? 0,
      messageId: ++messageId, options }, callback);
  };
  return client;
}
