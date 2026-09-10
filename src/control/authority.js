import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { durableJson, ownedDirectory, publishSnapshot } from '../replication/publication.js';
import { createSourceSnapshot } from '../replication/transport.js';
import { startReplica } from '../app/replica.js';
import { compareAuthority, validClaim } from '../pairing/state.js';
import { ControllerAnnouncements } from '../pairing/announcements.js';

export const CONTROL_SCOPE = 'from_stmq/heat/action';

export async function stoppedControllerViewer({ config, authority, clock, installSignalHandlers }) {
  const directory = join(config.dataDir, 'controller-authority', 'view');
  await ownedDirectory(directory, '.st-mq-authority-view');
  const generation = randomUUID(), incoming = join(directory, `incoming-${generation}.sqlite`);
  const snapshot = await createSourceSnapshot({ dbPath: config.dbPath, destination: incoming });
  await publishSnapshot(directory, incoming, { generation, ...snapshot, verifiedAt: clock() });
  return startReplica({ config: { ...config, role: 'replica', replication: { ...config.replication, directory } },
    controlAuthority: authority, clock, installSignalHandlers });
}

/** Duplicate-controller protection also applies to unpaired live instances. */
export async function standaloneAuthority({ config, onLoss, clock = Date.now, connect }) {
  const directory = join(config.dataDir, 'controller-authority');
  await ownedDirectory(directory, '.st-mq-controller-authority');
  const path = join(directory, 'identity.json');
  let identity;
  try {
    identity = JSON.parse(await readFile(path, 'utf8'));
    if (!validClaim(identity) || typeof identity.blocked !== 'boolean') throw new Error('Invalid controller identity');
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Controller identity could not be validated');
    identity = { nodeId: randomUUID(), epoch: randomUUID(), role: 'primary',
      platform: config.addon ? 'hassio' : 'ubuntu', blocked: false };
    await durableJson(path, identity);
  }
  const platform = config.addon ? 'hassio' : 'ubuntu';
  if (identity.platform !== platform) {
    identity = { ...identity, platform };
    await durableJson(path, identity);
  }
  let blocked = identity.blocked, closed = false, ready = false;
  const announcements = new ControllerAnnouncements({ connection: config.connections.mqtt, scope: CONTROL_SCOPE,
    clock, connect, claim: () => !ready || blocked || closed ? null : identity,
    onConflict: async claim => {
      if (blocked || closed || compareAuthority(identity, claim) >= 0) return;
      blocked = true;
      identity = { ...identity, blocked: true, stoppedAt: clock() };
      // Revoke publication synchronously; durable protection and shutdown follow.
      const stopping = Promise.resolve().then(onLoss);
      await Promise.all([durableJson(path, identity), stopping]);
    } });
  return {
    canControl: () => !blocked && !closed,
    status: () => ({ state: blocked ? 'protected' : 'ready',
      stoppedAt: identity.stoppedAt ?? null,
      reason: blocked ? 'Another ST-MQ controller won authority. This instance is read-only; use paired recovery before rejoining.' : null }),
    async reconfigure(connection) {
      if (JSON.stringify(announcements.connection) === JSON.stringify(connection)) return;
      await announcements.close(); announcements.connection = connection;
      if (ready && !blocked && !closed) announcements.start();
    },
    start() { ready = true; if (!blocked) announcements.start(); },
    async close() { closed = true; await announcements.close(); },
  };
}
