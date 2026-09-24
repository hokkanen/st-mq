/** MQTT.js publication ownership follows the transport through its asynchronous
 * outgoing store, not just the public publish() call. The pinned-client tests
 * cover these internal boundaries. Queries may be reissued by the current
 * runtime; no previous publication is replayed after connection loss. */
export function gateMqttPublications(client, { canControl = () => true, timeoutMs = 10_000 } = {}) {
  const publish = client.publish, send = client._sendPacket, write = client._writePacket;
  const tokens = new Set(), ids = new Map(), packets = new WeakMap();
  let active = null, generation = 0, revoked = false;
  const authority = () => { try { return !revoked && canControl() === true; } catch { return false; } };
  const allowed = token => token && !token.done && token.generation === generation && authority() && client.connected !== false;
  const failure = () => new Error('MQTT publication unavailable; delivery unconfirmed');
  function remove(token) {
    if (!Number.isInteger(token.id)) return;
    if (ids.has(token.id) && ids.get(token.id) !== token) return;
    client.removeOutgoingMessage?.(token.id);
    // An asynchronous store.put may finish after cancellation removed outgoing.
    // Delete that late store entry too; the write gate still prevents dispatch.
    client.outgoingStore?.del?.({ messageId: token.id }, () => {});
  }
  function discard(packet) {
    if (packet.qos > 0 && Number.isInteger(packet.messageId)) {
      client.removeOutgoingMessage?.(packet.messageId);
      client.outgoingStore?.del?.({ messageId: packet.messageId }, () => {});
    }
  }
  function finish(token, error) {
    if (token.done) { if (error) remove(token); return; }
    token.done = true; clearTimeout(token.timer); tokens.delete(token);
    if (error) remove(token);
    if (ids.get(token.id) === token) ids.delete(token.id);
    token.callback?.(error);
  }
  client.publish = function(topic, payload, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    if (!authority() || this.connected === false || this._storeProcessing || this._storeProcessingQueue?.length) {
      callback?.(failure()); return this;
    }
    const token = { generation, callback, done: false, sent: false };
    token.timer = setTimeout(() => finish(token, failure()), timeoutMs); token.timer.unref?.();
    tokens.add(token); const previous = active; active = token;
    try { return publish.call(this, topic, payload, options, error => finish(token, error)); }
    catch { finish(token, failure()); return this; }
    finally { active = previous; }
  };
  if (typeof send === 'function') client._sendPacket = function(packet, ...args) {
    if (packet.cmd !== 'publish') return send.call(this, packet, ...args);
    const token = active ?? packets.get(packet) ?? ids.get(packet.messageId);
    if (active) {
      packets.set(packet, token);
      if (packet.qos > 0) { token.id = packet.messageId; ids.set(token.id, token); }
    }
    if (!allowed(token) || token.sent) { if (token) finish(token, failure()); else discard(packet); args[0]?.(failure()); return; }
    return send.call(this, packet, ...args);
  };
  if (typeof write === 'function') client._writePacket = function(packet, callback) {
    if (packet.cmd !== 'publish') return write.call(this, packet, callback);
    const token = packets.get(packet) ?? ids.get(packet.messageId);
    if (!allowed(token) || token.sent) { if (token) finish(token, failure()); else discard(packet); callback?.(failure()); return; }
    const stream = this.stream, streamWrite = stream?.write;
    let blocked = false, called = false;
    const complete = error => { if (!called) { called = true; callback?.(error); } };
    // packetsend listeners run before MQTT.js writes bytes. Recheck at the
    // actual stream boundary as well, including synchronous revocation there.
    if (typeof streamWrite === 'function') stream.write = function(...args) {
      if (!allowed(token)) { blocked = true; return false; }
      return streamWrite.apply(this, args);
    };
    try { write.call(this, packet, complete); }
    catch { finish(token, failure()); complete(failure()); }
    finally { if (typeof streamWrite === 'function') stream.write = streamWrite; }
    token.sent = true;
    if (blocked) { finish(token, failure()); complete(failure()); stream?.destroy?.(); }
  };
  const cancel = () => { generation++; for (const token of [...tokens]) finish(token, failure()); };
  client.on?.('offline', cancel); client.on?.('close', cancel);
  return { revoke() {
    revoked = true; cancel();
    if (client.options) client.options.reconnectPeriod = 0;
    client._clearReconnect?.();
  } };
}
