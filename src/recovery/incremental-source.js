import { createReadStream } from 'node:fs';
import { JOURNALED_TABLES, RECOVERABLE_TABLES } from '../storage/schema.js';
import { quoteIdentifier as q } from '../storage/journal-schema.js';
import { matchingCheckpoint, validCheckpoint, MAX_COMMIT_BYTES, resolveChange } from '../storage/journal.js';
import { peerAnchor, reversePeerChanges } from '../storage/journal-peer.js';
import { changeContentHash } from '../storage/journal-codec.js';
import { Store } from '../storage/store.js';
import { yieldToController } from './scheduler.js';

const invalid = () => { throw Object.assign(new Error('The recovery transaction source changed or is incomplete; check again.'), { code:'RECOVERY_INVALID' }); };
const tables = new Map(JOURNALED_TABLES.map(table => [table.name,table]));
const sourceTable = name => name === 'learning_journal_entries' ? 'learning_journal' : name;
const keyOf = (table,row) => table === 'import_rows' ? `${row.import_id}:${row.row_number}` : String(row.id ?? row.key);
const recoverable = new Set([...RECOVERABLE_TABLES,'learning_journal','state']);

async function* journalLines(path) {
  let pending='';
  for await(const chunk of createReadStream(path,{encoding:'utf8',highWaterMark:64*1024})) {
    pending+=chunk;
    for(;;) {
      const end=pending.indexOf('\n');
      if(end<0) break;
      const line=pending.slice(0,end);pending=pending.slice(end+1);
      if(Buffer.byteLength(line)>MAX_COMMIT_BYTES) invalid();
      yield line;
    }
    if(Buffer.byteLength(pending)>MAX_COMMIT_BYTES) invalid();
  }
  if(pending.length) yield pending;
}

function initializeKeys(donor) {
  if (donor.recoveryKeysReady) return;
  donor.recoveryKeysReady=true;
  donor.db.exec(`PRAGMA query_only=OFF; CREATE TEMP TABLE recovery_source_keys(
    table_name TEXT NOT NULL,record_key TEXT NOT NULL,visited INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(table_name,record_key)) WITHOUT ROWID;`);
}
function include(donor,table,row) {
  if(row && ['charging_reports','charging_report_events','charging_report_contexts'].includes(table)) {
    donor.db.prepare('INSERT OR IGNORE INTO recovery_source_keys(table_name,record_key,visited) VALUES(?,?,1)')
      .run(table,JSON.stringify(tables.get(table).keys.map(key=>row[key])));
    return;
  }
  table=sourceTable(table);
  if (row && recoverable.has(table)) donor.db.prepare('INSERT OR IGNORE INTO recovery_source_keys(table_name,record_key) VALUES(?,?)')
    .run(table,keyOf(table,row));
}
function references(table,row) {
  const result=[];
  const add=(name,id)=>{if(id!==null && id!==undefined) result.push([name,String(id)]);};
  if(row.import_id!==undefined) add('imports',row.import_id);
  if(row.observation_id!==undefined) add('observations',row.observation_id);
  if(table==='provider_snapshot_fetches') add('provider_snapshot_contents',row.content_id);
  if(table==='fireplace_events') add('fireplace_events',row.target_id);
  const direct={observationId:'observations',sourceObservationId:'observations',coverageId:'recorder_coverage',snapshotId:'provider_snapshot_fetches',
    importId:'imports',cycleId:'learning_cycles',episodeId:'learning_cycles'};
  const arrays={observations:'observations',coverage:'recorder_coverage',journal:'learning_journal'};
  let nodes=0;
  const visit=(value,parent='',depth=0)=>{
    if(++nodes>1_000_000 || depth>32) invalid();
    if(!value || typeof value!=='object') return;
    for(const [key,item] of Object.entries(value)) {
      if(direct[key]) add(direct[key],item);
      else if(arrays[key] && Array.isArray(item)) for(const entry of item) {
        if(entry && typeof entry==='object') visit(entry,key,depth+1); else add(arrays[key],entry);
      }
      else if(key==='id' && parent==='sensorRevert') add('learning_journal',item);
      else if(key==='id' && ['forecastVersion','forecast_version'].includes(parent)) add('provider_snapshot_fetches',item);
      else if(key==='contentId' && ['forecastVersion','forecast_version'].includes(parent)) add('provider_snapshot_contents',item);
      else visit(item,key,depth+1);
    }
  };
  for(const field of ['raw','payload','forecast_version']) if(typeof row[field]==='string') {
    try { visit(JSON.parse(row[field]),field); } catch(error) { if(error.code==='RECOVERY_INVALID') throw error; }
  }
  return result;
}
export async function scopeIncrementalSource(donor,{base,checkpoint,changes,yieldControl=yieldToController}) {
  initializeKeys(donor);
  let seen=0;
  for(const change of changes) {
    // Updates contain changed columns only. Stable keys identify the final
    // source row even when its identity columns are absent from the patch.
    if (change.after !== null) include(donor,change.table,Object.fromEntries(
      tables.get(change.table).keys.map((column,index)=>[column,change.key[index]])));
    if(++seen%128===0) await yieldControl();
  }
  // A changed row may refer to common-prefix evidence. Resolve that compact
  // closure through primary keys so the established merge keeps its provenance.
  for(;;) {
    const keys=donor.db.prepare('SELECT table_name,record_key FROM recovery_source_keys WHERE visited=0 LIMIT 64').all();
    if(!keys.length) break;
    for(const key of keys) {
      const table=key.table_name;
      const row=table==='import_rows' ? donor.db.prepare('SELECT * FROM import_rows WHERE import_id=? AND row_number=?').get(...key.record_key.split(':').map(Number))
        : donor.db.prepare(`SELECT * FROM ${q(table)} WHERE ${table==='state'?'key':'id'}=?`).get(['state','learning_cycles'].includes(table)?key.record_key:Number(key.record_key));
      if(row) for(const [name,id] of references(table,row)) donor.db.prepare('INSERT OR IGNORE INTO recovery_source_keys(table_name,record_key) VALUES(?,?)').run(name,id);
      donor.db.prepare('UPDATE recovery_source_keys SET visited=1 WHERE table_name=? AND record_key=?').run(table,key.record_key);
    }
    await yieldControl();
  }
  // Materialize only the changed-key closure. SQLite can otherwise flatten a
  // normal keyed SELECT but materialize a whole UNION overlay for COUNT/SUM.
  for(const name of [...RECOVERABLE_TABLES,'state']) {
    const table=tables.get(name),scratch=`recovery_source_rows_${name}`;
    donor.db.exec(`CREATE TEMP TABLE ${q(scratch)}(${table.columns.map(q).join(',')},PRIMARY KEY(${table.keys.map(q).join(',')}));`);
    const put=donor.db.prepare(`INSERT INTO ${q(scratch)} VALUES(${table.columns.map(()=>'?').join(',')})`);
    const get=donor.db.prepare(`SELECT * FROM ${q(name)} WHERE ${table.keys.map(column=>`${q(column)}=?`).join(' AND ')}`);
    let after='';
    for(;;) {
      const keys=donor.db.prepare('SELECT record_key FROM recovery_source_keys WHERE table_name=? AND record_key>? ORDER BY record_key LIMIT 64').all(name,after);
      if(!keys.length) break;
      for(const key of keys) {
        const values=name==='import_rows'?key.record_key.split(':').map(Number)
          :[['state','learning_cycles'].includes(name)?key.record_key:Number(key.record_key)];
        const row=get.get(...values);
        if(row) put.run(...table.columns.map(column=>row[column]));
        after=key.record_key;
      }
      await yieldControl();
    }
    if(name==='state') donor.db.exec(`CREATE TEMP VIEW recovery_source_state AS SELECT * FROM ${q(scratch)};`);
    else donor.db.exec(`DROP VIEW IF EXISTS temp.active_${name};
      CREATE TEMP VIEW active_${name} AS SELECT r.* FROM ${q(scratch)} r
      WHERE NOT EXISTS(SELECT 1 FROM recovery_exclusions x WHERE x.generation=(SELECT generation FROM history_selection WHERE id=1)
        AND x.table_name='${name}' AND x.record_key=${name==='import_rows'?"printf('%d:%d',r.import_id,r.row_number)":'CAST(r.id AS TEXT)'});`);
  }
  // An aggregate over a join to the UNION journal view can make SQLite
  // materialize every historical row. Keep only the selected changed rows in
  // private scratch; each source read is an indexed point lookup.
  donor.db.exec(`CREATE TEMP TABLE recovery_source_journal(id INTEGER PRIMARY KEY,input TEXT,key TEXT,kind TEXT,at INTEGER,
    algorithm_version TEXT,config_version TEXT,forecast_version TEXT,payload TEXT);`);
  const putJournal=donor.db.prepare('INSERT INTO recovery_source_journal VALUES(?,?,?,?,?,?,?,?,?)');
  let afterJournal='';
  for(;;) {
    const keys=donor.db.prepare(`SELECT record_key FROM recovery_source_keys WHERE table_name='learning_journal'
      AND record_key>? ORDER BY record_key LIMIT 64`).all(afterJournal);
    if(!keys.length) break;
    for(const key of keys) {
      const row=donor.db.prepare('SELECT * FROM learning_journal WHERE id=?').get(Number(key.record_key));
      if(row) putJournal.run(row.id,row.input,row.key,row.kind,row.at,row.algorithm_version,row.config_version,row.forecast_version,row.payload);
      afterJournal=key.record_key;
    }
    await yieldControl();
  }
  donor.recoveryState='recovery_source_state';
  donor.recoveryJournal='recovery_source_journal';
  donor.incremental={base,checkpoint,records:donor.db.prepare('SELECT COUNT(*) n FROM recovery_source_keys').get().n};
  return donor.incremental;
}

/** A read-only MAIN connection plus private TEMP overlays represents the donor
 * at a shared transaction boundary. Only divergent rows occupy scratch storage. */
export async function openJournalSource({masterPath,journalPath,yieldControl=yieldToController}) {
  const donor=new Store(masterPath,{readOnly:true});
  try {
    donor.db.exec('PRAGMA query_only=OFF; PRAGMA temp_store=FILE; PRAGMA temp.cache_size=-8192; BEGIN;');
    const lines=journalLines(journalPath);
    let header=null,records=0,peerHash=null,peerRows=0;
    initializeKeys(donor);
    for await(const line of lines) {
      if(Buffer.byteLength(line)>MAX_COMMIT_BYTES) invalid();
      let value;try{value=JSON.parse(line);}catch{invalid();}
      if(!header) {
        const anchor=peerAnchor(donor.db);
        if(!value || value.version!==1 || value.mode!=='peer' || !validCheckpoint(value.base) || !validCheckpoint(value.target)
          || !Object.keys(value).every(key=>['version','mode','id','base','target','contentHash','rows'].includes(key))
          || !matchingCheckpoint(anchor?.checkpoint,value.base)
          || value.base.databaseId!==value.target.databaseId || value.base.sequence>value.target.sequence
          || !Number.isSafeInteger(value.rows)||value.rows<0||!/^[a-f0-9]{64}$/.test(value.contentHash)) invalid();
        header=value;peerHash=anchor.contentHash;
        donor.db.exec('CREATE TEMP TABLE recovery_overlay_changes(table_name TEXT NOT NULL,record_key TEXT NOT NULL,row TEXT,PRIMARY KEY(table_name,record_key)) WITHOUT ROWID;');
        const put=donor.db.prepare('INSERT INTO recovery_overlay_changes VALUES(?,?,?) ON CONFLICT(table_name,record_key) DO UPDATE SET row=excluded.row');
        // Restore only keys changed since the shared peer anchor. Unchanged
        // historical rows remain in the pinned main database.
        for(const change of reversePeerChanges(donor.db)) {
          const table=tables.get(change.table),key=JSON.stringify(change.key);
          const previous=donor.db.prepare('SELECT row FROM recovery_overlay_changes WHERE table_name=? AND record_key=?').get(change.table,key);
          const actual=previous ? previous.row===null ? null : JSON.parse(previous.row)
            : donor.db.prepare(`SELECT * FROM main.${q(change.table)} WHERE ${table.keys.map(column=>`${q(column)} IS ?`).join(' AND ')}`).get(...change.key) ?? null;
          const before=resolveChange(change,actual,{reverse:true});
          put.run(change.table,key,before===null?null:JSON.stringify(before));
          if(++records%128===0) await yieldControl();
        }
        for(const table of tables.values()) {
          const key=`json_array(${table.keys.map(column=>`r.${q(column)}`).join(',')})`;
          donor.db.exec(`CREATE TEMP VIEW ${q(table.name)} AS SELECT r.* FROM main.${q(table.name)} r
            WHERE NOT EXISTS(SELECT 1 FROM recovery_overlay_changes c WHERE c.table_name='${table.name}' AND c.record_key=${key})
            UNION ALL SELECT ${table.columns.map(column=>`json_extract(c.row,'$.${column}')`).join(',')}
            FROM recovery_overlay_changes c WHERE c.table_name='${table.name}' AND c.row IS NOT NULL;`);
        }
        for(const view of donor.db.prepare("SELECT name,sql FROM main.sqlite_schema WHERE type='view'").all())
          donor.db.exec(view.sql.replace(/^CREATE VIEW/i,'CREATE TEMP VIEW'));
      } else {
        const put=donor.db.prepare('INSERT INTO recovery_overlay_changes VALUES(?,?,?) ON CONFLICT(table_name,record_key) DO UPDATE SET row=excluded.row');
        for(const change of [value]) {
          const table=tables.get(change.table);
          const actual=donor.db.prepare(`SELECT * FROM ${q(change.table)} WHERE ${table.keys.map(column=>`${q(column)} IS ?`).join(' AND ')}`).get(...change.key) ?? null;
          const after=resolveChange(change,actual);
          put.run(change.table,JSON.stringify(change.key),after===null?null:JSON.stringify(after));
          include(donor,change.table,after);
          peerHash=changeContentHash(peerHash,[change]);peerRows++;
        }
        await yieldControl();
      }
    }
    if(!header || peerRows!==header.rows || peerHash!==header.contentHash) invalid();
    await scopeIncrementalSource(donor,{base:header.base,checkpoint:header.target,changes:[],yieldControl});
    donor.journalSource=true;
    return donor;
  } catch(error) {donor.close();throw error;}
}
