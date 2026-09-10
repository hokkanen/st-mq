import mqtt from 'mqtt';

export const HEATING_COMMANDS = Object.freeze(['heatoff', 'heaton15', 'heaton60']);
const TOPIC = 'from_stmq/heat/action';
const MESSAGES = {
  MQTT_COMMAND_INVALID: 'Choose heatoff, heaton15, or heaton60.',
  MQTT_CONNECTION_FAILED: 'Could not connect to the MQTT broker. Check the broker address and connection settings. No command was sent.',
  MQTT_CONNECTION_REFUSED: 'The MQTT broker refused the connection. Check that it is running and accepting connections on the configured port. No command was sent.',
  MQTT_NETWORK_UNREACHABLE: 'The MQTT broker is unreachable from this server. Check the broker address, network connection and routing. No command was sent.',
  MQTT_DNS_FAILED: 'The MQTT broker hostname could not be resolved. Check the broker address and DNS. No command was sent.',
  MQTT_AUTH_FAILED: 'The MQTT broker rejected the login or access permissions. Check the MQTT username, password and broker permissions. No command was sent.',
  MQTT_TLS_FAILED: 'The secure MQTT connection failed. Check the broker certificate and TLS settings. No command was sent.',
  MQTT_CONNECTION_TIMEOUT: 'The MQTT broker connection timed out. Check the broker address, port and network connection. No command was sent.',
  MQTT_UNAVAILABLE: 'MQTT acknowledgement was not received. The command may have reached the device; check its state before retrying.',
  MQTT_TIMEOUT: 'MQTT acknowledgement timed out. The command may have reached the device; check its state before retrying.',
  MQTT_CLOSED: 'MQTT command transport is closed. Check device state if a test was in progress.',
  MQTT_BUSY: 'An MQTT test is already in progress. Wait for its result before trying again.',
  MQTT_AUTHORITY_LOST: 'This instance no longer owns device control.',
};
function failure(code) {
  return Object.assign(new Error(MESSAGES[code]), { code });
}
function connectionFailure(error) {
  const code = error?.code;
  // Only fixed categories cross the API boundary; raw errors can contain
  // private broker addresses, usernames or certificate details.
  if (code === 'ECONNREFUSED') return failure('MQTT_CONNECTION_REFUSED');
  if (['EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EHOSTDOWN'].includes(code)) return failure('MQTT_NETWORK_UNREACHABLE');
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) return failure('MQTT_DNS_FAILED');
  if ([4, 5, 134, 135].includes(code)) return failure('MQTT_AUTH_FAILED');
  if (code === 'ETIMEDOUT') return failure('MQTT_CONNECTION_TIMEOUT');
  if (['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_SSL_WRONG_VERSION_NUMBER'].includes(code)) {
    return failure('MQTT_TLS_FAILED');
  }
  return failure('MQTT_CONNECTION_FAILED');
}
export function heatingErrorMessage(code) {
  return Object.hasOwn(MESSAGES, code) ? MESSAGES[code]
    : 'MQTT test failed. Delivery is unconfirmed; check the broker connection.';
}

// A new, short-lived connection owns each explicit batch. Nothing is retained,
// reconnected, or saved for a later retry when the broker is unavailable.
export function createHeatingTransport({ connection, connect = mqtt.connect, timeoutMs = 10_000, canControl = () => true }) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('MQTT timeout must be positive');
  let active = null;
  let closed = false;

  return {
    async publish(commands) {
      const batch = Array.isArray(commands) ? [...commands] : [];
      if (!batch.length || batch.some(command => !HEATING_COMMANDS.includes(command))) {
        throw failure('MQTT_COMMAND_INVALID');
      }
      if (closed) throw failure('MQTT_CLOSED');
      if (!canControl()) throw failure('MQTT_AUTHORITY_LOST');
      if (active) throw failure('MQTT_BUSY');
      if (!connection || typeof connection.address !== 'string' || !connection.address.trim()) throw failure('MQTT_CONNECTION_FAILED');

      let client;
      let finished = false;
      let started = false;
      let publishAttempted = false;
      let index = 0;
      let timer;
      let resolveBatch;
      let rejectBatch;
      const completion = new Promise((resolve, reject) => { resolveBatch = resolve; rejectBatch = reject; });

      const dispose = () => new Promise(resolve => {
        if (!client) { resolve(); return; }
        let cleanupTimer;
        const complete = () => { clearTimeout(cleanupTimer); resolve(); };
        // end(true) destroys the stream and clears MQTT's timers/stores. Bound
        // cleanup too, so shutdown cannot leave an HTTP test request hanging.
        cleanupTimer = setTimeout(() => {
          try { client.stream?.destroy(); } catch { /* Never expose transport details. */ }
          complete();
        }, Math.min(timeoutMs, 1000));
        try { client.end(true, {}, complete); }
        catch {
          try { client.stream?.destroy(); } catch { /* Never expose transport details. */ }
          complete();
        }
      });
      const finish = error => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        // Keep the error handler through disposal to absorb late socket errors.
        client?.removeListener?.('connect', connected);
        client?.removeListener?.('close', disconnected);
        client?.removeListener?.('offline', disconnected);
        dispose().then(() => {
          active = null;
          if (error) rejectBatch(error);
          else resolveBatch({ status: 'mqtt', sent: true, actual: null });
        });
      };
      const disconnected = error => finish(publishAttempted ? failure('MQTT_UNAVAILABLE') : connectionFailure(error));
      const publishNext = () => {
        if (finished) return;
        if (!canControl()) { finish(failure('MQTT_AUTHORITY_LOST')); return; }
        if (index === batch.length) { finish(); return; }
        const command = batch[index++];
        try {
          publishAttempted = true;
          client.publish(TOPIC, command, { qos: 1, retain: false }, error => {
            if (finished) return;
            if (error) finish(failure('MQTT_UNAVAILABLE'));
            else publishNext(); // QoS 1 callback runs only after broker PUBACK.
          });
        } catch { finish(failure('MQTT_UNAVAILABLE')); }
      };
      const connected = () => {
        if (started || finished) return;
        started = true;
        publishNext();
      };

      active = { completion, cancel: () => finish(failure('MQTT_CLOSED')) };
      timer = setTimeout(() => finish(failure(publishAttempted ? 'MQTT_TIMEOUT' : 'MQTT_CONNECTION_TIMEOUT')), timeoutMs);
      try {
        client = connect(connection.address, {
          username: connection.user, password: connection.pw,
          reconnectPeriod: 0, queueQoSZero: false, clean: true,
          connectTimeout: timeoutMs,
        });
        client.on('error', disconnected);
        client.on('close', disconnected);
        client.on('offline', disconnected);
        client.on('connect', connected);
        if (client.connected) connected();
      } catch (error) { disconnected(error); }
      return completion;
    },

    async close() {
      closed = true;
      const pending = active;
      pending?.cancel();
      await pending?.completion.catch(() => {});
    },
  };
}
