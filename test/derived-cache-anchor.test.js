import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { checkpointAt, compactJournal } from '../src/storage/journal.js';
import { createDerivedCacheAnchorOwner, derivedCacheId, matchesDerivedCacheAnchor } from '../src/storage/derived-cache-anchor.js';

function fixture(t) {
  const store=new Store(':memory:'); t.after(()=>store.close());
  const options={store,cacheId:derivedCacheId('/synthetic/derived.sqlite'),purpose:'household'};
  const owner=createDerivedCacheAnchorOwner(options);
  const pin=()=>({operation:'pin',input:'live',source:store.checkpoint(),selection:'original'});
  const match=proof=>matchesDerivedCacheAnchor(store.db,{...options,input:'live',proof});
  return {store,options,owner,pin,match};
}

test('a pinned input snapshot can finish and remain reusable after normal journal pruning',async t=>{
  const {store,owner,pin,match}=fixture(t);
  const request=pin(),pending=await owner(request);
  assert.equal(match({...pending,digest:'a'.repeat(64)}),false,'A file written before publication is not a committed cache');
  for(let i=0;i<12;i++) store.setState('synthetic-later-input',{index:i});
  compactJournal(store.db,{maxCommits:2,maxBytes:1024});
  assert.equal(checkpointAt(store.db,request.source.sequence),null);
  const publish={...request,operation:'publish',...pending,digest:'a'.repeat(64)};
  const proof=await owner(publish);
  assert.equal(match(proof),true);
  assert.deepEqual(await owner(publish),proof,'An uncertain acknowledgement can be retried without a second publication');
  for(let i=0;i<12;i++) store.setState('synthetic-more-input',{index:i});
  compactJournal(store.db,{maxCommits:2,maxBytes:1024});
  assert.equal(match(proof),true,'Later source appends do not erase the published prefix assertion');
});

test('new preparation preserves the last published cache and refuses stale tokens and source branches',async t=>{
  const {store,owner,pin,match}=fixture(t);
  const first=pin(),pending=await owner(first);
  const good=await owner({...first,...pending,operation:'publish',digest:'a'.repeat(64)});
  const next=pin(),replacement=await owner(next);
  assert.equal(match(good),true);
  await assert.rejects(owner({...next,...replacement,operation:'publish',token:pending.token,digest:'b'.repeat(64)}),{code:'DERIVED_CACHE_ANCHOR_REFUSED'});
  assert.equal(match(good),true);
  await assert.rejects(owner({...next,source:{...next.source,hash:'f'.repeat(64)}}),{code:'DERIVED_CACHE_ANCHOR_REFUSED'});
  await assert.rejects(owner({...next,selection:'another-selection'}),{code:'DERIVED_CACHE_ANCHOR_REFUSED'});
  assert.equal(match({...good,source:{...good.source,hash:'f'.repeat(64)}}),false);
  assert.equal(store.db.prepare('SELECT count(*) n FROM state WHERE key GLOB ?').get('derived-cache-anchor:*').n,1);
});

test('closing or losing writer ownership cancels queued proof work without publishing cache authority',async t=>{
  const {store,options,pin,match}=fixture(t);
  let current=true,release,entered;
  const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const held=store.runStorageTask(async()=>{entered();await gate;});
  await started;
  const owner=createDerivedCacheAnchorOwner({...options,isCurrent:()=>current});
  const queued=owner(pin());
  current=false; release(); await held;
  await assert.rejects(queued);
  assert.equal(store.db.prepare('SELECT count(*) n FROM state WHERE key GLOB ?').get('derived-cache-anchor:*').n,0);
  assert.equal(match({}),false);
});

test('a malformed disposable proof fails reuse but a freshly verified pin can replace it',async t=>{
  const {store,owner,pin,match}=fixture(t);
  const pending=await owner(pin());
  const key=store.db.prepare('SELECT key FROM state WHERE key GLOB ?').get('derived-cache-anchor:*').key;
  store.setState(key,{unsupported:true});
  assert.equal(match({...pending,digest:'a'.repeat(64)}),false);
  const fresh=await owner(pin());
  assert.notEqual(fresh.token,pending.token);
  assert.equal(store.getState(key).version,1);
  await assert.rejects(owner({...pin(),unexpected:true}),{code:'DERIVED_CACHE_ANCHOR_REFUSED'});
});

test('the same configured path on two paired nodes has independent bounded cache proofs',async t=>{
  const {store,pin}=fixture(t),proofs=[];
  for(const identity of ['synthetic-node-a','synthetic-node-b']) {
    const cacheId=derivedCacheId('/same/configured/database.sqlite',identity);
    const owner=createDerivedCacheAnchorOwner({store,cacheId,purpose:'firewood'}),request=pin();
    const pending=await owner(request);
    const proof=await owner({...request,...pending,operation:'publish',digest:'a'.repeat(64)});
    proofs.push({cacheId,purpose:'firewood',input:'live',proof});
  }
  assert.notEqual(proofs[0].cacheId,proofs[1].cacheId);
  for(const value of proofs) assert(matchesDerivedCacheAnchor(store.db,value));
});
