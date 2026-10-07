import { recordedEnergyGroups, recordedEnergyStart } from './chart-energy.js';
import { H66_MAX_AGE_MS } from '../domain/reading-freshness.js';
import { auxiliaryPowerFromOutput } from '../domain/telemetry.js';
import { alignEaseePowerSnapshots } from './chart-phase-snapshots.js';
import { createVoltageReader } from '../storage/voltage.js';
import { currentPowerKw, voltageSegments } from './chart-voltage.js';

const HOUR = 3600000;
const scope = input => input === 'simulated' ? "source='simulation'" : "source<>'simulation'";

function* intervalPoints(intervals, range, now) {
  for (const row of intervals) {
    const start = Math.max(range.from,row.start), end = Math.min(range.to,now,row.end);
    if (end <= start) continue;
    yield { x: start, y: row.value };
    if (end > start + 1) yield { x: end - 1, y: row.value };
    yield { x: end, y: null };
  }
}

function* energyIntervals(store, options, prefix) {
  if (prefix === 'ev1') {
    const cutoff = options.queryContext?.energyStart(prefix) ?? recordedEnergyStart(store,prefix,options.input,options.now);
    yield* currentIntervals(store,{ ...options,to:Math.min(options.to,cutoff) });
  }
  const groups = options.queryContext ? options.queryContext.energyGroups(undefined, prefix)
    : recordedEnergyGroups(store,{ ...options, prefix });
  for (const row of groups) {
    yield { start: row.start, end: row.end, value: !row.conflict && row.values.every(Number.isFinite)
      ? row.values.reduce((a,b) => a+b,0) * HOUR / (row.end-row.start) : null };
  }
}

function* currentIntervals(store,{ from,to,now,input,readValue,voltageReader }) {
  if (to <= from) return;
  const rows = store.db.prepare(`SELECT o.* FROM active_observations o LEFT JOIN active_imports i ON i.id=o.import_id
    WHERE o.signal IN ('ev1_current_l1','ev1_current_l2','ev1_current_l3')
    AND o.source_time>=? AND o.source_time<? AND o.received_at<=?
    AND ${input === 'simulated' ? "o.source='simulation'" : "o.source<>'simulation'"}
    AND (o.import_id IS NULL OR i.status='complete' AND i.completed_at<=?) ORDER BY o.source_time,o.id`)
    .iterate(from-30*60000,Math.min(to,now+1),now,now);
  let at = null, groups = new Map(), previous = null;
  function* converted(interval) {
    if (!interval) return;
    for (const segment of voltageSegments(voltageReader, interval.start, interval.end, { allowFuture: interval.imported }))
      yield { start: segment.start, end: segment.end, value: currentPowerKw(interval.values, segment.estimate) };
  }
  const finish = nextAt => {
    const winner = [...groups.values()].sort((a,b) => b.priority-a.priority || b.id-a.id)[0];
    const point = { at, values: winner?.values, imported: winner?.imported };
    const interval = previous ? { ...previous, start:previous.at,end:Math.min(to,point.at-previous.at<=30*60000?point.at:previous.at+1) } : null;
    previous=point; groups=new Map(); at=nextAt; return interval;
  };
  for (const row of alignEaseePowerSnapshots(rows,store.db,now)) {
    if (at !== null && row.source_time!==at) yield* converted(finish(row.source_time));
    at=row.source_time;
    const key=JSON.stringify([row.source,row.device,row.import_id,row.row_number??row.received_at]);
    if (!groups.has(key))groups.set(key,{values:[null,null,null],imported:row.import_id!=null,priority:row.import_id===null?1:0,id:row.id});
    let flags;try{flags=JSON.parse(row.quality);}catch{flags=['missing'];}
    const group=groups.get(key);group.id=row.id;
    group.values[Number(row.signal.at(-1))-1]=!Array.isArray(flags)||flags.includes('ev_exceeds_property_current')
      ||!row.alignedPowerSnapshot&&flags.includes('asynchronous_snapshot')?null:readValue(row,flags);
  }
  if(at!==null)yield* converted(finish(null));
  if(previous)yield* converted({...previous,start:previous.at,end:Math.min(to,previous.at+1)});
}

function* auxiliaryIntervals(store, { from, to, now, input, readValue }) {
  const rows = store.db.prepare(`SELECT signal,value,unit,quality,raw,source,source_time,id FROM active_observations AS observations
    WHERE signal IN ('auxiliary_power','auxiliary_output') AND source_time>=? AND source_time<?
      AND received_at<=? AND import_id IS NULL AND ${scope(input)} ORDER BY source_time,id`)
    .iterate(from-H66_MAX_AGE_MS,Math.min(to,now+1),now);
  let previous = null;
  const finish = end => ({ start: previous.at, end: Math.min(end,previous.at+H66_MAX_AGE_MS), value: previous.value });
  for (const row of rows) {
    let flags; try { flags = JSON.parse(row.quality); } catch { flags = ['missing']; }
    let value = readValue(row,Array.isArray(flags)?flags:['missing']);
    if (row.signal === 'auxiliary_output') {
      let raw; try { raw = JSON.parse(row.raw); } catch { /* No native power basis. */ }
      value = row.source === 'husdata-h66' && raw?.verified === true && raw?.usableForControl !== false
        && Number.isFinite(raw?.ratedPowerKw) && raw.ratedPowerKw > 0
        ? auxiliaryPowerFromOutput(value,raw.ratedPowerKw)?.kw ?? null : null;
    }
    if (previous && row.source_time > previous.at) yield finish(row.source_time);
    if (!previous || row.source_time !== previous.at || row.signal === 'auxiliary_power' || previous.signal !== 'auxiliary_power')
      previous = { at: row.source_time, value, signal: row.signal };
  }
  if (previous) yield finish(Math.min(to,now));
}

/** Stream original, duration-qualified component curves. Individual component
 * envelopes already retain their own extrema. The four multi-component subsets
 * add only their finite min/max times; gap topology belongs to the original
 * component projection. Memory is bounded by display buckets and three heads. */
export function powerExtremaTimes({ store, range, now, input, points, readValue, voltageReader, queryContext }) {
  voltageReader ??= createVoltageReader(store, { input, from: range.from - 30*60000, to: Math.min(range.to, now), now });
  const options = { from: range.from, to: range.to, now, input, readValue, voltageReader, queryContext };
  const streams = [auxiliaryIntervals(store,options), energyIntervals(store,options,'ev1'), energyIntervals(store,options,'ev2')]
    .map(rows => intervalPoints(rows,range,now)[Symbol.iterator]());
  const values = [null,null,null], width = (range.to-range.from)/points;
  const subsets = [3,5,6,7].map(mask => ({ mask,buckets:new Map() }));
  try {
    const heads = streams.map(iterator => iterator.next());
    while (heads.some(head => !head.done)) {
      const at = Math.min(...heads.filter(head => !head.done).map(head => head.value.x));
      for (let i=0;i<heads.length;i++) while (!heads[i].done && heads[i].value.x===at) {
        values[i]=heads[i].value.y; heads[i]=streams[i].next();
      }
      for (const subset of subsets) {
        const components=values.filter((_,index) => subset.mask & (1<<index));
        if (!components.every(Number.isFinite)) continue;
        const value=components.reduce((a,b)=>a+b,0),point={at,value};
        const index=Math.min(points-1,Math.floor((at-range.from)/width));
        const bucket=subset.buckets.get(index);
        if(!bucket)subset.buckets.set(index,{min:point,max:point});
        else { if(value<bucket.min.value)bucket.min=point;if(value>bucket.max.value)bucket.max=point; }
      }
    }
  } finally { for (const iterator of streams) try { iterator.return?.(); } catch { /* Preserve primary failure. */ } }
  return [...new Set(subsets.flatMap(row => [...row.buckets.values()].flatMap(bucket => [bucket.min.at,bucket.max.at])))];
}
