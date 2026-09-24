import { createHash } from 'node:crypto';

/** Bounded receiver-local delivery memory; MQTT DUP alone is not prior receipt.
 * Source timestamps remain authoritative after this transport filter. */
export function createMqttAdmission({ limit = 512, windowMs = 300_000 } = {}) {
  const seen = new Map();
  return {
    reset() { seen.clear(); },
    checkpoint() { return [...seen]; },
    restore(checkpoint) {
      seen.clear();
      for (const [key, at] of checkpoint.slice(-limit)) seen.set(key, at);
    },
    admit(topic, body, packet, at, { timestamped = false, correlated = false } = {}) {
      const key = `${topic}:${packet.messageId ?? 'none'}:${createHash('sha256').update(body).digest('hex')}`;
      for (const [id, receivedAt] of seen) if (receivedAt > at || at - receivedAt > windowMs) seen.delete(id);
      if (packet.dup && (seen.has(key) || !timestamped && !correlated)) return false;
      seen.delete(key); seen.set(key, at);
      while (seen.size > limit) seen.delete(seen.keys().next().value);
      return true;
    },
  };
}
