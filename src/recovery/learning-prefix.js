import { validLearningCheckpoint, learningVersion } from '../app/committed-learning.js';
import { yieldToController } from './scheduler.js';

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
function savedEpoch(db,input,sequence,ordinal) {
  const row=db.prepare(`SELECT after_row FROM journal_changes WHERE table_name='learning_epochs' AND record_key=?
    AND (sequence,ordinal)<=(?,?) ORDER BY sequence DESC,ordinal DESC LIMIT 1`).get(JSON.stringify([input]),sequence,ordinal);
  return row?.after_row ? JSON.parse(row.after_row).epoch : 'original';
}

/** Reuse only a checkpoint whose unchanged prefix and source revisions match.
 * Existing transactional state images supply the durable checkpoints; no second
 * checkpoint recorder or alternative learning engine is introduced. */
export async function findLearningPrefix(store,{input,epoch,earliest,fireplaceRevision=0,sensorRevision=0,yieldControl=yieldToController}) {
  if(!Number.isFinite(earliest)) return null;
  const db=store.db;
  const inspect=(checkpoint,savedInEpoch)=>{
    if(!validLearningCheckpoint(checkpoint) || (checkpoint.fireplaceRevision??0)!==fireplaceRevision
      || (checkpoint.sensorRevision??0)!==sensorRevision) return null;
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
  const current=inspect(store.getState(`adaptive:${input}`),epoch);
  if(current) return current;
  let sequence=Number.MAX_SAFE_INTEGER,ordinal=Number.MAX_SAFE_INTEGER,lastDigest=null;
  for(;;) {
    const rows=db.prepare(`SELECT sequence,ordinal,after_row FROM journal_changes WHERE table_name='state' AND record_key=?
      AND (sequence,ordinal)<(?,?) ORDER BY sequence DESC,ordinal DESC LIMIT 16`).all(JSON.stringify([`adaptive:${input}`]),sequence,ordinal);
    if(!rows.length) return null;
    for(const row of rows) {
      sequence=row.sequence;ordinal=row.ordinal;
      if(!row.after_row) continue;
      const checkpoint=JSON.parse(JSON.parse(row.after_row).value);
      if(checkpoint?.checkpointDigest===lastDigest) continue;
      lastDigest=checkpoint?.checkpointDigest;
      const prefix=inspect(checkpoint,savedEpoch(db,input,row.sequence,row.ordinal));
      if(prefix) return prefix;
    }
    await yieldControl();
  }
}
export function retainLearningPrefix(store,{input,epoch,prefix}) {
  if(!prefix) return;
  store.transaction(()=>{for(const range of prefix.ranges)
    store.db.prepare('INSERT INTO learning_epoch_segments(epoch,input,source_epoch,after_id,through_id) VALUES(?,?,?,?,?)')
      .run(epoch,input,range.sourceEpoch,range.after,range.through);
  });
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
