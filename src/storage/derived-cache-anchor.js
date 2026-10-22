import { createHash, randomUUID } from 'node:crypto';
import { checkpointAt } from './journal.js';

const purposes = new Set(['household', 'firewood']);
const inputs = new Set(['mqtt', 'providers', 'simulated', 'live', 'history', 'offline']);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fields = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...names].sort().join(',');
const sourceValid = source => fields(source, ['databaseId','sequence','hash'])
  && typeof source.databaseId === 'string' && source.databaseId.length > 0 && source.databaseId.length <= 128
  && Number.isSafeInteger(source.sequence) && source.sequence >= 0 && digest(source.hash);
const same = (a,b) => a?.databaseId === b?.databaseId && a?.sequence === b?.sequence && a?.hash === b?.hash;
const tokenValid = token => typeof token === 'string' && /^[a-f0-9-]{36}$/.test(token);
const selectionValid = value => typeof value === 'string' && value.length > 0 && value.length <= 128;
const proofValid = (proof, complete) => fields(proof, ['token','source','selection', ...(complete ? ['digest'] : [])])
  && tokenValid(proof.token) && sourceValid(proof.source) && selectionValid(proof.selection)
  && (!complete || digest(proof.digest));
const recordValid = value => fields(value, ['version','active','pending']) && value.version === 1
  && (value.active === null || proofValid(value.active,true)) && (value.pending === null || proofValid(value.pending,false));
const refused = () => Object.assign(new Error('The derived cache proof is unavailable.'), { code:'DERIVED_CACHE_ANCHOR_REFUSED' });

export const derivedCacheId = (path,identity='') => createHash('sha256').update(JSON.stringify([identity??'',String(path)])).digest('hex');
function keyFor(cacheId,purpose,input) {
  if (!digest(cacheId) || !purposes.has(purpose) || !inputs.has(input)) throw refused();
  return `derived-cache-anchor:${purpose}:${input}:${cacheId}`;
}
function selection(db) { return db.prepare('SELECT generation FROM history_selection WHERE id=1').get()?.generation; }
function read(db,key) {
  const row=db.prepare('SELECT value FROM state WHERE key=?').get(key);
  if (!row) return null;
  const value=JSON.parse(row.value);
  if (!recordValid(value)) throw refused();
  return value;
}

/** A small journaled assertion about a derived file's immutable input prefix.
 * The file itself never supplies source history or control permission. Pin while
 * its READ snapshot is fresh; publish after its atomic file write. Two records
 * retain the previous usable cache if preparation or publication is interrupted. */
export function createDerivedCacheAnchorOwner({store,cacheId,purpose,isCurrent=()=>true}) {
  return async request => {
    if (!request || !['pin','publish'].includes(request.operation) || !sourceValid(request.source)
      || !selectionValid(request.selection) || !isCurrent() || store.readOnly) throw refused();
    const expected=request.operation==='pin' ? ['operation','input','source','selection']
      : ['operation','input','source','selection','token','digest'];
    if (!fields(request,expected) || request.operation==='publish' && (!tokenValid(request.token) || !digest(request.digest))) throw refused();
    const key=keyFor(cacheId,purpose,request.input);
    return store.runWrite(() => {
      const meta=store.db.prepare('SELECT database_id FROM journal_meta WHERE id=1').get();
      if (!isCurrent() || meta?.database_id!==request.source.databaseId || selection(store.db)!==request.selection
        || store.db.prepare('SELECT 1 FROM journal_pending LIMIT 1').get()) throw refused();
      let previous;
      try { previous=read(store.db,key); }
      catch { if(request.operation!=='pin') throw refused(); }
      previous ??= {version:1,active:null,pending:null};
      let next,proof;
      if(request.operation==='pin') {
        if(!same(checkpointAt(store.db,request.source.sequence),request.source)) throw refused();
        const latest=previous.pending ?? previous.active;
        if(latest?.selection===request.selection && latest.source.databaseId===request.source.databaseId
          && latest.source.sequence>request.source.sequence) throw refused();
        proof={token:randomUUID(),source:{...request.source},selection:request.selection};
        next={...previous,pending:proof};
      } else {
        const pending=previous.pending;
        if(previous.active?.token === request.token && same(previous.active.source,request.source)
          && previous.active.selection===request.selection && previous.active.digest===request.digest) return previous.active;
        if(!pending || pending.token!==request.token || !same(pending.source,request.source) || pending.selection!==request.selection) throw refused();
        proof={...pending,digest:request.digest};
        next={version:1,active:proof,pending:null};
      }
      store.setState(key,next);
      // Installation paths are trusted configuration, but changing them must not
      // leave an unlimited collection of disposable proof records in source DBs.
      const prefix=`derived-cache-anchor:${purpose}:${request.input}:`;
      const old=store.db.prepare('SELECT key FROM state WHERE key>=? AND key<? AND key<>? ORDER BY updated_at DESC,key DESC LIMIT -1 OFFSET 7')
        .all(prefix,`${prefix}\uffff`,key);
      for(const row of old) store.db.prepare('DELETE FROM state WHERE key=?').run(row.key);
      return proof;
    },{isCurrent,priority:'normal'});
  };
}

/** This check survives normal transaction-journal pruning. A restored branch
 * before publication lacks the matching proof; a later branch shares that
 * immutable prefix and its new suffix is read by the cache's normal watermark. */
export function matchesDerivedCacheAnchor(db,{cacheId,purpose,input,proof}) {
  try {
    if(!proofValid(proof,true) || db.prepare('SELECT 1 FROM journal_pending LIMIT 1').get()) return false;
    const meta=db.prepare('SELECT database_id FROM journal_meta WHERE id=1').get();
    if(meta?.database_id!==proof.source.databaseId || selection(db)!==proof.selection) return false;
    const saved=read(db,keyFor(cacheId,purpose,input))?.active;
    return Boolean(saved && saved.token === proof.token && same(saved.source,proof.source)
      && saved.selection===proof.selection && saved.digest===proof.digest);
  } catch { return false; }
}
