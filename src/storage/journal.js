import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { JOURNALED_TABLES, SCHEMA_VERSION } from './schema.js';
import { quoteIdentifier as q } from './journal-schema.js';
import { LEARNING_ALGORITHM } from '../domain/learning-contract.js';
import { assertCurrentChargingSessionCheck } from '../app/charging-session-checks.js';

export const JOURNAL_VERSION = 1;
export const MAX_COMMIT_BYTES = 64 * 1024 * 1024;
const connections = new WeakMap();
const tables = new Map(JOURNALED_TABLES.map(table => [table.name, table]));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code = 'database_journal_invalid') => { throw Object.assign(new Error('The transaction checkpoint could not be verified. Preserve the database and use full verification or an intact current-version backup.'), { code }); };
const raw = db => connections.get(db) ?? { exec: db.exec.bind(db), prepare: db.prepare.bind(db) };
const same = (a,b) => Boolean(a && b && a.databaseId === b.databaseId && a.sequence === b.sequence && a.hash === b.hash);
export const matchingCheckpoint = same;
export function validCheckpoint(value) {
  return value && Object.keys(value).length === 3 && /^[a-f0-9-]{36}$/.test(value.databaseId)
    && Number.isSafeInteger(value.sequence) && value.sequence >= 0 && /^[a-f0-9]{64}$/.test(value.hash);
}
const genesis = databaseId => digest({ version: JOURNAL_VERSION, databaseId, schema: SCHEMA_VERSION, algorithm: LEARNING_ALGORITHM });

export function initializeJournal(db) {
  const databaseId = randomUUID(), hash = genesis(databaseId);
  raw(db).prepare('INSERT INTO journal_meta VALUES(1,?,?,?,?,?)').run(databaseId,0,hash,hash,LEARNING_ALGORITHM);
}
export function readCheckpoint(db) {
  const row = raw(db).prepare('SELECT database_id,sequence,hash FROM journal_meta WHERE id=1').get();
  const value = row && { databaseId: row.database_id, sequence: row.sequence, hash: row.hash };
  if (!validCheckpoint(value)) fail();
  return value;
}
export function checkpointAt(db, sequence) {
  if (!Number.isSafeInteger(sequence) || sequence < 0) fail('journal_checkpoint_invalid');
  const meta = raw(db).prepare('SELECT database_id,genesis_hash FROM journal_meta WHERE id=1').get();
  const row = sequence === 0 ? { hash: meta?.genesis_hash } : raw(db).prepare('SELECT hash FROM journal_commits WHERE sequence=?').get(sequence);
  return row?.hash ? { databaseId: meta.database_id, sequence, hash: row.hash } : null;
}
/** Constant work in history size: structural checks are handled by Store. The
 * head proves committed continuity, not a full scan for latent disk corruption. */
export function validateCheckpoint(db) {
  const state = raw(db), head = readCheckpoint(db);
  const meta = state.prepare('SELECT genesis_hash,algorithm_version FROM journal_meta WHERE id=1').get();
  if (meta.algorithm_version !== LEARNING_ALGORITHM) fail('database_algorithm_mismatch');
  if (meta.genesis_hash !== genesis(head.databaseId) || state.prepare('SELECT 1 FROM journal_pending LIMIT 1').get()) fail();
  const last = state.prepare('SELECT sequence,hash,previous_hash FROM journal_commits ORDER BY sequence DESC LIMIT 1').get();
  if (head.sequence === 0 ? last || head.hash !== meta.genesis_hash
    : !last || last.sequence !== head.sequence || last.hash !== head.hash || last.previous_hash !== checkpointAt(db,head.sequence-1)?.hash) fail();
  return head;
}
export function commonCheckpoint(left, right) {
  const a = readCheckpoint(left), b = readCheckpoint(right);
  if (a.databaseId !== b.databaseId) return null;
  let low = 0, high = Math.min(a.sequence,b.sequence);
  while (low < high) {
    const middle = Math.ceil((low+high)/2);
    if (same(checkpointAt(left,middle),checkpointAt(right,middle))) low=middle;
    else high=middle-1;
  }
  return checkpointAt(left,low);
}
const decodeChange = row => ({ table: row.table_name, key: JSON.parse(row.record_key),
  before: row.before_row === null ? null : JSON.parse(row.before_row), after: row.after_row === null ? null : JSON.parse(row.after_row) });
function readCommit(db, row) {
  return { sequence: row.sequence, previousHash: row.previous_hash, hash: row.hash, at: row.at,
    changes: raw(db).prepare('SELECT * FROM journal_changes WHERE sequence=? ORDER BY ordinal').all(row.sequence).map(decodeChange) };
}
const commitHash = (databaseId,commit) => digest({ version: JOURNAL_VERSION, databaseId,
  sequence: commit.sequence, previousHash: commit.previousHash, at: commit.at, changes: commit.changes });
function validateChange(change) {
  const table = tables.get(change?.table);
  if (!table || Object.keys(change).sort().join(',') !== 'after,before,key,table'
    || !Array.isArray(change.key) || change.key.length !== table.keys.length || change.before === null && change.after === null) fail();
  for (const row of [change.before,change.after]) {
    if (row === null) continue;
    if (!row || Object.keys(row).length !== table.columns.length || table.columns.some(key => !Object.hasOwn(row,key))) fail();
    if (Object.values(row).some(value => value !== null && !['number','string'].includes(typeof value)
      || typeof value === 'number' && !Number.isFinite(value))) fail();
  }
  const keyRow = change.after ?? change.before;
  if (!isDeepStrictEqual(change.key,table.keys.map(key => keyRow[key]))) fail();
  if (change.before && change.after && !isDeepStrictEqual(change.key,table.keys.map(key => change.before[key])))
    fail('journal_identity_changed');
  if (change.table === 'learning_journal_entries' && change.after?.algorithm_version !== undefined
    && change.after.algorithm_version !== LEARNING_ALGORITHM) fail('database_algorithm_mismatch');
  if (change.table === 'events' && change.after?.type === 'charging-session-check') {
    try { assertCurrentChargingSessionCheck(JSON.parse(change.after.payload)); } catch { fail('database_state_incompatible'); }
  }
  return table;
}
function persistCommit(db,commit) {
  const state = raw(db), bytes = Buffer.byteLength(JSON.stringify(commit));
  if (bytes > MAX_COMMIT_BYTES) fail('journal_transaction_too_large');
  state.prepare('INSERT INTO journal_commits VALUES(?,?,?,?,?,?)')
    .run(commit.sequence,commit.previousHash,commit.hash,commit.at,commit.changes.length,bytes);
  const insert = state.prepare('INSERT INTO journal_changes VALUES(?,?,?,?,?,?)');
  commit.changes.forEach((change,ordinal) => insert.run(commit.sequence,ordinal,change.table,JSON.stringify(change.key),
    change.before === null ? null : JSON.stringify(change.before),change.after === null ? null : JSON.stringify(change.after)));
  state.prepare('UPDATE journal_meta SET sequence=?,hash=? WHERE id=1').run(commit.sequence,commit.hash);
}
function seal(db) {
  const state = raw(db), changes = state.prepare('SELECT * FROM journal_pending ORDER BY ordinal').all().map(decodeChange);
  if (!changes.length) return;
  changes.forEach(validateChange);
  const head = readCheckpoint(db), commit = { sequence: head.sequence+1,previousHash: head.hash,at: Date.now(),changes };
  commit.hash = commitHash(head.databaseId,commit);
  persistCommit(db,commit);
  state.exec('DELETE FROM journal_pending');
}
const sqlStart = sql => sql.replace(/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/,'').trim();
const statements = sql => sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`[^`]*`|\[[^\]]*\]/g,' ')
  .split(';').map(value=>value.trim()).filter(Boolean);
function mutable(sql) {
  const start=sqlStart(sql);
  if(/^(?:SELECT|EXPLAIN|PRAGMA)\b/i.test(start)) return false;
  if(!/^WITH\b/i.test(start)) return true;
  // The statement following a CTE is its top-level operation. Quoted values,
  // identifiers and nested SELECTs must not make a read acquire a write lock.
  const tokens=start.match(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`[^`]*`|\[[^\]]*\]|[a-zA-Z_]+|[()]/g) ?? [];
  let depth=0;
  for(const token of tokens) {
    if(token==='(') depth++;
    else if(token===')') depth--;
    else if(!depth && /^(SELECT|INSERT|UPDATE|DELETE|REPLACE)$/i.test(token)) return token.toUpperCase()!=='SELECT';
  }
  return true;
}
/** All Store connection writes, including direct prepared writes in workers,
 * share this boundary. SQLite triggers capture actual row effects and savepoint
 * rollback; the seal and head are committed with those same effects. */
export function installJournal(db) {
  if (connections.has(db)) return;
  const state = { exec: db.exec.bind(db),prepare: db.prepare.bind(db),transaction: false };
  connections.set(db,state);
  state.exec('PRAGMA recursive_triggers=ON');
  const atomic = operation => {
    if (state.transaction) return operation();
    state.exec('BEGIN IMMEDIATE'); state.transaction=true;
    try { const result = operation(); seal(db); state.exec('COMMIT'); return result; }
    catch (error) { try { state.exec('ROLLBACK'); } catch {} throw error; }
    finally { state.transaction=false; }
  };
  db.exec = sql => {
    const start = sqlStart(sql);
    const parts=statements(sql);
    const boundary=/^(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i;
    const triggerDefinition=/^CREATE\s+(?:(?:TEMP|TEMPORARY)\s+)?TRIGGER\b/i.test(start)
      && /^END$/i.test(parts.at(-1) ?? '') && !parts.slice(0,-1).some(part=>boundary.test(part));
    if(parts.length>1 && parts.some(part=>boundary.test(part))
      && !triggerDefinition
      && !(parts.length===2 && /^ROLLBACK\s+TO\b/i.test(parts[0]) && /^RELEASE\b/i.test(parts[1])))
      fail('journal_transaction_boundary_invalid');
    if(parts.length>1 && parts.some(part=>/^PRAGMA\s+query_only\b/i.test(part)) && parts.some(part=>!/^PRAGMA\b/i.test(part)))
      fail('journal_transaction_boundary_invalid');
    if(/^SAVEPOINT\b/i.test(start) && !state.transaction) fail('journal_transaction_boundary_invalid');
    if (/^(?:BEGIN|SAVEPOINT)\b/i.test(start)) {
      const result = state.exec(sql); state.transaction=true; return result;
    }
    if (/^(?:COMMIT|END)\b/i.test(start)) {
      seal(db); const result=state.exec(sql); state.transaction=false; return result;
    }
    if (/^ROLLBACK\b/i.test(start) && !/^ROLLBACK\s+TO\b/i.test(start)) {
      const result=state.exec(sql); state.transaction=false; return result;
    }
    if (/^(?:RELEASE|ROLLBACK\s+TO)\b/i.test(start) || parts.every(part=>/^PRAGMA\b/i.test(part))) return state.exec(sql);
    return atomic(() => state.exec(sql));
  };
  db.prepare = sql => {
    if (/^(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(sqlStart(sql))) fail('journal_transaction_boundary_invalid');
    const statement = state.prepare(sql);
    if (!mutable(sql)) return statement;
    for (const method of ['run','get','all']) {
      const original = statement[method].bind(statement);
      statement[method] = (...args) => atomic(() => original(...args));
    }
    const original = statement.iterate.bind(statement);
    statement.iterate = (...args) => {
      if (!state.transaction) throw new TypeError('Mutating iteration requires an explicit transaction');
      return original(...args);
    };
    return statement;
  };
}
function pinned(db,operation) {
  const state=raw(db);
  if (state.transaction) return operation();
  // Read-only Store connections may already hold a manually pinned snapshot.
  let started=false;
  try { state.exec('BEGIN'); started=true; }
  catch (error) { if (!/within a transaction/.test(error.message)) throw error; }
  try { return operation(); } finally { if(started) state.exec('ROLLBACK'); }
}
export function exportChanges(db,{after,through,limit=128,maxBytes=4*1024*1024}={}) {
  if (!validCheckpoint(after) || through && !validCheckpoint(through) || !Number.isSafeInteger(limit) || limit<1 || limit>1024
    || !Number.isSafeInteger(maxBytes) || maxBytes<1 || maxBytes>MAX_COMMIT_BYTES) fail('journal_request_invalid');
  return pinned(db,() => {
    const head=through ?? readCheckpoint(db);
    if (!same(after,checkpointAt(db,after.sequence)) || !same(head,checkpointAt(db,head.sequence)) || after.sequence>head.sequence)
      fail('journal_checkpoint_mismatch');
    const rows=raw(db).prepare('SELECT * FROM journal_commits WHERE sequence>? AND sequence<=? ORDER BY sequence LIMIT ?').all(after.sequence,head.sequence,limit);
    const commits=[]; let bytes=0, previous=after;
    for (const row of rows) {
      if (commits.length && bytes+row.bytes>maxBytes) break;
      const commit=readCommit(db,row);
      previous=validateJournalCommit(commit,previous);
      commits.push(commit); bytes+=row.bytes;
    }
    const last=commits.at(-1),to=last ? {databaseId:head.databaseId,sequence:last.sequence,hash:last.hash} : after;
    return {version:JOURNAL_VERSION,from:after,to,commits,hasMore:to.sequence<head.sequence};
  });
}
function applyRow(db,change,reverse=false) {
  const table=validateChange(change),before=reverse?change.after:change.before,after=reverse?change.before:change.after;
  const keyRow=before ?? after,where=table.keys.map(key=>`${q(key)} IS ?`).join(' AND '),key=table.keys.map(name=>keyRow[name]);
  const state=raw(db),actual=state.prepare(`SELECT * FROM ${q(table.name)} WHERE ${where}`).get(...key) ?? null;
  if (!isDeepStrictEqual(actual && {...actual},before)) fail('journal_row_conflict');
  if (after===null) state.prepare(`DELETE FROM ${q(table.name)} WHERE ${where}`).run(...key);
  else if (before===null) state.prepare(`INSERT INTO ${q(table.name)}(${table.columns.map(q).join(',')}) VALUES(${table.columns.map(()=>'?').join(',')})`)
    .run(...table.columns.map(column=>after[column]));
  else state.prepare(`UPDATE ${q(table.name)} SET ${table.columns.map(column=>`${q(column)}=?`).join(',')} WHERE ${where}`)
    .run(...table.columns.map(column=>after[column]),...key);
}
function exclusive(db,operation) {
  const state=raw(db);
  if (state.transaction) fail('journal_transaction_active');
  state.exec('BEGIN IMMEDIATE; PRAGMA defer_foreign_keys=ON');
  if(connections.has(db)) state.transaction=true;
  try { const result=operation(); state.exec('DELETE FROM journal_pending; COMMIT'); return result; }
  catch(error) {try{state.exec('ROLLBACK');}catch{} throw error;}
  finally{if(connections.has(db))state.transaction=false;}
}
export function applyChanges(db,batch) {
  if (!batch || Object.keys(batch).sort().join(',')!=='commits,from,hasMore,to,version' || batch.version!==JOURNAL_VERSION
    || !validCheckpoint(batch.from) || !validCheckpoint(batch.to) || batch.from.databaseId!==batch.to.databaseId
    || !Array.isArray(batch.commits) || batch.commits.length>1024 || typeof batch.hasMore!=='boolean') fail('journal_batch_invalid');
  return exclusive(db,() => {
    let previous=batch.from;
    for(const commit of batch.commits) previous=validateJournalCommit(commit,previous);
    if(!same(previous,batch.to)) fail('journal_batch_invalid');
    const head=validateCheckpoint(db);
    if(head.sequence>=batch.to.sequence && same(batch.to,checkpointAt(db,batch.to.sequence))
      && same(batch.from,checkpointAt(db,batch.from.sequence))) return head;
    if(!same(head,batch.from)) fail('journal_checkpoint_mismatch');
    for(const commit of batch.commits) {
      for(const change of commit.changes) applyRow(db,change);
      persistCommit(db,commit);
    }
    return readCheckpoint(db);
  });
}
export function validateJournalCommit(commit,previous) {
  if(!validCheckpoint(previous) || !commit || Object.keys(commit).sort().join(',')!=='at,changes,hash,previousHash,sequence'
    || commit.sequence!==previous.sequence+1 || commit.previousHash!==previous.hash
    || !Number.isSafeInteger(commit.at) || commit.at<0 || !Array.isArray(commit.changes) || !commit.changes.length
    || Buffer.byteLength(JSON.stringify(commit))>MAX_COMMIT_BYTES || commit.hash!==commitHash(previous.databaseId,commit)) fail('journal_hash_mismatch');
  commit.changes.forEach(validateChange);
  return {databaseId:previous.databaseId,sequence:commit.sequence,hash:commit.hash};
}
/** Keep the losing suffix durably before undoing it. Retained branch evidence
 * is inactive; neither archive rows nor copied control state grant authority. */
export function rewindTo(db,checkpoint,{preserve=true}={}) {
  if(!validCheckpoint(checkpoint) || preserve!==true) fail('journal_checkpoint_invalid');
  return exclusive(db,() => {
    const state=raw(db),head=validateCheckpoint(db);
    if(!same(checkpoint,checkpointAt(db,checkpoint.sequence))) fail('journal_checkpoint_mismatch');
    if(same(head,checkpoint)) return null;
    const branchId=randomUUID();
    state.prepare('INSERT INTO journal_branches VALUES(?,?,?,?)').run(branchId,Date.now(),JSON.stringify(checkpoint),JSON.stringify(head));
    const archive=state.prepare('INSERT INTO journal_branch_commits VALUES(?,?,?)');
    let sequence=head.sequence;
    while(sequence>checkpoint.sequence) {
      const row=state.prepare('SELECT * FROM journal_commits WHERE sequence=?').get(sequence),commit=readCommit(db,row);
      if(commit.hash!==commitHash(head.databaseId,commit)) fail('journal_hash_mismatch');
      archive.run(branchId,sequence,JSON.stringify(commit));
      for(const change of [...commit.changes].reverse()) applyRow(db,change,true);
      state.prepare('DELETE FROM journal_changes WHERE sequence=?').run(sequence);
      state.prepare('DELETE FROM journal_commits WHERE sequence=?').run(sequence--);
    }
    state.prepare('UPDATE journal_meta SET sequence=?,hash=? WHERE id=1').run(checkpoint.sequence,checkpoint.hash);
    return branchId;
  });
}
export function* changedRecordKeys(db,{after,through=readCheckpoint(db)}={}) {
  if(!same(after,checkpointAt(db,after?.sequence)) || !same(through,checkpointAt(db,through?.sequence))) fail('journal_checkpoint_mismatch');
  let previous=after;
  for(const row of raw(db).prepare('SELECT * FROM journal_commits WHERE sequence>? AND sequence<=? ORDER BY sequence')
    .iterate(after.sequence,through.sequence)) {
    const commit=readCommit(db,row);
    previous=validateJournalCommit(commit,previous);
    for(const change of commit.changes) yield {...change,sequence:row.sequence};
  }
  if(!same(previous,through)) fail('journal_hash_mismatch');
}
/** Optional full history audit, called only by the independent verifier. */
export function verifyJournal(db) {
  const head=validateCheckpoint(db); let previous=checkpointAt(db,0),count=0;
  for(const row of raw(db).prepare('SELECT * FROM journal_commits ORDER BY sequence').iterate()) {
    const commit=readCommit(db,row);
    previous=validateJournalCommit(commit,previous);
    if(commit.changes.length!==row.change_count || Buffer.byteLength(JSON.stringify(commit))!==row.bytes) fail('journal_hash_mismatch');
    count++;
  }
  if(!same(previous,head)) fail('journal_hash_mismatch');
  let branches=0,archivedCommits=0;
  for(const branch of raw(db).prepare('SELECT * FROM journal_branches ORDER BY id').iterate()) {
    let base,tip;
    try {base=JSON.parse(branch.base);tip=JSON.parse(branch.head);} catch {fail('journal_hash_mismatch');}
    if(!validCheckpoint(base) || !validCheckpoint(tip) || base.databaseId!==head.databaseId
      || tip.databaseId!==head.databaseId || base.sequence>=tip.sequence) fail('journal_hash_mismatch');
    previous=base;
    for(const row of raw(db).prepare('SELECT sequence,payload FROM journal_branch_commits WHERE branch_id=? ORDER BY sequence').iterate(branch.id)) {
      let commit;
      try {commit=JSON.parse(row.payload);} catch {fail('journal_hash_mismatch');}
      if(row.sequence!==commit.sequence) fail('journal_hash_mismatch');
      previous=validateJournalCommit(commit,previous);archivedCommits++;
    }
    if(!same(previous,tip)) fail('journal_hash_mismatch');
    branches++;
  }
  // Validate final materialized values against their last retained row effect.
  // This expensive audit is deliberately absent from startup and replication.
  for(const row of raw(db).prepare(`SELECT c.* FROM journal_changes c WHERE NOT EXISTS(
    SELECT 1 FROM journal_changes newer WHERE newer.table_name=c.table_name AND newer.record_key=c.record_key
    AND (newer.sequence,newer.ordinal)>(c.sequence,c.ordinal))`).iterate()) {
    const change=decodeChange(row),table=tables.get(change.table);
    const actual=raw(db).prepare(`SELECT * FROM ${q(table.name)} WHERE ${table.keys.map(key=>`${q(key)} IS ?`).join(' AND ')}`).get(...change.key) ?? null;
    if(!isDeepStrictEqual(actual && {...actual},change.after)) fail('journal_row_conflict');
  }
  return {checkpoint:head,commits:count,branches,archivedCommits};
}
