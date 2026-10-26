import { randomUUID } from 'node:crypto';
import { MODEL_COEFFICIENT_INFO } from '../domain/history-series.js';
import { emptyCoefficientProjection } from '../domain/coefficient-projection.js';
import { learningPrefixRanges } from '../recovery/learning-prefix.js';
import { LEARNING_ALGORITHM } from '../domain/learning-contract.js';
import { unchangedFireplacePrefix } from '../app/fireplace-inputs.js';

const epochOf = (store, input) => store.db.prepare('SELECT epoch FROM learning_epochs WHERE input=?').get(input)?.epoch ?? 'original';
const selectionOf = store => store.db.prepare('SELECT generation FROM history_selection WHERE id=1').get().generation;
const decode = row => row && ({ generation: row.id, input: row.input, epoch: row.epoch,
  fireplaceRevision: row.fireplace_revision, sensorRevision: row.sensor_revision, selection: row.history_selection,
  cursor: row.cursor, throughAt: row.through_at });
const failure = () => new Error('Coefficient history does not match its committed learning boundary.');
const keysEqual=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)
  &&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
function validValues(value) {
  return value===null||keysEqual(value,Object.keys(MODEL_COEFFICIENT_INFO))&&Object.values(value).every(row=>keysEqual(row,['value','status','updatedAt'])
    &&(row.value===null||Number.isFinite(row.value))&&['initial','fitted','retained'].includes(row.status)&&Number.isSafeInteger(row.updatedAt));
}
function validProjection(value) {
  const parameters=new Set(Object.values(MODEL_COEFFICIENT_INFO).map(info=>info.parameter));
  return keysEqual(value,['at','cursor','learned','fitted','coefficients','blocked'])
    &&Number.isSafeInteger(value.cursor)&&value.cursor>=0&&(value.at===null||Number.isSafeInteger(value.at))
    &&typeof value.blocked==='boolean'&&validValues(value.coefficients)
    &&['learned','fitted'].every(key=>Array.isArray(value[key])&&value[key].every(parameter=>parameters.has(parameter)));
}
const packedProjection=value=>({learned:value.learned,fitted:value.fitted,blocked:value.blocked});
function eventProjection(row) {
  const packed=JSON.parse(row.projection),coefficients=JSON.parse(row.coefficients);
  if(!keysEqual(packed,['learned','fitted','blocked']))throw failure();
  const projection={at:row.at,cursor:row.cursor,learned:packed.learned,fitted:packed.fitted,coefficients,blocked:packed.blocked};
  if(!validProjection(projection))throw failure();
  return projection;
}
export function validateCoefficientHistory(db,{full=false}={}) {
  const invalid=()=>{throw Object.assign(new Error('Unsupported or malformed coefficient history. Preserve the database and use an intact current-format backup.'),{code:'database_state_incompatible'});};
  for(const row of db.prepare(full?'SELECT * FROM coefficient_generations':`SELECT g.* FROM coefficient_selection s
    JOIN coefficient_generations g ON g.id=s.generation WHERE s.input=g.input`).iterate()) {
    let projection;try{projection=JSON.parse(row.projection);}catch{invalid();}
    if(!validProjection(projection)||row.cursor!==projection.cursor||row.through_at!==projection.at)invalid();
  }
  if(db.prepare(`SELECT 1 FROM coefficient_selection s LEFT JOIN coefficient_generations g ON g.id=s.generation
    WHERE g.id IS NULL OR s.input<>g.input OR g.epoch<>COALESCE((SELECT epoch FROM learning_epochs WHERE input=s.input),'original') LIMIT 1`).get())invalid();
  if(full){
    for(const row of db.prepare(`SELECT g.* FROM coefficient_generations g WHERE cursor>0`).iterate())
      if(!db.prepare('SELECT 1 FROM learning_journal_all WHERE input=? AND epoch=? AND id=?').get(row.input,row.epoch,row.cursor))invalid();
    if(db.prepare(`SELECT 1 FROM coefficient_segments p JOIN coefficient_generations g ON g.id=p.generation
      JOIN coefficient_generations s ON s.id=p.source_generation WHERE g.input<>s.input OR p.after_cursor<0
      OR p.through_cursor>s.cursor OR EXISTS(SELECT 1 FROM coefficient_events e WHERE e.generation=g.id
        AND e.cursor<=p.through_cursor) LIMIT 1`).get())invalid();
    const previous=new Map(),edges=new Map();
    for(const row of db.prepare('SELECT * FROM coefficient_segments ORDER BY generation,after_cursor').iterate()){
      if((previous.get(row.generation)??0)>row.after_cursor)invalid();previous.set(row.generation,row.through_cursor);
      if(!edges.has(row.generation))edges.set(row.generation,[]);edges.get(row.generation).push(row.source_generation);
    }
    const visited=new Set(),active=new Set();
    const visit=id=>{if(active.has(id))invalid();if(visited.has(id))return;active.add(id);for(const source of edges.get(id)??[])visit(source);active.delete(id);visited.add(id);};
    for(const id of edges.keys())visit(id);
  }
  if(full)for(const row of db.prepare('SELECT * FROM coefficient_events').iterate()) {
    try{eventProjection(row);}catch{invalid();}
    const generation=db.prepare('SELECT input,epoch FROM coefficient_generations WHERE id=?').get(row.generation);
    if(!generation||!db.prepare('SELECT 1 FROM learning_journal_all WHERE input=? AND epoch=? AND id=?').get(generation.input,generation.epoch,row.cursor))invalid();
  }
}
export function readCoefficientCoverage(store, { input, epoch = epochOf(store, input), generation } = {}) {
  const row = generation ? store.db.prepare('SELECT * FROM coefficient_generations WHERE id=? AND input=?').get(generation, input)
    : store.db.prepare('SELECT g.* FROM coefficient_selection s JOIN coefficient_generations g ON g.id=s.generation WHERE s.input=?').get(input);
  return row?.epoch === epoch ? decode(row) : null;
}
function ranges(store, generation, through = Number.MAX_SAFE_INTEGER) {
  if (!generation) return [];
  const first=store.db.prepare('SELECT cursor FROM coefficient_events WHERE generation=? AND cursor<=? ORDER BY cursor LIMIT 1')
    .get(generation,through)?.cursor;
  return [...(first===undefined?[]:[{ source_generation: generation, after_cursor: first-1, through_cursor: through }]),
    ...store.db.prepare('SELECT source_generation,after_cursor,through_cursor FROM coefficient_segments WHERE generation=? AND after_cursor<?')
      .all(generation, through).map(row => ({ ...row, through_cursor: Math.min(row.through_cursor, through) }))]
    .sort((a,b)=>a.after_cursor-b.after_cursor);
}
function* coefficientEvents(store, { input, epoch = epochOf(store, input), generation,
  afterCursor = 0, throughCursor = Number.MAX_SAFE_INTEGER, from = Number.MIN_SAFE_INTEGER, to = Number.MAX_SAFE_INTEGER, limit } = {}) {
  const coverage = readCoefficientCoverage(store, { input, epoch, generation });
  if (!coverage) return;
  // Recent chart windows seek time before sorting their selected cursors. Full
  // verification pages retain cursor seeks and never sort the complete archive.
  const ranged = from > Number.MIN_SAFE_INTEGER;
  const cursor = ranged ? '+cursor' : 'cursor';
  const statement = store.db.prepare(`SELECT cursor,at,coefficients FROM coefficient_events WHERE generation=?
    AND ${cursor}>? AND ${cursor}<=? AND at>=? AND at<=? ORDER BY ${cursor} LIMIT ?`);
  const maximum = limit ?? Number.MAX_SAFE_INTEGER;
  let supplied=0;
  for(const range of ranges(store, coverage.generation, Math.min(throughCursor, coverage.cursor))) {
    if(supplied>=maximum)break;
    if(range.through_cursor<=afterCursor)continue;
    for(const row of statement.iterate(range.source_generation,Math.max(afterCursor,range.after_cursor),range.through_cursor,from,to,maximum-supplied)) {
      const coefficients=JSON.parse(row.coefficients);if(!validValues(coefficients))throw failure();
      supplied++;yield{cursor:row.cursor,at:row.at,coefficients};
    }
  }
}
export function readCoefficientEvents(store, options) { return [...coefficientEvents(store, options)]; }
function eventBefore(store, coverage, at) {
  const query=store.db.prepare(`SELECT cursor,at,coefficients FROM coefficient_events
    WHERE generation=? AND cursor>? AND cursor<=? AND at<? ORDER BY at DESC,cursor DESC LIMIT 1`);
  const row=ranges(store,coverage.generation,coverage.cursor).map(range=>query.get(range.source_generation,range.after_cursor,range.through_cursor,at))
    .filter(Boolean).sort((a,b)=>b.cursor-a.cursor)[0];
  if(!row)return null;
  const coefficients=JSON.parse(row.coefficients);if(!validValues(coefficients))throw failure();
  return {...row,coefficients};
}
export function coefficientProjectionAt(store, { input, epoch = epochOf(store, input), generation, cursor = 0, checkpoint } = {}) {
  const coverage = readCoefficientCoverage(store, { input, epoch, generation });
  let projection = emptyCoefficientProjection();
  if (coverage) {
    const statement = store.db.prepare('SELECT cursor,at,coefficients,projection FROM coefficient_events WHERE generation=? AND cursor>? AND cursor<=? ORDER BY cursor DESC LIMIT 1');
    const row = ranges(store, coverage.generation, cursor).map(range => statement.get(range.source_generation, range.after_cursor, range.through_cursor))
      .filter(Boolean).sort((a,b) => b.cursor-a.cursor)[0];
    if (row) projection = eventProjection(row);
    if (cursor === coverage.cursor) projection = JSON.parse(store.db.prepare('SELECT projection FROM coefficient_generations WHERE id=?').get(coverage.generation).projection);
  }
  projection.cursor = cursor;
  if (cursor) {
    const latest = learningPrefixRanges(store.db, input, epoch, cursor).map(range => store.db.prepare(`SELECT at FROM learning_journal_entries INDEXED BY learning_entries_epoch_time
      WHERE epoch=? AND input=? AND id>? AND id<=? ORDER BY at DESC LIMIT 1`).get(range.sourceEpoch,input,range.after,range.through)?.at).filter(Number.isFinite);
    projection.at = latest.length ? Math.max(...latest) : projection.at;
  }
  // Current fixture seeds and a fresh stream have no earlier recorded boundary.
  // Initial evidence is established by the first actual ordered application.
  return projection;
}
export function createCoefficientGeneration(store, input, { epoch = epochOf(store, input), fireplaceRevision = 0, sensorRevision = 0,
  selection = selectionOf(store), prefixCursor = 0, sourceGeneration, projection } = {}) {
  const generation = randomUUID(), parent = sourceGeneration ?? readCoefficientCoverage(store, { input })?.generation;
  projection ??= coefficientProjectionAt(store, { input, generation: parent, cursor: prefixCursor });
  if(!validProjection(projection)||projection.cursor!==prefixCursor
    ||![fireplaceRevision,sensorRevision,prefixCursor].every(value=>Number.isSafeInteger(value)&&value>=0)
    ||![input,epoch,selection].every(value=>typeof value==='string'&&value.length>0))throw failure();
  store.db.prepare(`INSERT INTO coefficient_generations(id,input,epoch,fireplace_revision,sensor_revision,history_selection,cursor,through_at,projection)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(generation,input,epoch,fireplaceRevision,sensorRevision,selection,prefixCursor,projection.at,JSON.stringify(projection));
  if (parent && prefixCursor) for (const range of ranges(store,parent,prefixCursor)) {
    const first=store.db.prepare('SELECT cursor FROM coefficient_events WHERE generation=? AND cursor>? AND cursor<=? ORDER BY cursor LIMIT 1')
      .get(range.source_generation,range.after_cursor,range.through_cursor)?.cursor;
    const last=first===undefined?null:store.db.prepare('SELECT cursor FROM coefficient_events WHERE generation=? AND cursor>? AND cursor<=? ORDER BY cursor DESC LIMIT 1')
      .get(range.source_generation,range.after_cursor,range.through_cursor).cursor;
    if(first!==undefined)store.db.prepare('INSERT INTO coefficient_segments VALUES(?,?,?,?)').run(generation,range.source_generation,first-1,last);
  }
  return generation;
}
export function appendCoefficientEvents(store, generation, { events = [], projection, cursor = projection?.cursor, throughAt = projection?.at } = {}) {
  const row = store.db.prepare('SELECT * FROM coefficient_generations WHERE id=?').get(generation);
  if (!row || !validProjection(projection) || !Number.isSafeInteger(cursor) || cursor < 0
    ||projection.cursor!==cursor||projection.at!==throughAt) throw failure();
  const insert = store.db.prepare('INSERT INTO coefficient_events VALUES(?,?,?,?,?) ON CONFLICT(generation,cursor) DO NOTHING');
  for (const event of events) {
    if (event.cursor > cursor || !Number.isFinite(event.at)) throw failure();
    const eventProjection = event.projection;
    if(!validProjection(eventProjection)||eventProjection.cursor!==event.cursor||eventProjection.at!==event.at
      ||!validValues(event.coefficients)||JSON.stringify(eventProjection.coefficients)!==JSON.stringify(event.coefficients))throw failure();
    const payload = JSON.stringify(event.coefficients),packed=JSON.stringify(packedProjection(eventProjection)),
      existing = store.db.prepare('SELECT at,coefficients,projection FROM coefficient_events WHERE generation=? AND cursor=?').get(generation,event.cursor);
    if (existing && (existing.at !== event.at || existing.coefficients !== payload || existing.projection !== packed)) throw failure();
    insert.run(generation,event.cursor,event.at,payload,packed);
  }
  if (cursor >= row.cursor) store.db.prepare('UPDATE coefficient_generations SET cursor=?,through_at=?,projection=? WHERE id=?')
    .run(cursor,throughAt,JSON.stringify(projection),generation);
}
export function publishCoefficientGeneration(store, input, generation, checkpoint) {
  const coverage = readCoefficientCoverage(store,{input,epoch:epochOf(store,input),generation});
  if (!coverage || coverage.selection !== selectionOf(store) || coverage.cursor !== (checkpoint?.journalCursor ?? 0)
    || checkpoint && (coverage.fireplaceRevision !== (checkpoint.fireplaceRevision ?? 0) || coverage.sensorRevision !== (checkpoint.sensorRevision ?? 0))) throw failure();
  const previous=store.db.prepare('SELECT generation FROM coefficient_selection WHERE input=?').get(input)?.generation;
  store.db.prepare('INSERT INTO coefficient_selection VALUES(?,?) ON CONFLICT(input) DO UPDATE SET generation=excluded.generation').run(input,generation);
  store.db.prepare('UPDATE coefficient_generations SET retired=0 WHERE id=?').run(generation);
  if(previous&&previous!==generation)store.db.prepare('UPDATE coefficient_generations SET retired=1 WHERE id=?').run(previous);
}
export function persistCoefficientBatch(store, input, batch) {
  if (!batch) return;
  const epoch = epochOf(store,input), selection = selectionOf(store);
  if (batch.epoch !== epoch || batch.selection !== selection) throw failure();
  let coverage = readCoefficientCoverage(store,{input,epoch});
  if(batch.coefficientGeneration){
    const staged=readCoefficientCoverage(store,{input,epoch,generation:batch.coefficientGeneration});
    if((coverage?.generation??null)!==(batch.baseGeneration??null)|| (coverage?.cursor??0)!==batch.prefixCursor
      ||!staged||staged.cursor!==batch.cursor||staged.fireplaceRevision!==batch.fireplaceRevision
      ||staged.sensorRevision!==batch.sensorRevision||staged.selection!==selection)throw failure();
    publishCoefficientGeneration(store,input,staged.generation,{journalCursor:batch.cursor,
      fireplaceRevision:batch.fireplaceRevision,sensorRevision:batch.sensorRevision});
    cleanupRetiredCoefficientGenerations(store);return;
  }
  let publish=false;
  if (!coverage || coverage.fireplaceRevision !== batch.fireplaceRevision || coverage.sensorRevision !== batch.sensorRevision) {
    const reuse=coverage && batch.baseCursor>0 && batch.reusedPrefixCursor===batch.baseCursor
      && coverage.selection===selection && coverage.cursor>=batch.baseCursor && coverage.sensorRevision===batch.sensorRevision
      && unchangedFireplacePrefix(store,input,{fromRevision:coverage.fireplaceRevision,toRevision:batch.fireplaceRevision,cursor:batch.baseCursor,epoch});
    if (coverage && batch.baseCursor && !reuse) throw failure();
    const generation = createCoefficientGeneration(store,input,{epoch,selection,fireplaceRevision:batch.fireplaceRevision,sensorRevision:batch.sensorRevision,
      ...(reuse?{prefixCursor:batch.baseCursor,sourceGeneration:coverage.generation}: {})});
    coverage = readCoefficientCoverage(store,{input,epoch,generation});
    publish=true;
  }
  appendCoefficientEvents(store,coverage.generation,batch);
  if(publish)publishCoefficientGeneration(store,input,coverage.generation,{journalCursor:batch.cursor,
    fireplaceRevision:batch.fireplaceRevision,sensorRevision:batch.sensorRevision});
  cleanupRetiredCoefficientGenerations(store);
}
export function cleanupRetiredCoefficientGenerations(store,{limit=128}={}) {
  const candidate=store.db.prepare(`SELECT g.id FROM coefficient_generations g WHERE g.retired=1
    AND NOT EXISTS(SELECT 1 FROM coefficient_selection s WHERE s.generation=g.id)
    AND NOT EXISTS(SELECT 1 FROM coefficient_segments p WHERE p.source_generation=g.id) ORDER BY g.id LIMIT 1`).get();
  return candidate ? discardCoefficientGeneration(store,candidate.id,{limit}) : {removed:0,complete:true};
}
/** Delete only an explicitly retired candidate, never a selected interpretation
 * or a source still referenced by a selected/staged unaffected prefix. Callers
 * own the candidate's worker lifetime and yield between bounded batches. */
export function discardCoefficientGeneration(store,generation,{limit=128}={}) {
  if(!Number.isSafeInteger(limit)||limit<1||limit>1024)throw new TypeError('Invalid coefficient cleanup batch');
  if(store.db.prepare('SELECT 1 FROM coefficient_selection WHERE generation=?').get(generation)
    ||store.db.prepare('SELECT 1 FROM coefficient_segments WHERE source_generation=? LIMIT 1').get(generation))return{removed:0,complete:false};
  const rows=store.db.prepare('SELECT cursor FROM coefficient_events WHERE generation=? ORDER BY cursor LIMIT ?').all(generation,limit);
  const remove=store.db.prepare('DELETE FROM coefficient_events WHERE generation=? AND cursor=?');
  for(const row of rows)remove.run(generation,row.cursor);
  const remaining=store.db.prepare('SELECT 1 FROM coefficient_events WHERE generation=? LIMIT 1').get(generation);
  if(!remaining){store.db.prepare('DELETE FROM coefficient_segments WHERE generation=?').run(generation);store.db.prepare('DELETE FROM coefficient_generations WHERE id=?').run(generation);}
  return{removed:rows.length,complete:!remaining};
}

/** Direct indexed projection of the selected, committed model interpretation. */
export function readCoefficientHistory({ store, range, now, input, envelopes }) {
  const selected = Object.keys(MODEL_COEFFICIENT_INFO).filter(key => envelopes[key]);
  const stats = { records:0,replayedRecords:0,invalidRecords:0,basis:'committed-coefficient-history',state:'current' };
  if (!selected.length) return stats;
  const primary = input === 'offline' ? 'history' : input;
  // An explicit selected epoch lets SQLite seek each UNION branch without
  // materializing the entire journal through its correlated selection view.
  const first = store.db.prepare('SELECT id,at FROM learning_journal_all WHERE epoch=? AND input=? AND id>0 ORDER BY id LIMIT 1')
    .get(epochOf(store,primary),primary);
  const end = Math.min(now,range.to);
  const streams = ['providers','mqtt'].includes(primary) && (!first || first.at > range.from)
    ? [{input:'history',end:Math.min(end,first?first.at-1:end)},...(first?[{input:primary,from:first.at,end}]:[])] : [{input:primary,end}];
  const sources = {history:'Imported history',mqtt:'Recorded MQTT inputs',providers:'Recorded provider inputs',simulated:'Simulation'};
  for (const stream of streams) {
    const coverage = readCoefficientCoverage(store,{input:stream.input});
    if (!coverage) { if (store.db.prepare('SELECT id FROM learning_journal_all WHERE epoch=? AND input=? AND id>0 ORDER BY id LIMIT 1')
      .get(epochOf(store,stream.input),stream.input)) stats.state='missing'; continue; }
    const next=store.db.prepare('SELECT id,at FROM learning_journal_all WHERE epoch=? AND input=? AND id>? ORDER BY id LIMIT 1')
      .get(coverage.epoch,stream.input,coverage.cursor);
    const through=next?Math.min(stream.end,Math.max(coverage.throughAt??-Infinity,next.at)-1):stream.end;
    if(next&&stats.state!=='missing')stats.state='behind';
    const from = Math.max(range.from,stream.from??range.from);
    if (through < from) continue;
    const earlier = eventBefore(store,coverage,from);
    let previous = earlier?.coefficients ?? null, started=false;
    const add = (at,values) => { for (const key of selected) { const value=values?.[key];envelopes[key].add(at,value?.value??null,value?{
      modelCoefficient:true,coefficientStatus:value.status,modelUpdatedAt:value.updatedAt,inputSource:sources[stream.input],algorithmVersion:LEARNING_ALGORITHM}:undefined); } };
    const emit=row=>{stats.records++;if(row.coefficients===null)stats.invalidRecords++;if(!started&&row.at>from)add(from,previous);if(row.at>from)add(row.at-1,previous);add(row.at,row.coefficients);previous=row.coefficients;started=true;};
    // Keep one native cursor per selected source range. Reopening a time seek
    // for each small page would repeatedly sort the same long chart selection.
    let pending;
    for(const row of coefficientEvents(store,{input:stream.input,from,to:through})) {
      if(pending&&pending.at!==row.at)emit(pending);pending=row;
    }
    if(pending)emit(pending);
    if(previous){if(!started)add(from,previous);add(through,previous);}
    if(through<stream.end)add(through+1,null);
  }
  return stats;
}
