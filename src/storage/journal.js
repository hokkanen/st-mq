import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { JOURNALED_TABLES, SCHEMA_VERSION } from './schema.js';
import { quoteIdentifier as q } from './journal-schema.js';
import { LEARNING_ALGORITHM } from '../domain/learning-contract.js';
import { assertCurrentChargingSessionCheck } from '../app/charging-session-checks.js';
import { encodeChange, rowHash, emptyContentHash, changeContentHash, patchedValue, registerJournalFunctions } from './journal-codec.js';
import { capturePeerChanges, verifyPeerHistory } from './journal-peer.js';
import { captureLearningCheckpoints } from './learning-checkpoints.js';

export const JOURNAL_VERSION = 2;
export const MAX_COMMIT_BYTES = 64 * 1024 * 1024;
export const JOURNAL_RETENTION = Object.freeze({ maxBytes: 8 * 1024 * 1024, maxCommits: 2048 });
const connections = new WeakMap();
const tables = new Map(JOURNALED_TABLES.map(table => [table.name, table]));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code = 'database_journal_invalid') => { throw Object.assign(new Error('The transaction checkpoint could not be verified. Preserve the database and use full verification or an intact current-version backup.'), { code }); };
const raw = db => connections.get(db) ?? { exec: db.exec.bind(db), prepare: db.prepare.bind(db) };
export function journalConnection(db) { return raw(db); }
export function journalExclusive(db,operation) { return exclusive(db,operation); }
export function journalReadRow(db,change) { return readRow(db,change); }
export function journalApplyRow(db,change,reverse=false) { return applyRow(db,change,reverse); }
const same = (a,b) => Boolean(a && b && a.databaseId === b.databaseId && a.sequence === b.sequence && a.hash === b.hash);
export const matchingCheckpoint = same;
export function validCheckpoint(value) {
  return value && Object.keys(value).length === 3 && /^[a-f0-9-]{36}$/.test(value.databaseId)
    && Number.isSafeInteger(value.sequence) && value.sequence >= 0 && /^[a-f0-9]{64}$/.test(value.hash);
}
const genesis = databaseId => digest({ version: JOURNAL_VERSION, databaseId, schema: SCHEMA_VERSION, algorithm: LEARNING_ALGORITHM });

export function initializeJournal(db) {
  const databaseId = randomUUID(), hash = genesis(databaseId);
  const content = rowHash('history_selection',[1],{id:1,generation:'original'});
  raw(db).prepare('INSERT INTO journal_meta VALUES(1,?,?,?,?,?,?,?,?,?,?,?)')
    .run(databaseId,0,hash,hash,LEARNING_ALGORITHM,0,hash,content,content,0,0);
}
export function readCheckpoint(db) {
  const row = raw(db).prepare('SELECT database_id,sequence,hash FROM journal_meta WHERE id=1').get();
  const value = row && { databaseId: row.database_id, sequence: row.sequence, hash: row.hash };
  if (!validCheckpoint(value)) fail();
  return value;
}
export function checkpointAt(db, sequence) {
  if (!Number.isSafeInteger(sequence) || sequence < 0) fail('journal_checkpoint_invalid');
  const meta = raw(db).prepare('SELECT database_id,base_sequence,base_hash FROM journal_meta WHERE id=1').get();
  if (sequence < meta.base_sequence) return null;
  const row = sequence === meta.base_sequence ? { hash: meta.base_hash } : raw(db).prepare('SELECT hash FROM journal_commits WHERE sequence=?').get(sequence);
  return row?.hash ? { databaseId: meta.database_id, sequence, hash: row.hash } : null;
}
export function journalBase(db) {
  const row=raw(db).prepare('SELECT database_id,base_sequence,base_hash FROM journal_meta WHERE id=1').get();
  const base={databaseId:row.database_id,sequence:row.base_sequence,hash:row.base_hash};
  if(!validCheckpoint(base)) fail();
  return base;
}
/** Constant work in history size: structural checks are handled by Store. The
 * head proves committed continuity, not a full scan for latent disk corruption. */
export function validateCheckpoint(db) {
  const state = raw(db), head = readCheckpoint(db);
  const meta = state.prepare('SELECT * FROM journal_meta WHERE id=1').get(), base=journalBase(db);
  if (meta.algorithm_version !== LEARNING_ALGORITHM) fail('database_algorithm_mismatch');
  if (meta.genesis_hash !== genesis(head.databaseId) || state.prepare('SELECT 1 FROM journal_pending LIMIT 1').get()) fail();
  if(base.sequence>head.sequence || !/^[a-f0-9]{64}$/.test(meta.content_hash) || !/^[a-f0-9]{64}$/.test(meta.base_content_hash)
    || base.sequence===0 && base.hash!==meta.genesis_hash || meta.retained_commits!==head.sequence-base.sequence
    || !Number.isSafeInteger(meta.retained_bytes) || meta.retained_bytes<0) fail();
  const last = state.prepare('SELECT sequence,hash,previous_hash,content_hash FROM journal_commits ORDER BY sequence DESC LIMIT 1').get();
  if (head.sequence === base.sequence ? last || head.hash !== base.hash || meta.content_hash!==meta.base_content_hash
    : !last || last.sequence !== head.sequence || last.hash !== head.hash || last.content_hash!==meta.content_hash
      || last.previous_hash !== checkpointAt(db,head.sequence-1)?.hash) fail();
  return head;
}
export function commonCheckpoint(left, right) {
  const a = readCheckpoint(left), b = readCheckpoint(right);
  if (a.databaseId !== b.databaseId) return null;
  let low = Math.max(journalBase(left).sequence,journalBase(right).sequence), high = Math.min(a.sequence,b.sequence);
  if(low>high || !same(checkpointAt(left,low),checkpointAt(right,low))) return null;
  while (low < high) {
    const middle = Math.ceil((low+high)/2);
    if (same(checkpointAt(left,middle),checkpointAt(right,middle))) low=middle;
    else high=middle-1;
  }
  return checkpointAt(left,low);
}
export function decodeJournalChange(row) {
  try {
    const change=JSON.parse(row.payload); validateChange(change);
    if(row.table_name!==undefined && (row.table_name!==change.table || row.record_key!==JSON.stringify(change.key))) fail();
    return change;
  } catch(error) { if(error.code) throw error; fail(); }
}
function readCommit(db, row) {
  if(!row) fail();
  return { sequence: row.sequence, previousHash: row.previous_hash, hash: row.hash, at: row.at,contentHash:row.content_hash,
    changes: raw(db).prepare('SELECT * FROM journal_changes WHERE sequence=? ORDER BY ordinal').all(row.sequence).map(decodeJournalChange) };
}
const commitHash = (databaseId,commit) => digest({ version: JOURNAL_VERSION, databaseId,
  sequence: commit.sequence, previousHash: commit.previousHash, at: commit.at, contentHash:commit.contentHash, changes: commit.changes });
function validateMaterializedRow(table,row) {
  if(!row) return;
  if(table==='learning_journal_entries' && row.algorithm_version!==LEARNING_ALGORITHM) fail('database_algorithm_mismatch');
  if(table==='events' && row.type==='charging-session-check') {
    try { assertCurrentChargingSessionCheck(JSON.parse(row.payload)); } catch { fail('database_state_incompatible'); }
  }
}
function validateChange(change) {
  const table = tables.get(change?.table);
  if (!table || Object.keys(change).sort().join(',') !== 'after,afterHash,before,beforeHash,key,table'
    || !Array.isArray(change.key) || change.key.length !== table.keys.length || change.before === null && change.after === null) fail();
  for (const row of [change.before,change.after]) {
    if (row === null) continue;
    if (!row || Array.isArray(row) || Object.keys(row).some(key=>!table.columns.includes(key))) fail();
    const full=change.before===null || change.after===null;
    if(full && (Object.keys(row).length!==table.columns.length || table.columns.some(key=>!Object.hasOwn(row,key)))) fail();
    if (Object.values(row).some(value => value !== null && !['number','string'].includes(typeof value)
      && (full || !value || Object.keys(value).join(',')!=='$text' || !Array.isArray(value.$text) || value.$text.length!==3
        || !value.$text.slice(0,2).every(n=>Number.isSafeInteger(n)&&n>=0) || typeof value.$text[2]!=='string')
      || typeof value === 'number' && !Number.isFinite(value))) fail();
  }
  for(const side of ['before','after']) {
    if(change[side]===null ? change[`${side}Hash`]!==null : !/^[a-f0-9]{64}$/.test(change[`${side}Hash`])) fail();
    if(change[side] && (change.before===null || change.after===null)
      && (!isDeepStrictEqual(change.key,table.keys.map(key=>change[side][key]))
        || rowHash(change.table,change.key,change[side])!==change[`${side}Hash`])) fail('journal_row_conflict');
  }
  if(change.before && change.after && (Object.keys(change.before).join(',')!==Object.keys(change.after).join(',')
    || table.keys.some(key=>Object.hasOwn(change.before,key)))) fail('journal_identity_changed');
  // An update contains only changed columns, potentially text splices. Validate
  // its complete current-format row after resolving against the checked baseline.
  if(change.before===null) validateMaterializedRow(change.table,change.after);
  return table;
}
function persistCommit(db,commit) {
  const state = raw(db), bytes = Buffer.byteLength(JSON.stringify(commit));
  if (bytes > MAX_COMMIT_BYTES) fail('journal_transaction_too_large');
  const meta=state.prepare('SELECT content_hash FROM journal_meta WHERE id=1').get();
  if(changeContentHash(meta.content_hash,commit.changes)!==commit.contentHash) fail('journal_hash_mismatch');
  capturePeerChanges(db,commit.changes,commit.sequence);
  state.prepare('INSERT INTO journal_commits VALUES(?,?,?,?,?,?,?)')
    .run(commit.sequence,commit.previousHash,commit.hash,commit.at,commit.changes.length,bytes,commit.contentHash);
  const insert = state.prepare('INSERT INTO journal_changes VALUES(?,?,?,?,?)');
  commit.changes.forEach((change,ordinal) => insert.run(commit.sequence,ordinal,change.table,JSON.stringify(change.key),JSON.stringify(change)));
  state.prepare('UPDATE journal_meta SET sequence=?,hash=?,content_hash=?,retained_bytes=retained_bytes+?,retained_commits=retained_commits+1 WHERE id=1')
    .run(commit.sequence,commit.hash,commit.contentHash,bytes);
  trimJournal(db);
}
function seal(db) {
  const state = raw(db), effects = new Map();
  let bytes=0;
  for(const row of state.prepare('SELECT payload FROM journal_pending ORDER BY ordinal').iterate()) {
    bytes+=Buffer.byteLength(row.payload);
    if(bytes>MAX_COMMIT_BYTES) fail('journal_transaction_too_large');
    const change=decodeJournalChange(row),key=JSON.stringify([change.table,change.key]);
    if(!effects.has(key)) effects.set(key,[]);
    effects.get(key).push(change);
  }
  const changes=[];
  for(const group of effects.values()) {
    if(group.length===1) { changes.push(group[0]); continue; }
    const first=group[0],after=readRow(db,first);
    let before=after;
    for(let i=group.length-1;i>=0;i--) before=resolveChange(group[i],before,{reverse:true});
    if(isDeepStrictEqual(before,after)) continue;
    changes.push(encodeChange(first.table,first.key,before,after));
  }
  if (!changes.length) { if(effects.size) state.exec('DELETE FROM journal_pending'); return; }
  changes.push(...captureLearningCheckpoints(db,changes));
  changes.forEach(validateChange);
  for(const change of changes) if(change.before && change.after
    && ['events','learning_journal_entries'].includes(change.table))
    validateMaterializedRow(change.table,readRow(db,change));
  const head = readCheckpoint(db),content=state.prepare('SELECT content_hash FROM journal_meta WHERE id=1').get().content_hash;
  const commit = { sequence: head.sequence+1,previousHash: head.hash,at: Date.now(),contentHash:changeContentHash(content,changes),changes };
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
  const capture=registerJournalFunctions(db);
  state.resetCaptureBudget=capture.reset;
  state.setCaptureEnabled=capture.setEnabled;
  state.exec('PRAGMA recursive_triggers=ON');
  const atomic = operation => {
    if (state.transaction) return operation();
    state.resetCaptureBudget();
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
      if(!state.transaction) state.resetCaptureBudget();
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
    if(after.databaseId===head.databaseId && after.sequence<journalBase(db).sequence) fail('journal_history_expired');
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
function readRow(db,change) {
  const table=tables.get(change.table);
  const row=raw(db).prepare(`SELECT * FROM ${q(table.name)} WHERE ${table.keys.map(key=>`${q(key)} IS ?`).join(' AND ')}`).get(...change.key);
  return row ? {...row} : null;
}
export function resolveChange(change,actual,{reverse=false}={}) {
  // Iterators also carry their position; the wire representation remains strict.
  const {sequence,ordinal,...value}=change,table=validateChange(value);
  actual=actual ? {...actual} : null;
  const expected=reverse?change.afterHash:change.beforeHash,target=reverse?change.before:change.after;
  if(rowHash(change.table,change.key,actual)!==expected) fail('journal_row_conflict');
  let result=null;
  if(target!==null) {
    if(actual===null) result={...target};
    else {
      result={...actual};
      try { for(const [key,patch] of Object.entries(target)) result[key]=patchedValue(actual[key],patch); }
      catch { fail('journal_row_conflict'); }
    }
    // Keep schema order for hashing, including values supplied by untrusted JSON.
    result=Object.fromEntries(table.columns.map(key=>[key,result[key]]));
    if(!isDeepStrictEqual(change.key,table.keys.map(key=>result[key]))) fail('journal_identity_changed');
  }
  if(rowHash(change.table,change.key,result)!==(reverse?change.beforeHash:change.afterHash)) fail('journal_row_conflict');
  validateMaterializedRow(change.table,result);
  return result;
}
function applyRow(db,change,reverse=false) {
  const table=validateChange(change),where=table.keys.map(key=>`${q(key)} IS ?`).join(' AND '),key=change.key;
  const state=raw(db),before=readRow(db,change),after=resolveChange(change,before,{reverse});
  if (after===null) state.prepare(`DELETE FROM ${q(table.name)} WHERE ${where}`).run(...key);
  else if (before===null) state.prepare(`INSERT INTO ${q(table.name)}(${table.columns.map(q).join(',')}) VALUES(${table.columns.map(()=>'?').join(',')})`)
    .run(...table.columns.map(column=>after[column]));
  else state.prepare(`UPDATE ${q(table.name)} SET ${table.columns.map(column=>`${q(column)}=?`).join(',')} WHERE ${where}`)
    .run(...table.columns.map(column=>after[column]),...key);
}
function exclusive(db,operation) {
  const state=raw(db);
  if (state.transaction) fail('journal_transaction_active');
  state.resetCaptureBudget?.();
  state.exec('BEGIN IMMEDIATE; PRAGMA defer_foreign_keys=ON');
  state.setCaptureEnabled?.(false);
  if(connections.has(db)) state.transaction=true;
  try { const result=operation(); state.exec('DELETE FROM journal_pending; COMMIT'); return result; }
  catch(error) {try{state.exec('ROLLBACK');}catch{} throw error;}
  finally{if(connections.has(db))state.transaction=false;state.setCaptureEnabled?.(true);}
}
export function validateJournalCommit(commit,previous) {
  if(!validCheckpoint(previous) || !commit || Object.keys(commit).sort().join(',')!=='at,changes,contentHash,hash,previousHash,sequence'
    || commit.sequence!==previous.sequence+1 || commit.previousHash!==previous.hash
    || !Number.isSafeInteger(commit.at) || commit.at<0 || !/^[a-f0-9]{64}$/.test(commit.contentHash) || !Array.isArray(commit.changes) || !commit.changes.length
    || Buffer.byteLength(JSON.stringify(commit))>MAX_COMMIT_BYTES || commit.hash!==commitHash(previous.databaseId,commit)) fail('journal_hash_mismatch');
  commit.changes.forEach(validateChange);
  return {databaseId:previous.databaseId,sequence:commit.sequence,hash:commit.hash};
}
export function* changedRecordKeys(db,{after,through=readCheckpoint(db)}={}) {
  if(validCheckpoint(after) && after.databaseId===through.databaseId && after.sequence<journalBase(db).sequence) fail('journal_history_expired');
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
export function* reverseChanges(db,{after=journalBase(db),table,key}={}) {
  if(!same(after,checkpointAt(db,after?.sequence))) fail('journal_checkpoint_mismatch');
  const filter=table ? ' AND table_name=?'+(key?' AND record_key=?':'') : '';
  const args=[after.sequence,...(table?[table]:[]),...(table&&key?[JSON.stringify(key)]:[])];
  for(const row of raw(db).prepare(`SELECT * FROM journal_changes WHERE sequence>?${filter} ORDER BY sequence DESC,ordinal DESC`).iterate(...args))
    yield {...decodeJournalChange(row),sequence:row.sequence,ordinal:row.ordinal};
}

// Indexed deletion touches only the disposable prefix being removed. SQLite
// reuses its pages; no VACUUM, file copy, historical scan or automatic shrinking.
function trimJournal(db,{maxBytes=JOURNAL_RETENTION.maxBytes,maxCommits=JOURNAL_RETENTION.maxCommits}={}) {
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||!Number.isSafeInteger(maxCommits)||maxCommits<1) fail('journal_request_invalid');
  const state=raw(db),meta=state.prepare('SELECT * FROM journal_meta WHERE id=1').get();
  if(meta.retained_bytes<=maxBytes && meta.retained_commits<=maxCommits) return journalBase(db);
  const targetBytes=Math.floor(maxBytes*0.75),targetCommits=Math.max(1,Math.floor(maxCommits*0.75));
  let bytes=meta.retained_bytes,count=meta.retained_commits,last;
  for(const row of state.prepare('SELECT sequence,hash,content_hash,bytes FROM journal_commits ORDER BY sequence').iterate()) {
    if(row.sequence===meta.sequence || bytes<=targetBytes && count<=targetCommits) break;
    bytes-=row.bytes;count--;last=row;
  }
  if(last) {
    state.prepare('DELETE FROM journal_changes WHERE sequence<=?').run(last.sequence);
    state.prepare('DELETE FROM journal_commits WHERE sequence<=?').run(last.sequence);
    state.prepare('UPDATE journal_meta SET base_sequence=?,base_hash=?,base_content_hash=?,retained_bytes=?,retained_commits=? WHERE id=1')
      .run(last.sequence,last.hash,last.content_hash,bytes,count);
  }
  return journalBase(db);
}
export function compactJournal(db,options) { return exclusive(db,()=>{validateCheckpoint(db);return trimJournal(db,options);}); }
/** Optional full history audit, called only by the independent verifier. */
export function verifyJournal(db) {
  const state=raw(db),head=validateCheckpoint(db),base=journalBase(db);
  const meta=state.prepare('SELECT * FROM journal_meta WHERE id=1').get();
  let previous=base,content=meta.base_content_hash,count=0,bytes=0;
  for(const row of state.prepare('SELECT * FROM journal_commits ORDER BY sequence').iterate()) {
    const commit=readCommit(db,row);
    previous=validateJournalCommit(commit,previous);
    content=changeContentHash(content,commit.changes);
    if(content!==commit.contentHash || commit.changes.length!==row.change_count || Buffer.byteLength(JSON.stringify(commit))!==row.bytes) fail('journal_hash_mismatch');
    count++;bytes+=row.bytes;
  }
  if(!same(previous,head) || content!==meta.content_hash || count!==meta.retained_commits || bytes!==meta.retained_bytes) fail('journal_hash_mismatch');
  // Independently recompute the whole materialized-content fingerprint. This
  // also detects damage in rows older than the retained mutation window.
  let actualContent=emptyContentHash;
  for(const table of tables.values()) {
    for(const row of state.prepare(`SELECT * FROM ${q(table.name)}${table.name==='state'?" WHERE key<>'backup:metadata'":''}`).iterate()) {
      const key=table.keys.map(key=>row[key]);
      actualContent=changeContentHash(actualContent,[{beforeHash:null,afterHash:rowHash(table.name,key,{...row})}]);
    }
  }
  if(actualContent!==meta.content_hash) fail('journal_row_conflict');
  const peers=verifyPeerHistory(db);
  return {checkpoint:head,base,commits:count,branches:peers.branches,archivedPeerRows:peers.archivedRows};
}
