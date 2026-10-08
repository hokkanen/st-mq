import { randomUUID } from 'node:crypto';
import { lstat, readFile, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { peerOperation } from './coalesced.js';
import { databaseCheckpoint, JOURNAL_DIGEST, sameCheckpoint, validCheckpoint } from './incremental.js';
import { durableJson, GENERATION_PATTERN, PUBLICATION_FORMAT, readReplicaPublication, replicationError, syncDirectory, validatePublicationDatabasePath } from './publication.js';

const pendingPath = directory => join(directory, 'journal-publication.json');
const withoutPath = ({ dbPath, ...publication }) => publication;
async function removePending(directory) {
  await rm(pendingPath(directory));
  // A completed role change may start new writes immediately. Its old receipt
  // must not reappear after power loss and describe an earlier checkpoint.
  await syncDirectory(directory);
}

/** The pending receipt is durable before applying a batch. SQLite atomically
 * commits its rows and checkpoint; a crash can therefore select exactly the
 * old or new receipt, never infer success from an incomplete transfer. */
export async function recoverJournalPublication(directory, { signal } = {}) {
  let pending;
  try { pending = JSON.parse(await readFile(pendingPath(directory), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return readReplicaPublication(directory); throw replicationError('invalid_publication'); }
  const current = await readReplicaPublication(directory);
  if (!current || pending.version !== 1 || pending.next?.fileGeneration !== current.fileGeneration
    || pending.next?.format !== PUBLICATION_FORMAT || pending.next.databasePath !== current.databasePath
    || !validCheckpoint(pending.from) || !validCheckpoint(pending.next.checkpoint)
    || pending.next.checkpoint.databaseId !== pending.from.databaseId
    || pending.next.checkpoint.sequence < pending.from.sequence || pending.next.digest !== pending.next.checkpoint.hash
    || pending.next.digestAlgorithm !== JOURNAL_DIGEST
    || ![undefined,'peer-seed'].includes(pending.kind)) throw replicationError('invalid_publication');
  const actual = await databaseCheckpoint({ dbPath: current.dbPath, signal });
  if (sameCheckpoint(actual, pending.next.checkpoint)) {
    if(pending.kind==='peer-seed') await peerOperation('accept',{dbPath:current.dbPath,checkpoint:actual,signal});
    await durableJson(join(directory, 'publication.json'), pending.next);
  } else if (!sameCheckpoint(actual, pending.from)) throw replicationError('verification_failed');
  await removePending(directory);
  return readReplicaPublication(directory);
}

/** Caller owns the receiver lock and has checked pair authority. Publication
 * never clones the database; WAL readers keep their already pinned transaction. */
export function applyPeerPublication({transfer,...options}) {
  return applyPublication({...options,from:transfer.metadata.base,to:transfer.metadata.target,
    apply:dbPath=>peerOperation('apply',{dbPath,path:transfer.path,metadata:transfer.metadata,signal:options.signal})});
}
export function publishCheckpointMetadata({checkpoint,...options}) {
  return applyPublication({...options,from:checkpoint,to:checkpoint,apply:async()=>{}});
}
/** A verified seed carries the source's old peer anchor. Reset that internal
 * bookkeeping under the same durable publication receipt as ordinary updates.
 * Its SQLite pages change, so subsequent proof names the application checkpoint. */
export async function acceptPeerPublication({directory,signal,guard=async()=>{}}) {
  const previous=await recoverJournalPublication(directory,{signal});
  if(!previous)throw replicationError('invalid_publication');
  const anchor=await peerOperation('anchor',{dbPath:previous.dbPath,signal});
  if(!anchor)return previous;
  return applyPublication({directory,signal,guard,from:previous.checkpoint,to:previous.checkpoint,
    metadata:previous,kind:'peer-seed',apply:dbPath=>peerOperation('accept',{dbPath,checkpoint:previous.checkpoint,signal})});
}
async function applyPublication({ directory, from, to, apply, metadata, signal,
  kind,guard = async () => {}, beforeCommit = async () => {} }) {
  const previous = await recoverJournalPublication(directory, { signal });
  if(previous && !sameCheckpoint(from,to) && sameCheckpoint(previous.checkpoint,to)) {await guard();return previous;}
  if (!previous || !sameCheckpoint(previous.checkpoint, from)) throw replicationError('verification_failed');
  await guard();
  const actual = await databaseCheckpoint({ dbPath: previous.dbPath, signal });
  if (!sameCheckpoint(actual, from)) throw replicationError('verification_failed');
  const { databasePath: ignoredPath, dbPath: ignoredDbPath, fileGeneration: ignoredGeneration, ...remoteMetadata } = metadata;
  const next = { ...withoutPath(previous), ...remoteMetadata, format: PUBLICATION_FORMAT,
    generation: metadata.generation ?? randomUUID(), fileGeneration: previous.fileGeneration,
    checkpoint: to, digest: to.hash, digestAlgorithm: JOURNAL_DIGEST,
    verifiedAt: Date.now(), previousGeneration: null };
  await durableJson(pendingPath(directory), { version: 1, from: from, next,...(kind?{kind}:{}) });
  await guard();
  await beforeCommit();
  await apply(previous.dbPath);
  // A failed acknowledgement leaves the durable receipt for restart/retry.
  await durableJson(join(directory, 'publication.json'), next);
  await removePending(directory);
  return { ...next, dbPath: previous.dbPath };
}

/** Role changes reuse the closed database at its existing physical location.
 * The local configuration roots authorize this selector; peer metadata cannot. */
export async function adoptJournalDatabase({ directory, dbPath, metadata, signal }) {
  const databasePath = await validatePublicationDatabasePath(directory, dbPath);
  const checkpoint = await databaseCheckpoint({ dbPath: databasePath, signal });
  if (!sameCheckpoint(checkpoint, metadata.checkpoint)) throw replicationError('verification_failed');
  const { dbPath: ignoredDbPath, databasePath: ignoredPath, fileGeneration: ignoredGeneration, ...remoteMetadata } = metadata;
  const namedGeneration = /^snapshot-(.+)\.sqlite$/.exec(basename(databasePath))?.[1];
  const fileGeneration = dirname(databasePath) === resolve(directory) && GENERATION_PATTERN.test(namedGeneration ?? '')
    ? namedGeneration : randomUUID();
  const publication = { ...remoteMetadata, checkpoint, databasePath, format: PUBLICATION_FORMAT,
    fileGeneration, digest: checkpoint.hash, digestAlgorithm: JOURNAL_DIGEST,
    previousGeneration: null, verifiedAt: Date.now() };
  await durableJson(join(directory, 'publication.json'), publication);
  return { ...publication, dbPath: databasePath };
}

export async function checkpointMetadata({ dbPath, checkpoint, claim, sequence, clock = Date.now }) {
  const at = clock();
  return { generation: randomUUID(), checkpoint, digest: checkpoint.hash, digestAlgorithm: JOURNAL_DIGEST,
    bytes: (await lstat(dbPath)).size, sourceStartedAt: at, sourceAt: at,
    ...(claim ? { claim, sequence, chunkBytes: 1024 * 1024 } : {}) };
}
