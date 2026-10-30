import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { classifySourceTime } from '../domain/time-evidence.js';

export const MEROSS_STATE = 'Appliance.GarageDoor.State';
const digest = (id, key, timestamp) => createHash('md5').update(`${id}${key}${timestamp}`).digest('hex');
export function merossMessage(key, from, method, payload, now = Date.now(), namespace = MEROSS_STATE) {
  const messageId = randomBytes(16).toString('hex'), timestamp = Math.floor(now / 1000);
  return { header: { messageId, namespace, method, payloadVersion: 1,
    from, timestamp, timestampMs: 0, sign: digest(messageId, key, timestamp) }, payload };
}
// Meross signatures authenticate the header, not the payload. Broker ACLs and a
// trusted LAN remain required. Never treat SETACK as contact evidence.
export function validMerossMessage(message, key) {
  const h = message?.header;
  if (!h || !/^[a-f0-9]{32}$/.test(h.messageId) || !Number.isSafeInteger(h.timestamp)
    || !/^[a-f0-9]{32}$/.test(h.sign)) return false;
  return timingSafeEqual(Buffer.from(h.sign), Buffer.from(digest(h.messageId, key, h.timestamp)));
}

export function createMerossProtocol({ devices, clock }) {
  const replyTopic = `/app/stmq-${randomBytes(16).toString('hex')}/subscribe`;
  const pending = new Map(), seen = new Map(), sessionReplies = new Map();
  const parse = body => { try { return JSON.parse(String(body)); } catch { return null; } };
  const rows = devices.filter(d => d.meross);
  const find = (topic, body) => rows.find(d => d.mqtt.commandTopic === topic
    && [d.mqtt.openPayload, d.mqtt.closePayload, d.mqtt.requestPayload].includes(String(body)));
  const prune = () => {
    for (const [body, entry] of sessionReplies) if (clock() - entry.at > 10_000) sessionReplies.delete(body);
    for (const [id, entry] of pending) if (clock() - entry.at > 10_000) pending.delete(id);
    for (const [id, at] of seen) if (clock() - at > 120_000) seen.delete(id);
    while (seen.size > 512) seen.delete(seen.keys().next().value);
  };
  return {
    replyTopic,
    reset() { pending.clear(); seen.clear(); sessionReplies.clear(); },
    isSessionReply(topic, body) {
      prune(); return sessionReplies.get(String(body))?.topic === topic;
    },
    sessionReply(d, topic, body, packet) {
      if (packet.retain || topic !== d.topic) return null;
      const m = parse(body), h = m?.header;
      if (!validMerossMessage(m, d.meross.key) || h.from !== `/appliance/${d.meross.uuid}/publish`) return null;
      const bind = h.namespace === 'Appliance.Control.Bind' && h.method === 'SET';
      const clockRequest = h.namespace === 'Appliance.System.Clock' && h.method === 'PUSH';
      if (!bind && !clockRequest) return null;
      prune();
      const identity = `session:${d.meross.uuid}:${h.namespace}:${h.messageId}`;
      if (seen.has(identity)) return null;
      seen.set(identity, clock());
      let reply;
      if (bind) {
        reply = merossMessage(d.meross.key, d.mqtt.commandTopic, 'SETACK', {}, clock(), h.namespace);
        reply.header.messageId = h.messageId;
        reply.header.sign = digest(h.messageId, d.meross.key, reply.header.timestamp);
      } else {
        const header = { ...h, triggerSrc: 'CloudControl' }; delete header.uuid;
        reply = { header, payload: { clock: { timestamp: Math.floor(clock() / 1000) } } };
      }
      const encoded = JSON.stringify(reply);
      while (sessionReplies.size >= 16) sessionReplies.delete(sessionReplies.keys().next().value);
      sessionReplies.set(encoded, { topic: d.mqtt.commandTopic, at: clock() });
      return encoded;
    },
    encode(topic, body) {
      const d = find(topic, body); if (!d) return body;
      prune();
      const query = body === d.mqtt.requestPayload;
      const message = merossMessage(d.meross.key, replyTopic, query ? 'GET' : 'SET',
        { state: query ? [{ channel: d.meross.channel }] : { channel: d.meross.channel, open: Number(body === d.mqtt.openPayload) } }, clock());
      if (query) {
        // One outstanding query per channel; bounded even if the device is gone.
        for (const [id, entry] of pending) if (entry.device === d.id) pending.delete(id);
        pending.set(message.header.messageId, { device: d.id, at: clock() });
      }
      return JSON.stringify(message);
    },
    classify(topic, body, method) {
      const m = parse(body);
      return rows.some(d => topic === d.mqtt.commandTopic && validMerossMessage(m, d.meross.key)
        && m.header.from === replyTopic && m.header.namespace === MEROSS_STATE && m.header.method === method);
    },
    decode(d, topic, body, packet, receivedAt) {
      if (packet.retain || ![d.topic, replyTopic].includes(topic) || Buffer.byteLength(String(body)) > 65536) return null;
      const m = parse(body), h = m?.header;
      if (!validMerossMessage(m, d.meross.key) || h.namespace !== MEROSS_STATE
        || !['GETACK', 'PUSH'].includes(h.method) || h.from !== `/appliance/${d.meross.uuid}/publish`
        || !['ready', 'pending'].includes(classifySourceTime({ sourceTime: h.timestamp * 1000,
          receivedAt, now: receivedAt, maxAgeMs: 10_000 }).status)) return null;
      prune();
      if (h.method === 'GETACK' && pending.get(h.messageId)?.device !== d.id) return null;
      const seenKey = `${d.id}:${h.messageId}`;
      if (seen.has(seenKey)) return null;
      const state = Array.isArray(m.payload?.state) ? m.payload.state : [m.payload?.state];
      const s = state.find(s => s?.channel === d.meross.channel);
      if (!s || ![0, 1].includes(s.open) || s.execute) return null;
      seen.set(seenKey, receivedAt); pending.delete(h.messageId);
      return JSON.stringify({ open: s.open, timestamp: h.timestamp * 1000 });
    },
  };
}
