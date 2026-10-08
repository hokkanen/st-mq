import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { configurePublicationRoots, durableJson, ownedDirectory } from '../replication/publication.js';
import { databaseCheckpoint } from '../replication/incremental.js';
import { adoptJournalDatabase, checkpointMetadata } from '../replication/journal-publication.js';
import { startReplica } from '../app/replica.js';
import { compareAuthority, validClaim } from '../pairing/state.js';
import { ControllerAnnouncements } from '../pairing/announcements.js';

export const CONTROL_SCOPE = 'from_stmq/heat/action';

export async function stoppedControllerViewer({ config, authority, clock, installSignalHandlers }) {
  const directory = join(config.dataDir, 'controller-authority', 'view');
  await ownedDirectory(directory, '.st-mq-authority-view');
  configurePublicationRoots(directory, [dirname(config.dbPath)]);
  try {
    const checkpoint = await databaseCheckpoint({ dbPath: config.dbPath });
    const metadata = await checkpointMetadata({ dbPath: config.dbPath, checkpoint, clock });
    await adoptJournalDatabase({ directory, dbPath: config.dbPath, metadata });
  } catch (error) {
    // Another owner may advance this same file between checkpoint reads. The
    // viewer then reports unavailable history until a matching boundary exists;
    // neither a stale manifest nor this diagnostic path grants control.
    if (error.code !== 'verification_failed') throw error;
  }
  return startReplica({ config: { ...config, role: 'slave' }, snapshotDirectory: directory,
    controlAuthority: authority, clock, installSignalHandlers });
}

/** Duplicate-controller protection also applies to unpaired live instances. */
export async function standaloneAuthority({ config, onLoss, clock = Date.now, connect }) {
  const directory = join(config.dataDir, 'controller-authority');
  const path = join(directory, 'identity.json');
  let identity;
  try {
    identity = JSON.parse(await readFile(path, 'utf8'));
    if (identity.version !== 1 || !validClaim(identity) || identity.role !== 'master' ||
        typeof identity.blocked !== 'boolean') throw new Error('Invalid controller identity');
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Saved controller authority is incompatible or invalid. Preserve the existing files and use a fresh data directory for a deliberate new setup.');
  }
  await ownedDirectory(directory, '.st-mq-controller-authority');
  if (!identity) {
    identity = { version: 1, nodeId: randomUUID(), epoch: randomUUID(), role: 'master',
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
      reason: blocked ? 'Another controller won authority. This instance is read-only; use paired recovery before rejoining.' : null }),
    async reconfigure(connection) {
      if (JSON.stringify(announcements.connection) === JSON.stringify(connection)) return;
      await announcements.close(); announcements.connection = connection;
      if (ready && !blocked && !closed) announcements.start();
    },
    start() { ready = true; if (!blocked) announcements.start(); },
    async close() { closed = true; await announcements.close(); },
  };
}
