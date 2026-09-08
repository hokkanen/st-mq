import { HISTORY_AXES, HISTORY_GROUPS, SIGNAL_INFO } from '../src/domain/history-series.js';

export function populateHistoryAxes(select) {
  const chosen = select.value || 'power';
  select.replaceChildren();
  for (const name of HISTORY_GROUPS) {
    const axes = HISTORY_AXES.filter(axis => axis.group === name);
    if (!axes.length) continue;
    const kinds = new Set(axes.map(axis => axis.kind));
    const group = document.createElement('optgroup');
    group.label = `${name}${kinds.size === 1 ? ` · ${[...kinds][0]}` : ''}`;
    for (const axis of axes) {
      const option = document.createElement('option'); option.value = axis.key; option.textContent = axis.label;
      group.append(option);
    }
    select.append(group);
  }
  select.value = chosen;
}

export function durationLabel(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'Collecting';
  if (ms < 60_000) return `${Math.round(ms/1000)} s`;
  if (ms < 3_600_000) return `${Number((ms/60_000).toFixed(1))} min`;
  return `${Number((ms/3_600_000).toFixed(1))} h`;
}
const number = value => Number.isFinite(value) ? new Intl.NumberFormat('en-GB',{maximumSignificantDigits:3}).format(value) : '—';
const readable = value => String(value ?? '').replaceAll('_',' ');

export function recordingRows(status = {}) {
  const known = new Map(Object.entries(SIGNAL_INFO).filter(([,info])=>info.role!=='Audit only').map(([signal,info]) => [signal,{signal,...info}]));
  const result=[],seen=new Set();
  for (const parameter of status.parameters ?? []) {
    const signals = parameter.grouped && /^(ev1|property)_energy$/.test(parameter.signal)
      ? [1,2,3].map(phase=>`${parameter.signal}_l${phase}`) : [parameter.signal];
    for (const signal of signals) {
      result.push({...(known.get(signal) ?? {signal,label:readable(signal),group:'Other',role:'History only'}),...parameter,signal});
      seen.add(signal);
    }
  }
  for(const [signal,row] of known)if(!seen.has(signal))result.push(row);
  return result.sort((a,b) => {
    const order = group => {const i=HISTORY_GROUPS.indexOf(group);return i<0?HISTORY_GROUPS.length:i;};
    return order(a.group)-order(b.group)||a.label.localeCompare(b.label)||String(a.source??'').localeCompare(String(b.source??''));
  });
}

export function renderRecording(status, root) {
  if (!root) return;
  const recording=status?.recording ?? {}, summary=document.createElement('p');
  summary.className='muted';
  summary.textContent=`${recording.measurementHours ? `${number(recording.projectedAnnualBytes/1e9)} GB/year projected` : 'Collecting growth measurements'} · ${number((recording.annualBudgetBytes ?? 1e10)/1e9)} GB/year rolling target · ${durationLabel(recording.maxIntervalMs ?? 300000)} maximum interval. ${number((recording.measuredDatabaseBytes ?? 0)/1e6)} MB database.`;
  const description=document.createElement('p');description.className='muted';
  description.textContent='Intervals below are achieved averages, not fixed schedules. All recorded measurements share a normalized accuracy target. Model role does not affect recording priority. Forecasts are saved when their content changes; source outages remain missing.';
  const table=document.createElement('table');table.className='recording-table';
  const head=document.createElement('thead'),headers=document.createElement('tr');
  for(const name of ['Parameter / model role','Average · 1 h / 24 h / 7 d','Change threshold','Normalized error · 24 h','Status']) {
    const cell=document.createElement('th');cell.scope='col';cell.textContent=name;headers.append(cell);
  }
  head.append(headers);table.append(head);
  const body=document.createElement('tbody');let previousGroup;
  for(const row of recordingRows(recording)) {
    if(row.group!==previousGroup) {const tr=document.createElement('tr'),cell=document.createElement('th');cell.colSpan=5;cell.scope='colgroup';cell.textContent=row.group;tr.className='recording-group';tr.append(cell);body.append(tr);previousGroup=row.group;}
    const tr=document.createElement('tr'),title=document.createElement('th');title.scope='row';title.textContent=row.label;
    const role=document.createElement('small');role.textContent=`${row.role}${row.source?` · ${readable(row.source)}`:''}`;title.append(role);tr.append(title);
    for(const text of [
      [row.hour,row.day,row.week].map(period=>durationLabel(period?.averageIntervalMs)).join(' / '),
      Number.isFinite(row.threshold)?row.threshold<1e-9?'Any measurable change':`${number(row.threshold)} ${row.thresholdUnit ?? row.unit ?? ''}${row.grouped?' (phase group)':''}`:'Event / collecting',
      Number.isFinite(row.day?.normalizedRmsError)?`${number(row.day.normalizedRmsError*100)}%`:'—',
      row.status?readable(row.status):'Waiting for source',
    ]) {const cell=document.createElement('td');cell.textContent=text;tr.append(cell);}
    if (Number.isFinite(row.lastSourceTime)) {
      const detail=document.createElement('small');
      detail.textContent=`Source age ${durationLabel(Math.max(1000,(status?.now ?? Date.now())-row.lastSourceTime))} · ${number((row.day?.estimatedBytes ?? 0)/1000)} kB / 24 h`;
      tr.lastChild.append(detail);
    }
    body.append(tr);
  }
  table.append(body);
  const wrap=document.createElement('div');wrap.className='table-scroll';wrap.append(table);
  root.replaceChildren(summary,description,wrap);
}

export function renderEnergyAudits(rows, root) {
  if(!root)return;
  root.replaceChildren();
  const note=document.createElement('p');note.className='muted';
  note.textContent='The latest check for each cumulative meter compares estimated energy with the meter increase between two readings. These checks never change history, calibrate estimates, train the house model or affect recording thresholds.';root.append(note);
  if(!rows?.length) {const p=document.createElement('p');p.textContent='Waiting for fresh accumulated-kWh updates.';root.append(p);return;}
  const table=document.createElement('table');table.className='recording-table';
  const date = value => new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Helsinki',dateStyle:'short',timeStyle:'short'}).format(value);
  for(const item of rows) {
    const row=document.createElement('tr'),title=document.createElement('th');title.scope='row';
    title.textContent=item.signal?.startsWith('property')?'Property':'Charger';
    const meter=document.createElement('small');meter.textContent=item.signal?.startsWith('property')?'Cumulative import meter':'Lifetime energy meter';title.append(meter);
    const when=document.createElement('small');when.textContent=`Meter reading: ${date(item.sourceTime)}`;title.append(when);row.append(title);
    const comparison=item.comparison,cell=document.createElement('td');
    cell.textContent=comparison ? `${number(comparison.differenceKwh)} kWh difference · ${number(comparison.differencePercent)}% · estimated minus meter`
      : 'Comparison pending: two valid counters and matching energy coverage needed';
    if (comparison) {
      const detail=document.createElement('small');detail.textContent=`${number(comparison.estimatedKwh)} kWh estimated / ${number(comparison.meteredKwh)} kWh meter${comparison.edgeEstimated?' · interval edges prorated':''}`;cell.append(detail);
      const period=document.createElement('small');period.textContent=`Compared: ${date(comparison.start)} – ${date(comparison.end)}`;cell.append(period);
    }
    row.append(cell);table.append(row);
  }
  const wrap=document.createElement('div');wrap.className='table-scroll';wrap.append(table);root.append(wrap);
}
