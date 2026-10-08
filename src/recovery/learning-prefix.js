import { validLearningCheckpoint, learningVersion, learningCheckpointDigest } from '../app/committed-learning.js';
import { yieldToController } from './scheduler.js';
import { journalBase, resolveChange, reverseChanges } from '../storage/journal.js';
import { sensorLearningContext } from '../app/sensor-inputs.js';

const decode=row=>({id:row.id,key:row.key,kind:row.kind,at:row.at,algorithmVersion:row.algorithm_version,
  configVersion:row.config_version===null?null:JSON.parse(row.config_version),
  forecastVersion:row.forecast_version===null?null:JSON.parse(row.forecast_version),payload:JSON.parse(row.payload)});

/** Flattened ranges name immutable rows, not another interpreted epoch. Each
 * range costs two indexed endpoint reads regardless of its historical length. */
export function learningPrefixRanges(db,input,epoch,through) {
  const ranges=db.prepare('SELECT source_epoch,after_id,through_id FROM learning_epoch_segments WHERE epoch=? AND input=? AND after_id<?')
    .all(epoch,input,through);
  ranges.push({source_epoch:epoch,after_id:0,through_id:through});
  const result=[];
  for(const range of ranges) {
    const end=Math.min(through,range.through_id);
    const first=db.prepare('SELECT id FROM learning_journal_entries WHERE epoch=? AND input=? AND id>? AND id<=? ORDER BY id LIMIT 1')
      .get(range.source_epoch,input,range.after_id,end)?.id;
    if(first===undefined) continue;
    const last=db.prepare('SELECT id FROM learning_journal_entries WHERE epoch=? AND input=? AND id>? AND id<=? ORDER BY id DESC LIMIT 1')
      .get(range.source_epoch,input,range.after_id,end).id;
    result.push({sourceEpoch:range.source_epoch,after:first-1,through:last});
  }
  return result.sort((a,b)=>a.after-b.after);
}
/** Reuse only a checkpoint whose unchanged prefix and source revisions match.
 * Recent transaction patches and sparse durable checkpoints both accelerate the
 * same supported replay engine. Required source inputs remain independently
 * reconstructible when a cache is unavailable or the affected time is early. */
export async function findLearningPrefix(store,options) {
  if(!Number.isFinite(options.earliest)) return null;
  // A controller can advance this same WAL database while reconstruction yields.
  // Pin state, epochs and compact patches to one boundary; retain an existing
  // caller-owned snapshot and release only a transaction started here.
  let started=false;
  try { store.db.exec('BEGIN');started=true; }
  catch(error) { if(!/within a transaction/.test(error.message)) throw error; }
  try { return await findPinnedLearningPrefix(store,options); }
  finally { if(started) store.db.exec('ROLLBACK'); }
}
async function findPinnedLearningPrefix(store,{input,epoch,earliest,fireplaceRevision=0,sensorRevision=0,yieldControl=yieldToController}) {
  if(!Number.isFinite(earliest)) return null;
  const db=store.db;
  const selection=db.prepare('SELECT generation FROM history_selection WHERE id=1').get().generation;
  const revisions=new Map();
  const sensorTargets=(savedEpoch,revision)=>new Map(sensorLearningContext(store,input,revision,{epoch:savedEpoch})
    .revertedSensorChanges.map(id=>{
      const row=db.prepare(`SELECT COALESCE(original.id,e.id) id,COALESCE(original.at,e.at) at
        FROM learning_journal_entries e LEFT JOIN learning_journal_entries original ON original.id=e.source_entry_id
        WHERE e.id=? AND e.input=?`).get(id,input);
      return [row?.id??id,row?.at??-Infinity];
    }));
  let expectedSensors;
  const samePrefixSources=(checkpoint,savedInEpoch,savedSelection)=>{
    const fire=checkpoint.fireplaceRevision??0,sensor=checkpoint.sensorRevision??0;
    if(![fire,sensor].every(value=>Number.isSafeInteger(value)&&value>=0) || !savedSelection) return false;
    const key=JSON.stringify([fire,sensor,savedInEpoch,savedSelection]);
    if(revisions.has(key)) return revisions.get(key);
    let affected=Infinity;
    if(fire!==fireplaceRevision) {
      const row=db.prepare(`SELECT MIN(CASE WHEN e.kind='remove' THEN COALESCE(p.at,${Number.MIN_SAFE_INTEGER}) ELSE e.at END) at
        FROM fireplace_events e LEFT JOIN fireplace_events p ON p.id=e.target_id
        WHERE e.input=? AND e.id>? AND e.id<=?`).get(input,Math.min(fire,fireplaceRevision),Math.max(fire,fireplaceRevision));
      affected=row.at??-Infinity;
    }
    if(savedSelection!==selection) {
      const row=db.prepare(`SELECT MIN(CASE WHEN e.kind='remove' THEN COALESCE(p.at,${Number.MIN_SAFE_INTEGER}) ELSE e.at END) at
        FROM recovery_exclusions x JOIN fireplace_events e ON e.id=CAST(x.record_key AS INTEGER)
        LEFT JOIN fireplace_events p ON p.id=e.target_id
        WHERE x.generation IN (?,?) AND x.table_name='fireplace_events' AND e.input=? AND e.id<=?
          AND NOT EXISTS(SELECT 1 FROM recovery_exclusions other
            WHERE other.generation=CASE WHEN x.generation=? THEN ? ELSE ? END
              AND other.table_name=x.table_name AND other.record_key=x.record_key)`)
        .get(savedSelection,selection,input,Math.max(fire,fireplaceRevision),savedSelection,selection,savedSelection);
      affected=Math.min(affected,row.at??Infinity);
    }
    if(sensor!==sensorRevision || savedInEpoch!==epoch) {
      expectedSensors??=sensorTargets(epoch,sensorRevision);
      const saved=sensorTargets(savedInEpoch,sensor);
      for(const [id,at] of saved) if(!expectedSensors.has(id)) affected=Math.min(affected,at);
      for(const [id,at] of expectedSensors) if(!saved.has(id)) affected=Math.min(affected,at);
    }
    const matches=affected>=earliest;
    revisions.set(key,matches);return matches;
  };
  const inspect=(checkpoint,savedInEpoch,savedSelection)=>{
    if(!validLearningCheckpoint(checkpoint) || !samePrefixSources(checkpoint,savedInEpoch,savedSelection)) return null;
    const row=db.prepare('SELECT * FROM learning_journal_all WHERE epoch=? AND input=? AND id=?').get(epoch,input,checkpoint.journalCursor);
    if(!row || row.at>=earliest || !validLearningCheckpoint(checkpoint,decode(row))) return null;
    const ranges=learningPrefixRanges(db,input,epoch,row.id);
    // A context/episode may be committed after a later-timed sample. Checking
    // only the checkpoint's final entry time would reuse already-affected
    // learning. Seek each compact range's temporal endpoint as well.
    for(const range of ranges) {
      const latest=db.prepare(`SELECT at FROM learning_journal_entries INDEXED BY learning_entries_epoch_time WHERE epoch=? AND input=?
        AND id>? AND id<=? ORDER BY at DESC LIMIT 1`).get(range.sourceEpoch,input,range.after,range.through)?.at;
      if(latest>=earliest) return null;
    }
    if(savedInEpoch!==epoch && learningVersion(ranges)!==learningVersion(learningPrefixRanges(db,input,savedInEpoch,row.id))) return null;
    return {checkpoint,cursor:row.id,at:row.at,ranges};
  };
  const selectedEpoch=db.prepare('SELECT epoch FROM learning_epochs WHERE input=?').get(input)?.epoch ?? 'original';
  const current=inspect(store.getState(`adaptive:${input}`),selectedEpoch,selection);
  if(current) return current;
  const base=journalBase(db),key=`adaptive:${input}`;
  let state=db.prepare('SELECT * FROM state WHERE key=?').get(key) ?? null;
  let epochState=db.prepare('SELECT * FROM learning_epochs WHERE input=?').get(input) ?? null;
  let selectionState=db.prepare('SELECT * FROM history_selection WHERE id=1').get();
  const epochChanges=reverseChanges(db,{after:base,table:'learning_epochs',key:[input]});
  const selectionChanges=reverseChanges(db,{after:base,table:'history_selection',key:[1]});
  let epochChange=epochChanges.next(),lastDigest=null,visited=0;
  let selectionChange=selectionChanges.next();
  for(const change of reverseChanges(db,{after:base,table:'state',key:[key]})) {
    state=resolveChange(change,state,{reverse:true});
    // Changes for each key are coalesced across the atomic transaction. Its
    // before-state belongs to the prior commit, regardless of table order.
    while(!epochChange.done && epochChange.value.sequence>=change.sequence) {
      epochState=resolveChange(epochChange.value,epochState,{reverse:true});
      epochChange=epochChanges.next();
    }
    while(!selectionChange.done && selectionChange.value.sequence>=change.sequence) {
      selectionState=resolveChange(selectionChange.value,selectionState,{reverse:true});
      selectionChange=selectionChanges.next();
    }
    if(state) {
      const checkpoint=JSON.parse(state.value);
      if(checkpoint?.checkpointDigest!==lastDigest) {
        lastDigest=checkpoint?.checkpointDigest;
        const prefix=inspect(checkpoint,epochState?.epoch ?? 'original',selectionState?.generation);
        if(prefix) return prefix;
      }
    }
    if(++visited%16===0) await yieldControl();
  }
  // Indexed source-time seek visits candidates before the affected boundary.
  // Range identity and original correction times prove older source revisions
  // leave this prefix unchanged; a different revision alone is not permission.
  let candidates=0;
  for(const row of db.prepare(`SELECT epoch,history_selection,payload FROM learning_checkpoints
    WHERE input=? AND at<? ORDER BY at DESC,journal_cursor DESC`)
    .iterate(input,earliest)) {
    let checkpoint;
    try { checkpoint=JSON.parse(row.payload); } catch { continue; }
    const prefix=inspect(checkpoint,row.epoch,row.history_selection);
    if(prefix) return prefix;
    if(++candidates%16===0) await yieldControl();
  }
  return null;
}
export function retainLearningPrefix(store,{input,epoch,prefix}) {
  if(!prefix) return;
  store.transaction(()=>{for(const range of prefix.ranges)
    store.db.prepare('INSERT INTO learning_epoch_segments(epoch,input,source_epoch,after_id,through_id) VALUES(?,?,?,?,?)')
      .run(epoch,input,range.sourceEpoch,range.after,range.through);
  });
}

/** The caller has proved that changed source interpretations begin after this
 * prefix. Numerical state stays identical; global revision metadata must match
 * replay from the same seed even when the corrected suffix contains no entries. */
export function withPrefixRevisions(checkpoint, source) {
  if (!checkpoint) return null;
  const next = { ...checkpoint, sensorRevision: source.sensorRevision ?? 0 };
  if (source.fireplaceRevision) next.fireplaceRevision = source.fireplaceRevision;
  else delete next.fireplaceRevision;
  next.checkpointDigest = learningCheckpointDigest(next);
  return next;
}
export function prefixSourceId(store,{input,epoch,prefix,id}) {
  if(!prefix || !Number.isSafeInteger(id)) return undefined;
  const direct=store.db.prepare('SELECT id,epoch FROM learning_journal_entries WHERE id=? AND input=?').get(id,input);
  if(direct && prefix.ranges.some(range=>range.sourceEpoch===direct.epoch && id>range.after && id<=range.through)) return id;
  for(const range of prefix.ranges) {
    const row=store.db.prepare(`SELECT id FROM learning_journal_entries WHERE source_entry_id=?
      AND epoch=? AND input=? AND id>? AND id<=? LIMIT 1`).get(id,range.sourceEpoch,input,range.after,range.through);
    if(row) return row.id;
  }
  return undefined;
}
