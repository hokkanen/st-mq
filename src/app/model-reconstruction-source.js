import { LEARNING_ALGORITHM, learningVersion } from './committed-learning.js';
import { sensorRevision } from './sensor-inputs.js';
import { readCheckpoint } from '../storage/journal.js';
import { learningPrefixRanges } from '../recovery/learning-prefix.js';

export const reconstructionInput = input => input === 'offline' ? 'history' : input;
export const decodeReconstructionEntry = row => ({ id:row.id,key:row.key,kind:row.kind,at:row.at,
  algorithmVersion:row.algorithm_version,configVersion:row.config_version===null?null:JSON.parse(row.config_version),
  forecastVersion:row.forecast_version===null?null:JSON.parse(row.forecast_version),payload:JSON.parse(row.payload) });
const state = (store,key) => {
  const row=store.db.prepare('SELECT value FROM state WHERE key=?').get(key);
  return row ? JSON.parse(row.value) : null;
};

/** Metadata only. Large prepared model/sample bodies are hydrated in the worker.
 * Pending corrections still belong to the previously published interpretation. */
export function reconstructionSource(store,input,{through=Infinity,countEntries=false,includeModel=true,revisions}={}) {
  input=reconstructionInput(input);
  const database=readCheckpoint(store.db),epoch=store.db.prepare('SELECT epoch FROM learning_epochs WHERE input=?').get(input)?.epoch??'original';
  const selection=store.db.prepare('SELECT generation FROM history_selection WHERE id=1').get().generation;
  const compact=includeModel?state(store,`adaptive:${input}`):null,recovery=state(store,`recovery:active:${input}`),correction=state(store,`fireplace:rebuild:${input}`);
  const pending=['importing','rebuilding','catching-up'].includes(recovery?.status)
    || correction?.requiresRebuild===true
    || correction?.requiresRebuild!==false&&['pending','running','ready'].includes(correction?.status);
  const published=!includeModel?store.db.prepare('SELECT g.fireplace_revision,g.sensor_revision FROM coefficient_selection s JOIN coefficient_generations g ON g.id=s.generation WHERE s.input=?').get(input):null;
  const fireplaceRevision=revisions?.fireplaceRevision??(compact?compact.fireplaceRevision??0:published?.fireplace_revision??(pending?0:store.db.prepare('SELECT COALESCE(MAX(id),0) id FROM active_fireplace_events WHERE input=?').get(input).id));
  const sensors=revisions?.sensorRevision??(compact?compact.sensorRevision??0:published?.sensor_revision??(pending?0:sensorRevision(store,input)));
  let head=store.db.prepare('SELECT id FROM learning_journal WHERE input=? ORDER BY id DESC LIMIT 1').get(input)?.id??0;
  const maximum=cursor=>Math.max(-Infinity,...learningPrefixRanges(store.db,input,epoch,cursor).map(r=>store.db.prepare(`SELECT at FROM learning_journal_entries INDEXED BY learning_entries_epoch_time
    WHERE epoch=? AND input=? AND id>? AND id<=? ORDER BY at DESC LIMIT 1`).get(r.sourceEpoch,input,r.after,r.through)?.at??-Infinity));
  if(Number.isFinite(through)&&maximum(head)>through){const future=store.db.prepare('SELECT MIN(id) id FROM learning_journal WHERE input=? AND at>?').get(input,through).id;head=future===null?head:store.db.prepare('SELECT id FROM learning_journal WHERE input=? AND id<? ORDER BY id DESC LIMIT 1').get(input,future)?.id??0;}
  const lastAt=maximum(head),total=countEntries?store.db.prepare('SELECT COUNT(*) count FROM learning_journal WHERE input=? AND id<=?').get(input,head).count:null;
  const identity={databaseId:database.databaseId,input,epoch,selection,algorithm:LEARNING_ALGORITHM,fireplaceRevision,sensorRevision:sensors};
  return {...identity,key:learningVersion(identity),head,throughAt:Number.isFinite(lastAt)?lastAt:null,total,pending,
    savedCursor:compact?.journalCursor??0,savedDigest:compact?.checkpointDigest??null,
    savedAt:compact?.journalCursor?maximum(compact.journalCursor):null,
    compact,database};
}
