import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, rmSync, statSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { checkpointAt, readCheckpoint } from '../storage/journal.js';
import { fireplaceWindowContext } from './fireplace-inputs.js';
import { derivedCacheId,matchesDerivedCacheAnchor } from '../storage/derived-cache-anchor.js';

// Disposable private work, never a source backup, mirroring input or authority.
// Individual bodies bound every read; SQLite pages and payloads bound disk use.
export const FIREWOOD_PROJECTION_BYTES = 16 * 1024 * 1024;
export const FIREWOOD_PROJECTION_BODY_BYTES = 4 * 1024 * 1024;
const VERSION = 7, hash = body => createHash('sha256').update(body).digest('hex');
const invalidCache = message => Object.assign(new Error(message),{invalidDisposableCache:true});
const SAME = (a,b) => a && b && a.databaseId===b.databaseId && a.sequence===b.sequence && a.hash===b.hash;
const finite = Number.isFinite, object = value => value && typeof value==='object' && !Array.isArray(value);
function validState(state) {
  if(!object(state)||![null,undefined].includes(state.cursor)&&!finite(state.cursor)||typeof state.blocked!=='boolean') return false;
  if(!['sourceGaps','unsupportedRows','resetCount','evidenceHours','observedKwh','predictedKwh','dutyErrorHours','auxErrorKwh']
    .every(key=>finite(state[key])&&state[key]>=0)) return false;
  if(!Array.isArray(state.assumptions)||state.assumptions.length>64||!state.assumptions.every(value=>typeof value==='string')) return false;
  if(!Array.isArray(state.fireEvidence)||state.fireEvidence.length>4096||!Array.isArray(state.cleanEvidence)||state.cleanEvidence.length>4096
    ||!Array.isArray(state.evidenceDays)||!Array.isArray(state.evidenceBurns)||!object(state.lastConfiguration)||!finite(state.lastTargetC)) return false;
  if(state.scenarios===null) return true;
  return Array.isArray(state.scenarios)&&state.scenarios.length===4&&state.scenarios.every(scenario=>object(scenario)
    &&typeof scenario.name==='string'&&finite(scenario.powerMultiplier)
    &&['withFire','withoutFire'].every(key=>object(scenario[key])&&finite(scenario[key].indoorC)&&finite(scenario[key].reserveC)
      &&(scenario[key].slabC==null||finite(scenario[key].slabC))));
}

export class FirewoodProjectionCache {
  constructor(path,{maxBytes=FIREWOOD_PROJECTION_BYTES,anchor=null,readOnly=false,cacheId=derivedCacheId(path)}={}) {
    if(typeof path!=='string'||!path||path===':memory:'||!Number.isSafeInteger(maxBytes)||maxBytes<1024||maxBytes>FIREWOOD_PROJECTION_BYTES)
      throw new TypeError('A file-backed disposable firewood cache and bounded budget are required');
    this.maxBytes=maxBytes;this.readOnly=readOnly;this.anchor=readOnly?null:anchor;this.cacheId=cacheId;
    const directory=join(dirname(path),'temporary-firewood-projection');
    if(!readOnly) mkdirSync(directory,{recursive:true,mode:0o700});
    this.path=join(directory,`${basename(path)}.sqlite`);
    let database;
    if(readOnly) {
      this.db=new DatabaseSync(this.path,{readOnly:true});
      try {
        this.db.exec('PRAGMA busy_timeout=100');
        if(this.db.prepare('PRAGMA user_version').get().user_version!==VERSION) throw new Error('Firewood comparison cache is preparing');
        this.identity=statSync(this.path);return;
      } catch(error) {this.db.close();throw error;}
    }
    try {
      database=new DatabaseSync(this.path);
      database.exec('PRAGMA busy_timeout=100');
      const version=database.prepare('PRAGMA user_version').get().user_version;
      const names=database.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(row=>row.name);
      if(version!==VERSION&&(version!==0||names.length)) throw invalidCache('Unsupported disposable projection');
      if(version===VERSION&&JSON.stringify(names)!==JSON.stringify(['generation','manual_groups','manual_meta','snapshots'])) throw invalidCache('Malformed disposable projection');
      if(version===VERSION) {
        if(database.prepare('PRAGMA page_size').get().page_size!==4096) throw invalidCache('Unsupported disposable page size');
        try {
          database.prepare('SELECT input,signature,proof,head,next_at,want_at,pending,published FROM generation LIMIT 0').get();
          database.prepare('SELECT as_of,first_active_at,checksum FROM manual_meta LIMIT 0').get();
          database.prepare('SELECT digest FROM manual_groups LIMIT 0').get();
          database.prepare('SELECT input,cursor,at,progress,payload,digest,touched FROM snapshots LIMIT 0').get();
        } catch(error) {
          if(error.errcode===1&&/no such (?:column|table)/i.test(error.message)) throw invalidCache('Malformed disposable projection');
          throw error;
        }
      }
    } catch(error) {
      database?.close();
      // Busy/locked, full and I/O errors are retryable failures, not evidence
      // that another owner's valid cache can be deleted.
      if(!error.invalidDisposableCache&&![11,26].includes(error.errcode&255)) throw error;
      rmSync(this.path,{force:true});rmSync(`${this.path}-journal`,{force:true});database=new DatabaseSync(this.path);
    }
    this.db=database;
    try {
      this.identity=statSync(this.path);chmodSync(this.path,0o600);
      this.db.exec(`PRAGMA busy_timeout=100; PRAGMA page_size=4096; PRAGMA cache_size=-1024; PRAGMA journal_mode=DELETE;
      CREATE TABLE IF NOT EXISTS generation(input TEXT PRIMARY KEY,signature TEXT NOT NULL,proof TEXT NOT NULL,head INTEGER NOT NULL,next_at INTEGER,want_at INTEGER,pending TEXT,published TEXT);
      CREATE TABLE IF NOT EXISTS snapshots(input TEXT NOT NULL,cursor INTEGER NOT NULL,at INTEGER NOT NULL,progress INTEGER NOT NULL,payload BLOB NOT NULL,digest TEXT NOT NULL,touched INTEGER NOT NULL,PRIMARY KEY(input,cursor));
      CREATE INDEX IF NOT EXISTS snapshots_at ON snapshots(input,at,cursor);
      CREATE TABLE IF NOT EXISTS manual_meta(input TEXT PRIMARY KEY,token TEXT NOT NULL,proof TEXT NOT NULL,head INTEGER NOT NULL,cursor INTEGER NOT NULL,phase TEXT NOT NULL,
        scan_at INTEGER NOT NULL,scan_id INTEGER NOT NULL,group_id TEXT,group_at INTEGER,revision INTEGER NOT NULL,started_at INTEGER,next_at INTEGER,as_of INTEGER NOT NULL,first_active_at INTEGER,checksum TEXT);
      CREATE TABLE IF NOT EXISTS manual_groups(input TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(input,id));
      CREATE INDEX IF NOT EXISTS manual_groups_at ON manual_groups(input,at);
      PRAGMA user_version=${VERSION}; PRAGMA max_page_count=5120;`);}
    catch(error) {this.db.close();throw error;}
  }
  manual(store,input,now,{advance=false,maxRows=128}={}) {
    const source=store.db;this.sourceDb=source;
    if(!this.validCatalog(input)) {
      if(this.readOnly) return {complete:false};
      this.clearManual(input);
    }
    if(source.prepare('SELECT 1 FROM journal_pending LIMIT 1').get()) throw new Error('Uncommitted source cannot supply a derived firewood comparison');
    const head=source.prepare('SELECT MAX(id) id FROM active_fireplace_events WHERE input=?').get(input).id??0;
    const selection=source.prepare('SELECT generation FROM history_selection WHERE id=1').get()?.generation;
    const token=JSON.stringify([head,selection]);
    let meta=this.db.prepare('SELECT * FROM manual_meta WHERE input=?').get(input),valid=this.manualIntact(meta)&&meta?.token===token&&meta.as_of<=now&&!(meta.next_at!==null&&meta.next_at<=now);
    if(valid) try {const proof=JSON.parse(meta.proof);valid=SAME(checkpointAt(source,proof.sequence),proof)||this.trustedAnchor(input,source);} catch {valid=false;}
    if(!valid) {
      if(this.readOnly) return {complete:false};
      this.invalidate(input);
      const revision=source.prepare('SELECT id FROM active_fireplace_events WHERE input=? AND at<=? ORDER BY id DESC LIMIT 1').get(input,now)?.id??0;
      const first=source.prepare("SELECT at FROM active_fireplace_events WHERE input=? AND kind='load' AND at<=? ORDER BY at,id LIMIT 1").get(input,now)?.at??null;
      const next=source.prepare('SELECT at FROM active_fireplace_events WHERE input=? AND at>? ORDER BY at LIMIT 1').get(input,now)?.at??null;
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare('DELETE FROM manual_groups WHERE input=?').run(input);
        this.db.prepare(`INSERT OR REPLACE INTO manual_meta VALUES(?,?,?,?,0,?,?,0,NULL,NULL,?,?,?,?,NULL,NULL)`)
          .run(input,token,JSON.stringify(readCheckpoint(source)),head,first===null?'complete':'groups',Number.MIN_SAFE_INTEGER,revision,first,next,now);
        this.sealManual(input);
        this.db.exec('COMMIT');
      } catch(error) {this.db.exec('ROLLBACK');throw error;}
      meta=this.db.prepare('SELECT * FROM manual_meta WHERE input=?').get(input);
    }
    if(this.readOnly||!advance||meta.phase==='complete') return {...meta,complete:meta.phase==='complete'};
    const rows=source.prepare(`SELECT id,at,kind FROM active_fireplace_events WHERE input=?
      AND (at,id)>(?,?) AND at<=? AND id<=? ORDER BY at,id LIMIT ?`)
      .all(input,meta.scan_at,meta.scan_id,meta.as_of,meta.revision,maxRows);
    const removed=source.prepare('SELECT 1 FROM active_fireplace_events WHERE input=? AND target_id=? AND at<=? AND id<=? LIMIT 1');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for(const row of rows) {
        meta.scan_at=row.at;meta.scan_id=row.id;
        if(row.kind!=='load'||removed.get(input,row.id,meta.as_of,meta.revision)) continue;
        if(meta.group_at===null||row.at-meta.group_at>=86_400_000) {
          meta.group_at=row.at;meta.group_id=String(row.id);
          if(meta.first_active_at===null) meta.first_active_at=row.at;
          this.db.prepare('INSERT INTO manual_groups VALUES(?,?,?,?)').run(input,meta.group_id,meta.group_at,hash(JSON.stringify([input,meta.group_id,meta.group_at])));
        }
        meta.scan_at=row.at;meta.scan_id=row.id;
      }
      if(rows.length<maxRows) meta.phase='complete';
      this.db.prepare('UPDATE manual_meta SET phase=?,scan_at=?,scan_id=?,group_id=?,group_at=?,proof=?,first_active_at=? WHERE input=?')
        .run(meta.phase,meta.scan_at,meta.scan_id,meta.group_id,meta.group_at,JSON.stringify(readCheckpoint(source)),meta.first_active_at,input);
      this.sealManual(input);
      this.db.exec('COMMIT');
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
    return {...meta,complete:meta.phase==='complete'};
  }
  manualIntact(meta) {
    if(!meta||typeof meta.checksum!=='string') return false;
    const {checksum,...material}=meta;
    return hash(JSON.stringify(material))===checksum;
  }
  sealManual(input) {
    const {checksum,...material}=this.db.prepare('SELECT * FROM manual_meta WHERE input=?').get(input);
    this.db.prepare('UPDATE manual_meta SET checksum=? WHERE input=?').run(hash(JSON.stringify(material)),input);
  }
  clearManual(input) {
    this.db.prepare('DELETE FROM manual_meta WHERE input=?').run(input);
    this.db.prepare('DELETE FROM manual_groups WHERE input=?').run(input);
    this.invalidate(input);
  }
  validCatalog(input) {
    const tag=`${this.db.prepare('PRAGMA data_version').get().data_version}:${this.db.prepare('SELECT total_changes() n').get().n}`;
    this.checkedCatalogs??=new Map();
    if(this.checkedCatalogs.get(input)===tag) return true;
    const generation=this.db.prepare('SELECT pending,published FROM generation WHERE input=?').get(input);
    if(generation?.published&&!generation.pending) {
      try {if(this.catalog(input)!==JSON.parse(generation.published).digest) return false;} catch {return false;}
    }
    this.checkedCatalogs.set(input,tag);return true;
  }
  context(input,from,to) {
    const meta=this.db.prepare('SELECT * FROM manual_meta WHERE input=?').get(input);
    if(meta?.phase!=='complete') return null;
    const groups=this.db.prepare('SELECT id,at,digest FROM manual_groups WHERE input=? AND at>? AND at<=? ORDER BY at').all(input,from-86_400_000,to);
    if(!this.manualIntact(meta)||groups.some(row=>hash(JSON.stringify([input,row.id,row.at]))!==row.digest)) {
      if(!this.readOnly) this.clearManual(input);
      throw new Error('The disposable firewood source projection is damaged.');
    }
    const context=fireplaceWindowContext({db:this.sourceDb},input,{from:Math.max(0,from),to:Math.max(0,to),revision:meta.revision,asOf:meta.as_of});
    return {...context,firstFireAt:meta.first_active_at,burnGroups:groups.map(({id,at})=>({id,startedAt:at}))};
  }
  generation(input,signature,sourceDb,head,now,prepare=true) {
    if(sourceDb.prepare('SELECT 1 FROM journal_pending LIMIT 1').get()) throw new Error('Uncommitted source cannot supply a derived firewood comparison');
    const current=this.db.prepare('SELECT * FROM generation WHERE input=?').get(input);
    let valid=current?.signature===signature&&current.head<=head&&!(current.next_at!==null&&current.next_at<=now);
    if(valid) try {const proof=JSON.parse(current.proof);valid=SAME(checkpointAt(sourceDb,proof.sequence),proof)||this.trustedAnchor(input,sourceDb);} catch {valid=false;}
    if(!valid) {
      if(this.readOnly||!prepare) return {notReady:true,head};
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare('DELETE FROM snapshots WHERE input=?').run(input);
        this.db.prepare('INSERT OR REPLACE INTO generation VALUES(?,?,?,?,NULL,NULL,NULL,NULL)').run(input,signature,JSON.stringify(readCheckpoint(sourceDb)),head);
        this.db.exec('COMMIT');
      } catch(error) {this.db.exec('ROLLBACK');throw error;}
      this.pin(input,sourceDb);
      return {head,reset:true,next_at:null,want_at:null};
    }
    return current;
  }
  catalog(input) {
    const generation=this.db.prepare('SELECT signature,proof,head,next_at FROM generation WHERE input=?').get(input);
    const manual=this.db.prepare('SELECT * FROM manual_meta WHERE input=?').get(input);
    const groups=this.db.prepare('SELECT id,at,digest FROM manual_groups WHERE input=? ORDER BY at,id').all(input);
    const bodies=this.db.prepare('SELECT cursor,at,digest FROM snapshots WHERE input=? ORDER BY cursor').all(input);
    return hash(JSON.stringify({generation,manual,groups,bodies}));
  }
  trustedAnchor(input,sourceDb) {
    try {
      const saved=this.db.prepare('SELECT published FROM generation WHERE input=?').get(input)?.published;
      if(!saved) return false;
      const proof=JSON.parse(saved);
      return matchesDerivedCacheAnchor(sourceDb,{cacheId:this.cacheId,purpose:'firewood',input,proof})&&this.catalog(input)===proof.digest;
    } catch {return false;}
  }
  pin(input,sourceDb) {
    if(!this.anchor) return;
    const current=this.db.prepare('SELECT pending FROM generation WHERE input=?').get(input);
    if(current?.pending) return;
    const source=readCheckpoint(sourceDb),selection=sourceDb.prepare('SELECT generation FROM history_selection WHERE id=1').get().generation;
    const proof=this.anchor({operation:'pin',input,source,selection});
    this.db.prepare('UPDATE generation SET pending=? WHERE input=?').run(JSON.stringify(proof),input);
  }
  needsPublication(input) {
    const current=this.anchor&&this.db.prepare('SELECT pending,published FROM generation WHERE input=?').get(input);
    return Boolean(current&&(current.pending||!current.published));
  }
  publish(input,sourceDb) {
    if(!this.anchor) return;
    this.pin(input,sourceDb);
    const pending=JSON.parse(this.db.prepare('SELECT pending FROM generation WHERE input=?').get(input).pending);
    const digest=this.catalog(input);
    let proof;
    try {proof=this.anchor({operation:'publish',input,source:pending.source,selection:pending.selection,token:pending.token,digest});}
    catch(error) {
      // A definitive owner rejection permits a fresh pin; a lost/late reply
      // retains its pending proof so the same publication can be retried.
      if(error.code==='DERIVED_CACHE_ANCHOR_REFUSED') this.db.prepare('UPDATE generation SET pending=NULL,published=NULL WHERE input=?').run(input);
      throw error;
    }
    this.db.prepare('UPDATE generation SET pending=NULL,published=? WHERE input=?').run(JSON.stringify(proof),input);
  }
  nearest(input,before) {
    const row=this.db.prepare('SELECT at,cursor,payload,digest,touched FROM snapshots WHERE input=? AND at<=? ORDER BY at DESC,cursor DESC LIMIT 1').get(input,before);
    if(!row) return null;
    try {
      const json=inflateSync(row.payload,{maxOutputLength:FIREWOOD_PROJECTION_BODY_BYTES}).toString();
      if(hash(json)!==row.digest) throw new Error('Damaged disposable projection');
      const saved=JSON.parse(json);
      if(saved.version!==VERSION||saved.input!==input||saved.cursor!==row.cursor||saved.at!==row.at||!validState(saved.state))
        throw new Error('Malformed disposable projection');
      if(!this.readOnly&&Date.now()-row.touched>=300_000) this.db.prepare('UPDATE snapshots SET touched=? WHERE input=? AND cursor=?').run(Date.now(),input,row.cursor);
      return {at:row.at,cursor:row.cursor,state:saved.state};
    } catch {if(!this.readOnly) this.db.prepare('DELETE FROM snapshots WHERE input=? AND cursor=?').run(input,row.cursor);return null;}
  }
  latest(input) {return this.nearest(input,Number.MAX_SAFE_INTEGER);}
  request(input,before) {if(this.readOnly)return;this.db.prepare('UPDATE generation SET want_at=? WHERE input=? AND (want_at IS NULL OR want_at>?)').run(before,input,before);}
  requested(input) {return this.db.prepare('SELECT want_at FROM generation WHERE input=?').get(input)?.want_at??null;}
  requestedComplete(input) {this.db.prepare('UPDATE generation SET want_at=NULL WHERE input=? AND want_at IS NOT NULL').run(input);}
  save(input,snapshot,{checkpoint=false,head,nextAt=null,sourceDb}={}) {
    const json=JSON.stringify({version:VERSION,input,...snapshot});
    if(Buffer.byteLength(json)>FIREWOOD_PROJECTION_BODY_BYTES) throw new Error('Firewood projection checkpoint exceeds its bounded working size');
    const payload=deflateSync(json,{level:1});
    if(sourceDb) this.pin(input,sourceDb);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM snapshots WHERE input=? AND progress=1 AND cursor<>?').run(input,snapshot.cursor);
      let retained=this.db.prepare('SELECT COALESCE(SUM(length(payload)),0) bytes FROM snapshots').get().bytes;
      while(retained+payload.length>this.maxBytes) {
        const old=this.db.prepare('SELECT input,cursor,length(payload) bytes FROM snapshots ORDER BY progress,touched,at LIMIT 1').get();
        if(!old) break;
        this.db.prepare('DELETE FROM snapshots WHERE input=? AND cursor=?').run(old.input,old.cursor);retained-=old.bytes;
      }
      this.db.prepare(`INSERT INTO snapshots VALUES(?,?,?,?,?,?,?) ON CONFLICT(input,cursor) DO UPDATE SET
        progress=MIN(snapshots.progress,excluded.progress),payload=excluded.payload,digest=excluded.digest,touched=excluded.touched`)
        .run(input,snapshot.cursor,snapshot.at,Number(!checkpoint),payload,hash(json),Date.now());
      if(head!==undefined) this.db.prepare('UPDATE generation SET head=?,next_at=?,proof=? WHERE input=?')
        .run(head,nextAt,JSON.stringify(readCheckpoint(sourceDb)),input);
      let bytes=this.db.prepare('SELECT COALESCE(SUM(length(payload)),0) bytes FROM snapshots').get().bytes;
      while(bytes>this.maxBytes) {
        // A demanded old prefix is retained while it is reconstructed. Discard
        // distant points first; no eviction ever causes a synchronous replay.
        const oldest=this.db.prepare(`SELECT s.input,s.cursor,length(s.payload) bytes FROM snapshots s LEFT JOIN generation g ON g.input=s.input
          ORDER BY s.progress,CASE WHEN g.want_at IS NULL THEN s.touched ELSE -ABS(s.at-g.want_at) END,s.at,s.cursor LIMIT 1`).get();
        if(!oldest) break;
        this.db.prepare('DELETE FROM snapshots WHERE input=? AND cursor=?').run(oldest.input,oldest.cursor);bytes-=oldest.bytes;
      }
      this.db.exec('COMMIT');
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
  current() {try{const info=statSync(this.path);return info.ino===this.identity.ino&&info.dev===this.identity.dev;}catch{return false;}}
  removeAfter(input,at,cursor) {this.db.prepare('DELETE FROM snapshots WHERE input=? AND at>? AND cursor<?').run(input,at,cursor);}
  invalidate(input) {this.db.prepare('DELETE FROM generation WHERE input=?').run(input);this.db.prepare('DELETE FROM snapshots WHERE input=?').run(input);}
  close() {this.db.close();}
}
