import { HISTORY_GROUPS, SIGNAL_INFO } from '../src/domain/history-series.js';
import { durationText, qualityReasonText } from './reading-status.js';
import { providerName } from './provider-status.js';
import { recordingPolicy, recordedSignalInfo, RECORDING_POLICIES } from '../src/domain/recording-policy.js';
import { recordingSourceLabel } from '../src/domain/recording-source.js';
import { voltageProvenanceDetails } from '../src/domain/voltage-provenance.js';
import { setStatusDetail } from './status-details.js';

export function durationLabel(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'Collecting';
  if (ms < 60_000) return `${Math.round(ms/1000)} s`;
  if (ms < 3_600_000) return `${Number((ms/60_000).toFixed(1))} min`;
  return `${Number((ms/3_600_000).toFixed(1))} h`;
}
const number = value => Number.isFinite(value) ? new Intl.NumberFormat('en-GB',{maximumSignificantDigits:3}).format(value) : '—';
const readable = value => String(value ?? '').replaceAll('_',' ');
const unitLabel = unit => ({degC:'°C','degree-minutes':'°min'})[unit] ?? unit ?? '';
const thresholdLabel = row => Number.isFinite(row.threshold) ? row.threshold<1e-9 ? 'Any measurable change'
  : `${number(row.threshold)} ${unitLabel(row.thresholdUnit??row.unit)}${row.grouped?' (phase group)':''}`
  : row.activity==='historical'?'Historical':row.activity==='ambiguous'?'Unknown':'Collecting';

export function recordingStatus(row = {}, { now = Date.now() } = {}) {
  if (row.activity === 'historical') return { label: 'Historical',
    detail: 'No acquisition from this source has been observed in this runtime. Saved source status and open energy remain historical evidence; they do not establish a current connection.' };
  if (row.activity === 'snapshot') return { label: 'Latest recorded source',
    detail: 'This source has the latest recorded acquisition for this measurement in the snapshot. Spacing, threshold and open energy describe saved recording state, not a live connection.' };
  if (row.activity === 'ambiguous') return { label: 'Source selection uncertain',
    detail: 'Multiple source identities have the same latest acquisition time. Their individual spacing, thresholds and saved intervals are available in Source history.' };
  if (row.voltage) {
    const v = row.voltage, provenance = voltageProvenanceDetails(v);
    const label = v.mature ? v.reporting ? 'Established estimate' : 'Estimate held · input unavailable'
      : v.reason === 'source-unconfigured' ? 'Waiting for voltage source'
        : v.reporting ? 'Collecting voltage history' : 'Voltage collection paused';
    const messages = [v.mature ? 'Saved smoothed voltage for planning; this is not a live voltage reading.'
      : `${number(Math.min(60,Math.max(0,v.coverageMs ?? 0)/60000))} of 60 minutes of valid coverage collected.`];
    if (!v.reporting) messages.push(v.reason === 'source-unconfigured'
      ? 'No eligible configured phase-voltage source is available.'
      : 'Waiting for a valid phase-voltage report or confirmed device telemetry. Missing time does not add coverage.');
    if (provenance.contributors.length) messages.push(`Contributing sources: ${provenance.contributors.join('; ')}.`);
    if (provenance.latest) messages.push(`Latest contributing input: ${provenance.latest}.`);
    if (!provenance.complete) messages.push('Source provenance is incomplete.');
    if (Number.isFinite(v.lastObservedAt) && v.lastObservedAt <= now)
      messages.push(`The latest contributing voltage report is ${durationText(now-v.lastObservedAt)} old.`);
    if (Number.isFinite(row.lastSavedAt) && row.lastSavedAt <= now)
      messages.push(`The estimate was last saved ${durationText(now-row.lastSavedAt)} ago.`);
    return {label,detail:messages.join(' ')};
  }
  const freshness = row.freshness;
  if (!freshness) return { label: ({ fresh: 'Recorded acquisition', stale: 'Reading rejected',
    failed: 'Acquisition failed', unavailable: 'Reading unavailable' })[row.status] ?? 'Waiting for source',
  detail: row.status ? 'The stored status has no detailed freshness assessment.' : 'No acquisition has been recorded.' };
  const label = freshness.status === 'stale' ? freshness.reasons?.some(reason => ['source-expired', 'missing-report'].includes(reason))
    ? 'Out of date' : 'Reading rejected' : ({ fresh: 'Fresh', failed: 'Acquisition failed', unavailable: 'Reading unavailable',
    held: 'Last known reading', 'held-attention': 'Last known reading · needs attention', 'recorded-interval': 'Recorded interval',
    'last-reported': 'Last reported state' })[freshness.status] ?? 'Waiting for source';
  const age = Number.isFinite(freshness.sourceObservedAt) ? now - freshness.sourceObservedAt : null;
  const limit = Number.isFinite(freshness.maxAgeMs) ? freshness.maxAgeMs : null;
  const periodic = freshness.ageBasis === 'periodic-report', interval = freshness.ageBasis === 'completed-interval', eventOnly = freshness.ageBasis === 'event-only';
  const messages = [];
  for (const reason of freshness.reasons ?? []) {
    if (reason === 'source-expired' || reason === 'missing-report') continue;
    const text = qualityReasonText(reason);
    if (text) messages.push(`${text.replace(/^./, value => value.toUpperCase())}.`);
  }
  if (interval) messages.push('A saved, completed energy interval does not expire as a live reading.');
  else if (eventOnly) messages.push(`This device reports state changes without a periodic heartbeat.${age !== null && age >= 0 ? ` The last report is ${durationText(age)} old.` : ' The report time is unavailable.'} Report age alone does not indicate a fault. Current connection availability is shown under Equipment.`);
  else if (age !== null && age >= 0) messages.push(`${periodic ? 'Latest source report' : 'Source reading'} is ${durationText(age)} old.${limit === null
    ? ' No age cutoff applies.' : ` Limit ${durationText(limit)}${periodic && Number.isFinite(freshness.reportIntervalMs)
      ? ` (${durationText(freshness.reportIntervalMs)} reporting interval + ${durationText(freshness.reportGraceMs ?? 0)} grace)` : ''}.`}`);
  else if (age === null) messages.push('No source timestamp is available.');
  if (periodic && freshness.reasons?.includes('missing-report')) messages.push('The expected report is missing.');
  if (periodic && Number.isFinite(freshness.savedValueAt) && freshness.savedValueAt !== freshness.sourceObservedAt && freshness.savedValueAt <= now)
    messages.push(`The unchanged saved value is ${durationText(now - freshness.savedValueAt)} old; report age determines current availability.`);
  if (Number.isFinite(freshness.attentionAfterMs)) messages.push(`Attention starts after ${durationText(freshness.attentionAfterMs)}.`);
  return { label, detail: [...new Set(messages)].join(' ') };
}

export function recordingRows(status = {}) {
  const parameters = (status.parameters ?? []).filter(parameter =>
    (RECORDING_POLICIES[parameter.policy] ?? recordingPolicy(parameter)).adaptive)
    .map(parameter => ({ ...recordedSignalInfo(parameter.signal, parameter.unit), ...parameter }));
  const grouped = new Map();
  for (const row of parameters) {
    // The catalogue names installation measurement roles, not physical-device
    // identity. This grouping is presentation only. Unregistered measurements
    // keep their device stream separate; labels alone never join them.
    const logical = Object.hasOwn(SIGNAL_INFO,row.signal);
    const key = JSON.stringify([row.source,row.signal,row.unit,row.policy ?? recordingPolicy(row).id,
      ...(logical ? [] : [row.streamId ?? parameters.indexOf(row)])]);
    if (!grouped.has(key)) grouped.set(key,[]);
    grouped.get(key).push(row);
  }
  const result = [...grouped].map(([key,streams]) => {
    const recent = [...streams].sort((a,b)=>(b.lastPollAt ?? -Infinity)-(a.lastPollAt ?? -Infinity)
      || String(a.streamId??'').localeCompare(String(b.streamId??'')));
    const snapshot = status.readOnly === true || status.recorded === true;
    const candidates = snapshot ? recent : recent.filter(row=>row.observedThisRun === true);
    const latest = candidates[0], ambiguous = candidates.length>1 && candidates[1].lastPollAt === latest.lastPollAt;
    const current = ambiguous ? null : latest;
    const activity = ambiguous ? 'ambiguous' : current ? snapshot ? 'snapshot' : 'current' : 'historical';
    const row = {...(current ?? recent[0]),activity,
      rowId:`measurement-${encodeURIComponent(key)}`,sourceHistory:recent.map(source=>({...source,
        activity:source===current?activity:'historical'})),currentStreamId:current?.streamId ?? null};
    row.savedDay = {records:streams.reduce((sum,source)=>sum+(source.day?.records ?? 0),0),
      estimatedBytes:streams.reduce((sum,source)=>sum+(source.day?.estimatedBytes ?? 0),0)};
    if (!current) {
      row.hour=null;row.day=null;row.week=null;row.threshold=null;row.openInterval=null;row.voltage=null;
    }
    return row;
  });
  const duplicates = new Map();
  const sourceKey = row => JSON.stringify([row.signal,row.source]);
  for (const row of result) duplicates.set(sourceKey(row),(duplicates.get(sourceKey(row)) ?? 0)+1);
  for (const row of result) if (duplicates.get(sourceKey(row))>1)
    row.streamQualifier=`Source ${(result.filter(item=>sourceKey(item)===sourceKey(row))).indexOf(row)+1}`;
  return result.sort((a,b) => {
    const order = group => {const i=HISTORY_GROUPS.indexOf(group);return i<0?HISTORY_GROUPS.length:i;};
    return order(a.group)-order(b.group)||a.label.localeCompare(b.label)||String(a.source??'').localeCompare(String(b.source??''))
      || String(a.streamId??'').localeCompare(String(b.streamId??''));
  });
}

export function renderRecording(status, root) {
  if (!root) return;
  const expanded=new Set([...root.querySelectorAll('details[data-stream-id][open]')].map(node=>node.dataset.streamId));
  const focusedStream=root.contains(document.activeElement)?document.activeElement.closest('details[data-stream-id]')?.dataset.streamId:null;
  const recording=status?.recording ?? {}, rows=recordingRows(recording), summary=document.createElement('dl');
  summary.className='recording-metrics';
  for (const [label,value] of [['Adaptive measurements',rows.length],
    ['Projected growth',recording.measurementHours?`${number(recording.projectedAnnualBytes/1e9)} GB/year`:'Collecting'],
    ['Rolling target',`${number((recording.annualBudgetBytes??1e10)/1e9)} GB/year`],
    ['Database',`${number((recording.measuredDatabaseBytes??0)/1e6)} MB`]]) {
    const group=document.createElement('div'),term=document.createElement('dt'),detail=document.createElement('dd');
    term.textContent=label;detail.textContent=String(value);group.append(term,detail);summary.append(group);
  }
  const description=document.createElement('p');description.className='muted';
  description.textContent='One row per installation measurement. Expand Source history to inspect its recording identities. Exact states, settings and counters are under Other recorded data.';
  const note=document.createElement('p');note.className='muted';
  note.textContent='Counts and approximate storage include all listed identities within 24 hours. Spacing, threshold and open interval use the current source, or the latest recorded source in a read-only snapshot.';
  const help=document.createElement('details'),helpTitle=document.createElement('summary'),helpText=document.createElement('p');
  help.className='recording-reading-details';help.dataset.streamId='recording-table-help';help.open=expanded.has(help.dataset.streamId);
  helpTitle.textContent='How recording is counted';
  helpText.textContent='Mean spacing uses actual saved receipt timestamps within each window. Source history uses Finnish time. Unchanged readings extend availability coverage. Energy keeps accumulating in a saved open interval until power or quality changes close it. The rolling target covers database growth; only adaptive measurements use learned thresholds. Saved datasets without a recorder checkpoint are under Other recorded data → Recording and storage support.';
  help.append(helpTitle,helpText);
  const table=document.createElement('table');table.className='recording-table recording-measurements';
  const head=document.createElement('thead'),headers=document.createElement('tr');
  for(const name of ['Measurement / source','Saved · 24 h','Mean spacing · 1 h / 24 h / 7 d','Change threshold','Source / open interval']) {
    const cell=document.createElement('th');cell.scope='col';cell.textContent=name;headers.append(cell);
  }
  head.append(headers);table.append(head);
  const body=document.createElement('tbody');let previousGroup;
  for(const row of rows) {
    const availability=recordingStatus(row,{now:status?.now ?? Date.now()});
    if(row.group!==previousGroup) {const tr=document.createElement('tr'),cell=document.createElement('th');cell.colSpan=5;cell.scope='colgroup';cell.textContent=row.group;tr.className='recording-group';tr.append(cell);body.append(tr);previousGroup=row.group;}
    const tr=document.createElement('tr'),title=document.createElement('th');title.scope='row';title.textContent=row.label;
    tr.dataset.signal=row.signal;tr.dataset.streamId=row.rowId;
    if(row.source) {const source=document.createElement('small');const name=recordingSourceLabel(row)??({ 'garage-adapter':'Garage heat pump', 'mqtt-equipment':'MQTT equipment', 'shelly-mqtt':'Shelly', simulation:'Simulation' })[row.source]??providerName(row.source)??readable(row.source);
      if(row.source==='voltage-estimate') setStatusDetail(source, {
        key:`recording-voltage-source-${row.streamId??row.signal}`, title:`${row.label} source`, label:name,
        detail:`The label shows the latest contributing source. Earlier sources can still contribute to the smoothed estimate. Voltage is measured in volts (V).\n\n${availability.detail}`,
      });
      else source.textContent=`${name} · ${({degC:'°C','degree-minutes':'°min'})[row.unit]??row.unit??''}`;
      title.append(source);}
    if(row.streamQualifier) {const qualifier=document.createElement('small');qualifier.className='recording-stream-qualifier';qualifier.textContent=row.streamQualifier;title.append(qualifier);}
    const history=document.createElement('details'),historyTitle=document.createElement('summary'),explanation=document.createElement('p');
    history.className='recording-source-history';history.dataset.streamId=`${row.rowId}-history`;history.open=expanded.has(history.dataset.streamId);
    historyTitle.textContent=`Source history · ${row.sourceHistory.length} ${row.sourceHistory.length===1?'identity':'identities'}`;
    explanation.textContent='Grouped by installation measurement. Separate identities may follow a routing or equipment change; this table does not establish the cause or prove that they are the same device. Dates use Finnish time.';
    history.append(historyTitle,explanation);
    for (const source of row.sourceHistory) {
      const item=document.createElement('div'),name=document.createElement('p'),period=document.createElement('p'),spacing=document.createElement('p'),last=document.createElement('p'),selection=document.createElement('p');
      item.className='recording-source-entry';
      name.textContent=`${source.activity==='current'?'Current recording source':source.activity==='snapshot'?'Latest source in snapshot':'Historical source'} · Stream ${source.streamId??'identity unavailable'}`;
      const first=dateLabel(source.recordedPeriod?.firstSavedAt),end=dateLabel(source.recordedPeriod?.lastSavedAt);
      period.textContent=first||end?`Saved receipt dates: ${first??'unknown'} – ${end??'unknown'}.`:'Saved receipt dates unavailable.';
      spacing.textContent=`Saved in 24 h: ${integerLabel(source.day?.records)}. Mean spacing · 1 h / 24 h / 7 d: ${[source.hour,source.day,source.week].map(value=>Number.isFinite(value?.averageIntervalMs)?durationLabel(value.averageIntervalMs):'—').join(' / ')}.`;
      last.textContent=`Last acquisition received: ${dateLabel(source.lastPollAt)??'unknown'}. Latest accepted source time: ${dateLabel(source.lastSourceTime)??'unknown'}.`;
      selection.textContent=`Saved change threshold: ${thresholdLabel(source)}.${source.openInterval?` Saved open interval: ${number(source.openInterval.kwh)} kWh over ${durationLabel(source.openInterval.end-source.openInterval.start)}.`:''}`;
      item.append(name,period,spacing,last,selection);history.append(item);
    }
    title.append(history);
    tr.append(title);
    const saved=document.createElement('td');saved.textContent=integerLabel(row.savedDay.records);saved.dataset.label='Saved · 24 h';
    if(Number.isFinite(row.savedDay.estimatedBytes)) {const bytes=document.createElement('small');bytes.textContent=`Approx. ${number(row.savedDay.estimatedBytes/1000)} kB payload`;saved.append(bytes);}tr.append(saved);
    for(const [label,text] of [
      ['Mean spacing · 1 h / 24 h / 7 d',[row.hour,row.day,row.week].map(period=>Number.isFinite(period?.averageIntervalMs)?durationLabel(period.averageIntervalMs):'—').join(' / ')],
      ['Change threshold',thresholdLabel(row)],
    ]) {const cell=document.createElement('td');cell.dataset.label=label;cell.textContent=text;tr.append(cell);}
    const sourceCell=document.createElement('td'),details=document.createElement('details'),heading=document.createElement('summary'),detail=document.createElement('p');
    sourceCell.dataset.label='Source / open interval';details.className='recording-reading-details';details.dataset.streamId=row.rowId;details.open=expanded.has(details.dataset.streamId);
    heading.textContent=availability.label;detail.textContent=availability.detail;details.append(heading,detail);sourceCell.append(details);
    if(row.openInterval) {const pending=document.createElement('small');pending.className='recording-open-interval';
      pending.textContent=`Open: ${number(row.openInterval.kwh)} kWh over ${durationLabel(row.openInterval.end-row.openInterval.start)} · saved as readings arrive`;sourceCell.append(pending);}
    tr.append(sourceCell);
    body.append(tr);
  }
  if (!body.children.length) {
    const row=document.createElement('tr'), cell=document.createElement('td');cell.colSpan=5;
    cell.textContent='No adaptive measurement streams have been observed yet.';row.append(cell);body.append(row);
  }
  table.append(body);
  const wrap=document.createElement('div');wrap.className='table-scroll';wrap.append(table);
  root.replaceChildren(summary,description,note,help,wrap);
  if(focusedStream) [...root.querySelectorAll('details[data-stream-id]')].find(node=>node.dataset.streamId===focusedStream)?.querySelector('summary')?.focus({preventScroll:true});
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
  return `${item?.status==='empty'?'No records yet':inventoryCount(item)}${item?.policyLabel?` · ${item.policyLabel}`:''} · ${retentionLabels[item?.retention]??'Recorded data'}`;
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
  intro.textContent=overview.summary??'Exact measurements, equipment states, circulation feedback and the remaining stored datasets are listed here. Each row explains its saving rule, retained history or overwritten state, record count and dates. Matching scalar signals with the same unit and saving rule are combined across sources.';
  nodes.push(intro);
  if (overview.inventoryIssues?.length) {
    const notice=document.createElement('p');notice.className='recording-inventory-notice';
    notice.textContent=`Inventory needs attention: ${overview.inventoryIssues.join(' ')}`;nodes.push(notice);
  }
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
      if(Number.isFinite(item.missingCount))fact(item.retention==='current'?'Cleared entries':'Missing values',integerLabel(item.missingCount));
      for(const detail of item.facts??[])fact(detail.label,typeof detail.value==='number'?number(detail.value):detail.value);
      dataset.append(behavior);
      if(item.breakdown?.length) {
        const title=document.createElement('h4');title.textContent='Included records';dataset.append(title);
        const table=document.createElement('table');table.className='recording-breakdown';
        const head=document.createElement('thead'), headings=document.createElement('tr');
        for(const text of [item.breakdownLabel??'Type','Records','Recorded dates']) { const cell=document.createElement('th');cell.scope='col';cell.textContent=text;headings.append(cell); }
        head.append(headings);table.append(head);
        const body=document.createElement('tbody');
        for(const entry of item.breakdown) {
          const row=document.createElement('tr'), name=document.createElement('th');name.scope='row';name.textContent=entry.label;row.append(name);
          for(const text of [integerLabel(entry.count),inventoryDateSpan({...entry,status:entry.count?'present':'empty'})]) {
            const cell=document.createElement('td');cell.textContent=text;row.append(cell);
          }
          body.append(row);
        }
        table.append(body);const wrap=document.createElement('div');wrap.className='table-scroll';wrap.append(table);dataset.append(wrap);
      }
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

const checkDate = value => Number.isFinite(value) ? new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Helsinki', dateStyle: 'medium', timeStyle: 'short',
}).format(value) : 'Unknown';
const checkEnergy = value => Number.isFinite(value) ? `${new Intl.NumberFormat('en-GB', {
  minimumFractionDigits: value < 1 ? 3 : 0, maximumFractionDigits: 3,
}).format(value)} kWh` : 'Unavailable';
const checkPeriod = comparison => `${checkDate(comparison.start)} – ${checkDate(comparison.end)}`;
const checkDuration = value => value > 0 && value < 1000 ? '<1 s' : durationText(value);
const sessions = count => `${count} session${count === 1 ? '' : 's'}`;

function energyDifference(percent) {
  if (!Number.isFinite(percent)) return 'Meter recorded no consumption in this period';
  if (Math.abs(percent) < 0.05) return 'Recorded energy matches the meter within 0.1%';
  return `Recorded energy is ${Math.abs(percent).toFixed(1)}% ${percent < 0 ? 'lower' : 'higher'} than the meter`;
}

const exclusionLabels = {
  'incomplete-coverage': 'Incomplete recording',
  'missing-start': 'Charging start was not fully recorded',
  'missing-end': 'Charging end could not be confirmed',
  disconnected: 'Recording interrupted by a disconnect or restart',
  stale: 'Charging data stopped updating',
  'duplicate-suspected': 'Possible overlap with Charger 1 energy',
  'assignment-uncertain': 'Charger assignment could not be confirmed',
  'counter-reset': 'Session energy counter reset',
  'out-of-order': 'Session order or boundaries conflict',
  'missing-final-reference': 'Final meter reading was not confirmed',
  'missing-estimate': 'Recorded energy total is unavailable',
  'missing-reference': 'Meter reference is unavailable',
  'zero-reference': 'Meter reference is zero',
  'comparison-incomplete': 'Complete recording or final reference could not be confirmed',
};
const propertyCheckStates = {
  'no-readings': 'No property meter readings recorded',
  'waiting-for-second-reading': 'Waiting for a second meter reading',
  'counter-reset': 'Meter counter decreased; waiting for a new comparison period',
  'out-of-order-counter': 'Meter readings arrived out of order',
  'incomplete-coverage': 'Recording does not cover the whole meter period',
  'conflicting-coverage': 'Recorded energy has conflicting intervals',
};

export function energyAuditRow(item) {
  const s = item.summary;
  if (item.kind === 'charging-session-summary') {
    if (item.source !== 'easee') throw new TypeError('Unknown charging session check');
    const count = s.comparedSessions, excluded = s.excludedSessions;
    const reasons = Object.entries(exclusionLabels)
      .filter(([key]) => Number.isSafeInteger(s.exclusionReasons?.[key]) && s.exclusionReasons[key] > 0)
      .map(([key, label]) => `${label}: ${sessions(s.exclusionReasons[key])}.`);
    return { key: item.signal ?? 'ev1_session_energy_check',
      title: 'Charger 1', subtitle: 'Completed sessions',
      method: 'Checks that the stored L1–L3 energy sum, estimated by integrating power, matches the charger’s final session meter reading.',
      value: count > 0 ? energyDifference(s.differencePercent)
        : s.recordedSessions > 0 ? 'No complete comparisons yet' : 'No completed sessions recorded',
      context: count > 0 ? [
        `${checkEnergy(s.estimatedKwh)} recorded · ${checkEnergy(s.referenceKwh)} metered`,
        `Based on ${count} of ${s.recordedSessions} completed sessions.`,
        `Compared sessions: ${checkPeriod(s)}`,
      ] : s.recordedSessions > 0 ? [`All ${sessions(s.recordedSessions)} excluded from comparison.`] : [],
      notice: null,
      detailsLabel: excluded > 0 ? `${sessions(excluded)} excluded · details` : 'Comparison details',
      details: s.recordedSessions > 0 ? [
        `Final meter references: ${(s.referenceTransports?.length ? s.referenceTransports : ['unknown'])
          .map(transport => recordingSourceLabel({source:'easee',transport})).join('; ')}. Recorded energy can include different input transports.`,
        ...reasons,
        ...(reasons.length > 1 ? ['Reason counts can overlap: a session may have more than one issue.'] : []),
        ...(excluded > 0 ? ['Excluded sessions remain in history and do not contribute to these totals.'] : []),
        ...(Number.isFinite(s.lastSessionEnd) ? [`Latest completed session: ${checkDate(s.lastSessionEnd)}.${excluded > 0 ? ' This may be an excluded session.' : ''}`] : []),
        'Includes all recorded completed sessions with full recording coverage and a positive final electricity-meter reference.',
      ] : [],
    };
  }
  if (item.kind !== 'property-meter-summary') throw new TypeError('Unknown recorded energy check');
  const comparison = s.comparison ?? s.lastSuccessfulComparison;
  const latest = s.latestReading, previous = s.previousReading;
  const state = propertyCheckStates[s.status];
  const coverage = s.coverage;
  return { key: item.signal, title: 'Property', subtitle: 'Import meter',
    method: 'Checks the stored L1–L3 energy sum, estimated by integrating power, against the increase in the Equalizer import counter over the same period.',
    value: comparison ? energyDifference(comparison.differencePercent) : state ?? 'Comparison unavailable',
    context: [
      ...(comparison ? [
        `${checkEnergy(comparison.estimatedKwh)} recorded · ${checkEnergy(comparison.meteredKwh)} metered`,
        `${s.comparison ? 'Compared period' : 'Last successful comparison'}: ${checkPeriod(comparison)}`,
      ] : []),
      ...(latest ? [`Latest meter reading: ${checkEnergy(latest.valueKwh)} · ${checkDate(latest.sourceTime)}`] : []),
    ],
    notice: comparison && !s.comparison ? `Latest reading: ${state ?? 'Comparison unavailable'}.` : null,
    detailsLabel: 'Meter readings and coverage',
    details: [
      ...(latest ? [
        `Meter source: Equalizer · ${recordingSourceLabel({source:'easee',transport:latest.transport})}.`,
        `${s.readingCount} cumulative meter reading${s.readingCount === 1 ? '' : 's'} recorded.`,
        `Latest reading received: ${checkDate(latest.receivedAt)}. Meter times describe the source reading; receiving the same reading again does not create a new counter.`,
      ] : ['The property import counter is supplied by the Easee Equalizer through Easee Cloud. Check its connection under Equipment.']),
      ...(previous ? [`Previous meter reading: ${checkEnergy(previous.valueKwh)} · ${checkDate(previous.sourceTime)}.`] : []),
      ...(coverage ? [
        `Latest meter period: ${checkPeriod(coverage)}.`,
        `Recording covers ${checkDuration(coverage.coveredMs)} of ${checkDuration(coverage.durationMs)}.`,
        ...(coverage.coveredMs < coverage.durationMs ? [`Uncovered or unusable time: ${checkDuration(coverage.durationMs - coverage.coveredMs)}.`] : []),
      ] : []),
      ...(s.status === 'incomplete-coverage' ? ['The missing part is not estimated. A comparison needs uninterrupted recording between the two meter readings.'] : []),
      ...(s.status === 'conflicting-coverage' ? ['Overlapping or conflicting records prevent a reliable total for this period.'] : []),
      ...(s.status === 'counter-reset' ? ['The decreased counter starts a new baseline; consumption across the reset cannot be compared.'] : []),
      ...(s.status === 'out-of-order-counter' ? ['A reading with a later meter timestamp was already recorded. No consumption is calculated from this reversed period.'] : []),
      ...(comparison?.edgeEstimated ? ['Energy at the comparison boundaries is prorated from recorded interval averages.'] : []),
      ...(comparison?.includesOpenInterval ? ['The comparison includes an ongoing recorded interval saved to the database.'] : []),
      ...(comparison && comparison.differencePercent === null ? ['A percentage cannot be calculated when the meter increment is zero.'] : []),
    ],
  };
}

export function renderEnergyAudits(rows, root) {
  if (!root) return;
  const expanded = new Set([...root.querySelectorAll('details[data-check-key][open]')].map(node => node.dataset.checkKey));
  const focused = root.contains(document.activeElement) ? document.activeElement.closest('details[data-check-key]')?.dataset.checkKey : null;
  const paragraph = (text, className) => {
    const node = document.createElement('p'); node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const disclosure = (key, label, lines) => {
    const details = document.createElement('details'), summary = document.createElement('summary');
    details.className = 'energy-check-details'; details.dataset.checkKey = key; details.open = expanded.has(key);
    summary.textContent = label; details.append(summary, ...lines.map(text => paragraph(text)));
    return details;
  };
  const nodes = [
    paragraph('Property and Charger 1 compare stored phase-energy totals, estimated by integrating power, with meter references over matching periods.', 'muted'),
    paragraph('Charger 2 records lifetime meter increments directly; only the phase split is estimated, so it has no equivalent integration check.', 'muted'),
  ];
  for (const item of rows) {
    const display = energyAuditRow(item), article = document.createElement('article');
    article.className = 'energy-check'; article.dataset.checkKey = display.key;
    const identity = document.createElement('div'), title = document.createElement('h3');
    title.textContent = display.title; identity.append(title, paragraph(display.subtitle, 'energy-check-source'));
    const body = document.createElement('div'); body.className = 'energy-check-body';
    body.append(paragraph(display.value, 'energy-check-result'), paragraph(display.method, 'energy-check-context'),
      ...display.context.map(text => paragraph(text, 'energy-check-context')));
    if (display.notice) body.append(paragraph(display.notice, 'energy-check-notice'));
    if (display.details.length) body.append(disclosure(display.key, display.detailsLabel, display.details));
    article.append(identity, body); nodes.push(article);
  }
  nodes.push(disclosure('method', 'How comparisons work', [
    'Only matching periods with complete recording are compared. Percentages use the summed recorded and metered energy, so larger sessions contribute more. Gaps stay excluded. Dates and times are Finnish time.',
    'These checks are read-only. They do not change recorded history, calibrate estimates, train the house model or adjust recording thresholds.',
  ]));
  root.replaceChildren(...nodes);
  if (focused) [...root.querySelectorAll('details[data-check-key]')].find(node => node.dataset.checkKey === focused)?.querySelector('summary')?.focus({ preventScroll: true });
}
