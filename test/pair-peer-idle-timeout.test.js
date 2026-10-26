import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { PairPeer } from '../src/pairing/peer.js';

const options = { token: 'synthetic-pair-idle-test-token-0123456789abcdef', pairId: 'synthetic-idle-pair' };
function freedSocket(hint) {
  return { timeout: 0, keepAlive: null, unreferenced: false,
    _httpMessage: { res: { headers: hint ? { 'keep-alive': hint } : {} } },
    setKeepAlive(enabled, delay) { this.keepAlive = { enabled, delay }; return this; },
    unref() { this.unreferenced = true; return this; },
    setTimeout(timeout) { this.timeout = timeout; return this; } };
}

for (const [protocol, Agent] of [['http', HttpAgent], ['https', HttpsAgent]]) {
  for (const timeoutMs of [25, 30000]) test(`${protocol} peer idle sockets honor their budget and buffered server expiry (${timeoutMs} ms)`, async t => {
    const peer = new PairPeer({ ...options, timeoutMs }); t.after(() => peer.close());
    const agent = peer.agents[protocol], socket = freedSocket('timeout=5');
    assert(agent instanceof Agent, 'The actual native agent applies the server hint');
    assert.equal(agent.keepSocketAlive(socket), true);
    assert(Number.isFinite(socket.timeout) && socket.timeout > 0, 'A freed peer socket needs a finite positive expiry');
    assert(socket.timeout < 5000, 'Idle reuse must end before the advertised server expiry');
    assert(socket.timeout <= timeoutMs, 'Idle reuse must stay within the peer timeout budget');
    assert.equal(socket.keepAlive.enabled, true); assert.equal(socket.unreferenced, true);
  });

  test(`${protocol} peer idle sockets retain a finite budget when no server hint is supplied`, async t => {
    const timeoutMs = 30000, peer = new PairPeer({ ...options, timeoutMs }); t.after(() => peer.close());
    const socket = freedSocket();
    assert.equal(peer.agents[protocol].keepSocketAlive(socket), true);
    assert.equal(socket.timeout, timeoutMs);
  });
}
