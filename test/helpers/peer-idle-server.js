import { PairPeer } from '../../src/pairing/peer.js';

let connections = 0, handled = 0;
const peer = new PairPeer({ token: 'synthetic-idle-peer-token-0123456789abcdef', pairId: 'synthetic-idle',
  listenHost: '127.0.0.1', port: 0, handler: async () => ({ connections, handled: ++handled }) });
const address = await peer.start();
peer.server.keepAliveTimeout = 2000;
peer.server.keepAliveTimeoutBuffer = 0;
peer.server.on('connection', () => connections++);
let closing;
const close = () => closing ??= peer.close().finally(() => { if (process.connected) process.disconnect(); });
process.on('message', message => { if (message === 'close') void close(); });
process.on('disconnect', () => { void close(); });
process.send({ port: address.port });
