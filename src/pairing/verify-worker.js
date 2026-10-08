import { parentPort, workerData } from 'node:worker_threads';
import { snapshotDigest } from '../replication/publication.js';
import { verifyDatabase } from '../storage/full-verifier.js';
import { databaseErrorDetails } from '../storage/database-errors.js';

try {
  await verifyDatabase({ dbPath: workerData.path, checkpoint: workerData.metadata.checkpoint });
  const actual = await snapshotDigest(workerData.path);
  if (actual.digest !== workerData.metadata.digest || actual.bytes !== workerData.metadata.bytes) throw Error();
  parentPort.postMessage({ ok: true });
} catch (error) { parentPort.postMessage({ ok: false, ...databaseErrorDetails(error) }); }
