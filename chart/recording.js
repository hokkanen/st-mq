import { HISTORY_AXES, HISTORY_GROUPS, RIGHT_AXIS_SIGNALS, SIGNAL_INFO } from '../src/domain/history-series.js';

// Frequent chart choices first; equipment diagnostics remain together at the end.
const leftAxisGroups = ['Electricity', 'Heating', 'Hot water', 'Ground loop', 'Control', 'Weather',
  'Learning', 'Model coefficients', 'Model inputs', 'Equipment states', 'Settings', 'Runtime counters', 'Meter checks'];
const leftAxes = HISTORY_AXES.filter(axis => !RIGHT_AXIS_SIGNALS.includes(axis.key));

export function populateHistoryAxes(select) {
  const chosen = leftAxes.some(axis => axis.key === select.value) ? select.value : 'power';
  select.replaceChildren();
  for (const name of leftAxisGroups) {
    const axes = leftAxes.filter(axis => axis.group === name);
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
    if(parameter.signal==='heat_pump_power')continue;
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
  description.textContent='Devices can be polled or streamed more often than values are recorded. Each new reading is compared with the last saved value. A shared learned tolerance adjusts the change thresholds toward the rolling storage target; fresh readings are recorded by the maximum interval even when unchanged. Equipment-state and quality changes are recorded immediately. Failed requests and old source timestamps are distinguished from fresh, unchanged readings.';
  const note=document.createElement('p');note.className='muted';
  note.textContent='These are achieved average intervals, not fixed schedules. Included measurements receive the same normalized accuracy treatment. Recording a parameter does not imply that it is used to fit the house model.';
  const table=document.createElement('table');table.className='recording-table';
  const head=document.createElement('thead'),headers=document.createElement('tr');
  for(const name of ['Parameter / source','Average · 1 h / 24 h / 7 d','Change threshold','Normalized error · 24 h','Status']) {
    const cell=document.createElement('th');cell.scope='col';cell.textContent=name;headers.append(cell);
  }
  head.append(headers);table.append(head);
  const body=document.createElement('tbody');let previousGroup;
  for(const row of recordingRows(recording)) {
    if(row.group!==previousGroup) {const tr=document.createElement('tr'),cell=document.createElement('th');cell.colSpan=5;cell.scope='colgroup';cell.textContent=row.group;tr.className='recording-group';tr.append(cell);body.append(tr);previousGroup=row.group;}
    const tr=document.createElement('tr'),title=document.createElement('th');title.scope='row';title.textContent=row.label;
    if(row.source) {const source=document.createElement('small');source.textContent=readable(row.source);title.append(source);}tr.append(title);
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
  root.replaceChildren(summary,description,note,wrap);
}

const inventoryDateFormat=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Helsinki',dateStyle:'medium',timeStyle:'short'});
const inventoryDayFormat=new Intl.DateTimeFormat('en-GB',{timeZone:'UTC',dateStyle:'medium'});
const dateLabel=at=>Number.isFinite(at)?inventoryDateFormat.format(at):null;
const integerLabel=value=>Number.isSafeInteger(value)&&value>=0?new Intl.NumberFormat('en-GB').format(value):'Unknown';
const retentionLabels={history:'Retained history',current:'Current state · overwritten',derived:'Stored calculations',rolling:'Rolling records',mixed:'History and current state'};
const retentionDescriptions={
  history:'Records are retained as history.',current:'Each update replaces the current entry; this is not a sequence of historical samples.',
  derived:'Calculated values are retained as records.',rolling:'Only a rolling window of these records is retained.',
  mixed:'This dataset contains both retained history and entries that are updated in place.',
};
const singularCountLabels={records:'record',fetches:'fetch',versions:'version',periods:'period','current entries':'current entry',summaries:'summary',cycles:'cycle','hourly buckets':'hourly bucket',imports:'import',spans:'span'};
const inventoryCount=item=>{
  const plural=item?.countLabel??'records',label=item?.count===1?singularCountLabels[plural]??plural:plural;
  return `${integerLabel(item?.count)} ${label}`;
};

export function inventoryItemSummary(item) {
  return `${item?.status==='empty'?'No records yet':inventoryCount(item)} · ${retentionLabels[item?.retention]??'Recorded data'}`;
}

export function inventoryDateSpan(item) {
  const dateOnly=item?.datePrecision==='date';
  const format=at=>dateOnly&&Number.isFinite(at)?inventoryDayFormat.format(at):dateLabel(at);
  const first=format(item?.firstAt),last=format(item?.lastAt);
  if(!first&&!last)return item?.status==='empty'?'No recorded dates yet':'Dates not recorded';
  const dates=first&&last&&first!==last?`${first} – ${last}`:last??first;
  return `${item?.dateBasis??'Recorded dates'}: ${dates} · ${dateOnly?'time not recorded':'Finnish time'}`;
}

/** Re-render the inventory without collapsing the user's chosen sections or
 * losing keyboard focus. Data stays as text, including future dataset labels.
 */
export function renderRecordingOverview(overview,root) {
  if(!root)return;
  const expanded=new Map([...root.querySelectorAll('details[data-overview-key]')].map(details=>[details.dataset.overviewKey,details.open]));
  const focused=document.activeElement;
  const focusedKey=root.contains(focused)?focused.closest('[data-overview-key]')?.dataset.overviewKey:null;
  const nodes=[];
  const intro=document.createElement('p');intro.className='muted';
  intro.textContent=overview.summary??'The database also keeps forecasts, control and learning records, settings, imported history and supporting data. Expand a dataset to see what is stored and when it changes.';
  nodes.push(intro);
  const size=overview.database?.allocatedBytes??overview.database?.bytes;
  if(Number.isFinite(size)) {
    const usage=document.createElement('p');usage.className='recording-overview-size muted';
    usage.textContent=`Allocated database: ${number(size/1e6)} MB${Number.isFinite(overview.database?.totalFileBytes)?` · files on disk: ${number(overview.database.totalFileBytes/1e6)} MB`:''}${Number.isFinite(overview.database?.walBytes)?` · transaction log: ${number(overview.database.walBytes/1e6)} MB`:''}.`;
    nodes.push(usage);
    if(overview.database.description){const description=document.createElement('p');description.className='muted';description.textContent=overview.database.description;nodes.push(description);}
  }
  const accounting=document.createElement('p');accounting.className='muted';accounting.textContent='Dataset counts describe different kinds of records and may overlap; they should not be added together.';nodes.push(accounting);
  for(const group of overview.groups??[]) {
    const details=document.createElement('details');details.className='recording-data-group';details.dataset.overviewKey=`group:${group.id}`;
    const summary=document.createElement('summary');summary.textContent=group.label;details.append(summary);
    if(group.description){const description=document.createElement('p');description.className='muted';description.textContent=group.description;details.append(description);}
    for(const item of group.items??[]) {
      const dataset=document.createElement('details');dataset.className='recording-dataset';dataset.dataset.overviewKey=`item:${group.id}:${item.id}`;
      dataset.dataset.datasetId=item.id;dataset.dataset.retention=item.retention??'';
      const title=document.createElement('summary'),name=document.createElement('span'),state=document.createElement('small');
      name.className='recording-dataset-name';name.textContent=item.label;state.textContent=inventoryItemSummary(item);
      title.append(name,state);dataset.append(title);
      if(item.description){const description=document.createElement('p');description.textContent=item.description;dataset.append(description);}
      const behavior=document.createElement('dl');behavior.className='recording-dataset-facts';
      const fact=(label,value)=>{
        const key=document.createElement('dt'),text=document.createElement('dd');key.textContent=label;text.textContent=String(value);behavior.append(key,text);
      };
      fact('Recorded',inventoryCount(item));
      if(item.writeBehavior)fact('When saved',item.writeBehavior);
      fact('Retention',item.retentionDescription??retentionDescriptions[item.retention]??'Stored in the database.');
      fact('Dates',inventoryDateSpan(item));
      if(Number.isFinite(item.missingCount))fact('Missing values',integerLabel(item.missingCount));
      for(const detail of item.facts??[])fact(detail.label,typeof detail.value==='number'?number(detail.value):detail.value);
      dataset.append(behavior);
      if(item.fields?.length) {
        const label=document.createElement('h4');label.textContent='Stored fields';dataset.append(label);
        const fields=document.createElement('dl');fields.className='recording-dataset-fields';
        for(const field of item.fields) {
          const name=document.createElement('dt'),description=document.createElement('dd');
          name.textContent=field.name;description.textContent=field.description;fields.append(name,description);
        }
        dataset.append(fields);
      }
      dataset.open=expanded.get(dataset.dataset.overviewKey)??false;details.append(dataset);
    }
    details.open=expanded.get(details.dataset.overviewKey)??false;nodes.push(details);
  }
  if(!overview.groups?.length){const empty=document.createElement('p');empty.textContent='No dataset inventory is available yet.';nodes.push(empty);}
  if(overview.accounting?.tables?.length) {
    const details=document.createElement('details');details.className='recording-storage-accounting';details.dataset.overviewKey='accounting';
    const summary=document.createElement('summary');summary.textContent='Storage accounting';details.append(summary);
    const description=document.createElement('p');description.className='muted';
    description.textContent=overview.accounting.description??'Each physical table is counted once below. Charts read original committed records. Point reduction and cached chart responses stay in memory. Database indexes store lookup structures for finding records; they do not store another history series.';details.append(description);
    const table=document.createElement('table'),head=document.createElement('thead'),titles=document.createElement('tr');
    for(const title of ['Database table','Rows']){const cell=document.createElement('th');cell.scope='col';cell.textContent=title;titles.append(cell);}head.append(titles);table.append(head);
    const body=document.createElement('tbody');
    for(const item of overview.accounting.tables) {
      const row=document.createElement('tr'),name=document.createElement('th'),count=document.createElement('td');
      name.scope='row';name.textContent=item.name;count.textContent=integerLabel(item.rows);row.append(name,count);body.append(row);
    }
    table.append(body);
    if(Number.isFinite(overview.accounting.totalRows)){
      const foot=document.createElement('tfoot'),row=document.createElement('tr'),label=document.createElement('th'),total=document.createElement('td');
      label.scope='row';label.textContent='Total physical rows';total.textContent=integerLabel(overview.accounting.totalRows);row.append(label,total);foot.append(row);table.append(foot);
    }
    const wrap=document.createElement('div');wrap.className='table-scroll';wrap.append(table);details.append(wrap);
    if(overview.accounting.views?.length){
      const description=document.createElement('p');description.className='muted';description.textContent='Views are queries over the tables above; their rows are not stored a second time.';details.append(description);
      const views=document.createElement('dl');views.className='recording-dataset-fields';
      for(const view of overview.accounting.views){const name=document.createElement('dt'),text=document.createElement('dd');name.textContent=view.name;text.textContent=view.description;views.append(name,text);}details.append(views);
    }
    details.open=expanded.get('accounting')??false;nodes.push(details);
  }
  root.replaceChildren(...nodes);
  if(focusedKey) [...root.querySelectorAll('[data-overview-key]')].find(node=>node.dataset.overviewKey===focusedKey)?.querySelector('summary')?.focus({preventScroll:true});
}

export function recordingOverviewRefresh({request,root,details,parent,message,button,clock=Date.now,isVisible=()=>document.visibilityState!=='hidden',render=renderRecordingOverview}) {
  let fetchedAt=null,busy=false,loaded=false,refreshAfterMs=300000;
  const refresh=async({force=false}={})=>{
    if(busy||!details.open||!parent.open||!isVisible()||!force&&fetchedAt!==null&&clock()-fetchedAt<refreshAfterMs)return;
    busy=true;button.disabled=true;root.setAttribute('aria-busy','true');
    message.classList.remove('form-error');message.textContent=loaded?'Refreshing recorded-data overview…':'Loading recorded-data overview…';
    try {
      const result=await request('/api/recording-overview');
      if(!result||!Array.isArray(result.groups))throw new Error('Invalid recorded-data overview');
      render(result,root);loaded=true;fetchedAt=clock();
      refreshAfterMs=Number.isFinite(result.refreshAfterMs)&&result.refreshAfterMs>0?result.refreshAfterMs:300000;
      message.textContent=`Database snapshot: ${dateLabel(result.generatedAt)??dateLabel(fetchedAt)} · Finnish time${result.cache?.hit?' · cached':''}. Refreshes while this section is open.`;
    } catch {
      message.classList.add('form-error');
      message.textContent=loaded?'Could not refresh the overview. The last successful overview is still shown.':'The recorded-data overview could not be loaded. Use Refresh overview to try again.';
    } finally {busy=false;button.disabled=false;root.removeAttribute('aria-busy');}
  };
  return refresh;
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
