import { recordedEnergyGroups } from '../storage/energy-history.js';
import { createVoltageReader } from '../storage/voltage.js';
import { voltageMetadata, voltageSegments } from './chart-voltage.js';
export { recordedEnergyStart, recordedEnergyGroups } from '../storage/energy-history.js';

const HOUR = 3_600_000;
const totalOnly = prefix => prefix === 'caravan';

/** Original phase or total-energy intervals supply every history range. Drawing points
 * may be reduced in memory, but never determine energy or tariff comparisons. */
export function addRecordedEnergy({store,range,now,input,envelopes,timing,voltageReader}) {
  voltageReader ??= createVoltageReader(store, { input, from: range.from, to: Math.min(range.to, now), now });
  const stats = {rows:0,intervals:0};
  const lastEnd = new Map();
  const project = (name,start,end,value,metadata) => {
    const line = envelopes[name]; if (!line) return;
    const a = Math.max(start,range.from), b = Math.min(end,range.to,now);
    if (b <= a) return;
    if (lastEnd.has(name) && a > lastEnd.get(name)) { line.add(lastEnd.get(name),null); line.add(a-1,null); }
    line.add(a,value,metadata); line.add(b-1,value,metadata);
    lastEnd.set(name,Math.max(lastEnd.get(name) ?? -Infinity,b));
  };
  const accept = group => {
    const {start,end,prefix} = group, values = group.conflict ? group.values.map(() => null) : group.values;
    const duration = end-start;
    if (!Number.isFinite(start) || !Number.isFinite(end) || duration <= 0
      || start >= range.to || end <= range.from) return;
    stats.intervals++;
    const complete = values.length === (totalOnly(prefix)?1:3) && values.every(Number.isFinite);
    const total = complete ? values.reduce((sum,value)=>sum+value,0) : null;
    const metadata = {basis:'estimated',intervalStart:start,intervalEnd:end,source:group.source,fromEnergy:true,
      ...(group.source === 'easee' ? { transport: group.transport ?? null } : {}),
      ...(group.pending ? { pending: true } : {}),
      ...(group.conflict ? { quality: ['conflicting-logical-energy'] } : {})};
    if (prefix==='caravan') {
      // Measured caravan electricity stays an independent history series. It
      // never becomes property demand, charger timing evidence or heating input.
      const caravanMetadata = {...metadata,basis:group.basis??'meter-counter-delta',learningRole:'history-only'};
      project('caravan_power',start,end,total === null ? null : total*HOUR/duration,caravanMetadata);
      if (end >= range.from && end <= Math.min(range.to, now)) envelopes.caravan_energy?.add(end,total,
        caravanMetadata);
      return;
    }
    const phaseMetadata = { ...metadata, ...(group.basis ? { basis: group.basis } : {}) };
    const totalMetadata = { ...metadata, ...(group.basis === 'native-meter-counter-phase-allocation'
      ? { basis: 'native-meter-counter-delta' } : {}) };
    project(prefix === 'ev1' ? 'charger_power' : prefix === 'ev2' ? 'charger2_power' : 'property_power',
      start,end,total === null ? null : total*HOUR/duration,totalMetadata);
    if ([1,2,3].some(phase => envelopes[`${prefix}_current_l${phase}`]))
      for (const segment of voltageSegments(voltageReader,Math.max(start,range.from),Math.min(end,range.to,now)))
        for (let phase=0;phase<3;phase++) {
          const value = values[phase] ?? null, power = value === null ? null : value*HOUR/duration;
          const voltage = segment.estimate.voltageV[phase];
          project(`${prefix}_current_l${phase+1}`,segment.start,segment.end,
            power === null || !Number.isFinite(voltage) || voltage <= 0 ? null : power*1000/voltage,
            {...phaseMetadata,...voltageMetadata(segment.estimate,phase),equivalentCurrent:true});
        }
    for (let phase=0;phase<3;phase++) {
      const value = values[phase] ?? null;
      const energyLine = envelopes[`${prefix}_energy_l${phase+1}`];
      if (energyLine && end >= range.from && end <= Math.min(range.to,now)) energyLine.add(end,value,phaseMetadata);
    }
    if (['ev1','ev2'].includes(prefix) && complete) timing.addEnergy(prefix === 'ev1' ? 'charger1' : 'charger2',start,end,total,
      { key: input === 'simulated' ? 'simulated' : 'recorded', energyBasis: 'recorded-intervals' });
  };
  for (const group of recordedEnergyGroups(store,{from:range.from,to:range.to,now,input},stats)) accept(group);
  // Finish only after all adjacent intervals are projected, so a shared edge
  // does not acquire a spurious missing marker.
  for (const [name,end] of lastEnd) envelopes[name]?.add(end,null);
  return stats;
}
