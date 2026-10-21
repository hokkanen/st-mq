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
    const label = v.available ? v.reporting ? 'Smoothed estimate' : 'Estimate held · input unavailable'
      : v.reason === 'source-unconfigured' ? 'Waiting for voltage source'
        : 'Waiting for valid voltage';
    const messages = [v.available ? 'Saved smoothed voltage for planning; this is not a live voltage reading. The first valid reading is usable immediately; smoothing builds with observed time.'
      : 'A valid phase-voltage reading is needed before an estimate is available.'];
    if (v.available) messages.push(`${number(Math.max(0,v.coverageMs ?? 0)/60000)} minutes of valid coverage collected.`);
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
    'last-reported': freshness.ageBasis === 'saved-selection' ? 'Saved selection' : 'Last reported state' })[freshness.status] ?? 'Waiting for source';
  const age = Number.isFinite(freshness.sourceObservedAt) ? now - freshness.sourceObservedAt : null;
  const limit = Number.isFinite(freshness.maxAgeMs) ? freshness.maxAgeMs : null;
  const periodic = freshness.ageBasis === 'periodic-report', interval = freshness.ageBasis === 'completed-interval', eventOnly = freshness.ageBasis === 'event-only';
  const messages = [];
  for (const reason of freshness.reasons ?? []) {
    if (reason === 'source-expired' || reason === 'missing-report') continue;
    const text = qualityReasonText(reason);
    if (text) messages.push(`${text.replace(/^./, value => value.toUpperCase())}.`);
  }
  if (freshness.ageBasis === 'saved-selection') messages.push(`The saved Normal/Away selection remains in effect until changed.${age !== null && age >= 0 ? ` The selection is ${durationText(age)} old.` : ''} This is application intent and does not confirm current heat-pump or sensor availability.`);
  else if (interval) messages.push('A saved, completed energy interval does not expire as a live reading.');
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
  const focused=root.contains(document.activeElement)?document.activeElement:null;
  const focusedStream=focused?.closest('details[data-stream-id]')?.dataset.streamId;
  const focusedSource=focused?.closest('[data-recording-source]')?.dataset.recordingSource;
  const recording=status?.recording ?? {}, rows=recordingRows(recording);
  const description=document.createElement('p');description.className='recording-section-caption';
  description.textContent=`${rows.length} adaptive ${rows.length===1?'measurement':'measurements'}`;
  const note=document.createElement('p');note.className='muted';
  note.textContent='Expand a source to inspect its status or recording history. Exact measurements, states, settings and counters are under Other recorded data. Counts and approximate storage include all listed identities within 24 hours. Spacing, threshold and open interval use the current source, or the latest recorded source in a read-only snapshot.';
  const help=document.createElement('details'),helpTitle=document.createElement('summary'),helpText=document.createElement('p');
  help.className='recording-reading-details recording-guide';help.dataset.streamId='recording-table-help';help.open=expanded.has(help.dataset.streamId);
  helpTitle.textContent='How recording is counted';
  helpText.textContent='Mean spacing uses actual saved receipt timestamps within each window. Source history uses Finnish time. Unchanged readings extend availability coverage. Energy keeps accumulating in a saved open interval until power or quality changes close it. The soft annual target covers estimated adaptive measurement additions. Exact records, imported history, journals and database overhead are additional; whole-database growth is under Storage & growth. Saved datasets without a recorder checkpoint are under Other recorded data → Recording and storage support.';
  help.append(helpTitle,note,helpText);
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
      if(row.source==='voltage-estimate') { source.dataset.recordingSource=row.rowId;setStatusDetail(source, {
        key:`recording-voltage-source-${row.streamId??row.signal}`, title:`${row.label} source`, label:name,
        detail:`The label shows the latest contributing source. Earlier sources can still contribute to the smoothed estimate. Voltage is measured in volts (V).\n\n${availability.detail}`,
      });}
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
  root.replaceChildren(description,help,wrap);
  const restoredFocus=focusedStream?[...root.querySelectorAll('details[data-stream-id]')].find(node=>node.dataset.streamId===focusedStream)?.querySelector('summary')
    :focusedSource?[...root.querySelectorAll('[data-recording-source]')].find(node=>node.dataset.recordingSource===focusedSource)?.querySelector('button'):null;
  if(focused)(restoredFocus??helpTitle).focus({preventScroll:true});
}

const inventoryDateFormat=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Helsinki',dateStyle:'medium',timeStyle:'short'});
const inventoryDayFormat=new Intl.DateTimeFormat('en-GB',{timeZone:'UTC',dateStyle:'medium'});
const validDate=at=>Number.isFinite(at)&&at>=0&&at<=8640000000000000;
const dateLabel=at=>validDate(at)?inventoryDateFormat.format(at):null;
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
  return `${item?.status==='empty'?'No records yet':item?.count===null?'Not measured':inventoryCount(item)}${item?.policyLabel?` · ${item.policyLabel}`:''} · ${retentionLabels[item?.retention]??'Recorded data'}`;
}

export function inventoryDateSpan(item) {
  const dateOnly=item?.datePrecision==='date';
  const format=at=>dateOnly&&validDate(at)?inventoryDayFormat.format(at):dateLabel(at);
  const first=format(item?.firstAt),last=format(item?.lastAt);
  if(!first&&!last)return item?.status==='empty'?'No recorded dates yet':item?.count===null?'Measure the complete inventory to check dates':'Dates not recorded';
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

  if (overview.inventoryIssues?.length) {
    const notice=document.createElement('details'), title=document.createElement('summary'), list=document.createElement('ul');
    notice.className='recording-inventory-notice recording-guide';notice.dataset.overviewKey='issues';notice.open=expanded.get('issues')??false;
    title.textContent=`${overview.inventoryIssues.length} inventory ${overview.inventoryIssues.length===1?'issue':'issues'}`;
    for(const issue of overview.inventoryIssues){const item=document.createElement('li');item.textContent=issue;list.append(item);}
    notice.append(title,list);nodes.push(notice);
  }
  const accounting=document.createElement('details'),accountingTitle=document.createElement('summary'),accountingText=document.createElement('p');
  accounting.className='recording-reading-details recording-guide';accounting.dataset.overviewKey='counting';accounting.open=expanded.get('counting')??false;
  accountingTitle.textContent='About counts and selected history';accountingText.textContent='Complete counts and dates are measured separately. Empty datasets remain available below. Stored source counts include retained evidence excluded by recovery corrections. Selected chart history can contain fewer records. Learning journal counts describe the selected model history. Dataset counts may overlap and should not be added together.';accounting.append(accountingTitle,accountingText);
  if(overview.summary){const explanation=document.createElement('p');explanation.textContent=overview.summary;accounting.append(explanation);}
  const groups=overview.groups??[],emptyItem=item=>item.status==='empty'&&item.count===0;
  const populated=groups.filter(group=>group.items?.some(item=>!emptyItem(item)));
  const emptyGroups=groups.filter(group=>!populated.includes(group));
  const totals=groups.flatMap(group=>group.items??[]);
  const counts=document.createElement('p');counts.className='recording-section-caption recording-inventory-counts';
  const datasetCounts=items=>{const present=items.filter(item=>Number.isSafeInteger(item.count)&&item.count>0).length,empty=items.filter(emptyItem).length;
    return `${present} with records${empty?` · ${empty} empty`:''}${items.length-present-empty?` · ${items.length-present-empty} counts unavailable`:''}`;};
  const measured=totals.some(item=>Number.isSafeInteger(item.count));
  counts.textContent=measured?`Datasets · ${datasetCounts(totals)}`:`${integerLabel(totals.length)} datasets · Counts and dates not measured`;const heading=document.createElement('div'), action=document.createElement('a');
  heading.className='recording-section-intro';heading.dataset.overviewKey='inventory-action';
  action.className='recording-task-link';action.href='#recording-storage-details';action.dataset.recordingOpen='recording-storage-details';
  action.textContent='Measure complete inventory →';heading.append(counts,action);nodes.unshift(heading);nodes.push(accounting);
  const emptyGroupDetails=document.createElement('details');emptyGroupDetails.className='recording-empty-datasets';emptyGroupDetails.dataset.overviewKey='empty-groups';
  const emptyGroupTitle=document.createElement('summary');emptyGroupTitle.textContent=`Show empty dataset groups · ${emptyGroups.length}`;emptyGroupDetails.append(emptyGroupTitle);
  for(const group of [...populated,...emptyGroups]) {
    const details=document.createElement('details');details.className='recording-data-group';details.dataset.overviewKey=`group:${group.id}`;
    const groupEmpty=(group.items??[]).filter(emptyItem),groupPresent=(group.items??[]).filter(item=>!emptyItem(item));
    const summary=document.createElement('summary'),groupName=document.createElement('span'),groupCount=document.createElement('span');
    groupName.textContent=group.label;groupCount.className='recording-group-count';groupCount.textContent=measured?datasetCounts(group.items??[]):`${group.items?.length??0} ${group.items?.length===1?'dataset':'datasets'}`;
    summary.append(groupName,groupCount);details.append(summary);
    if(group.description){const description=document.createElement('p');description.className='muted';description.textContent=group.description;details.append(description);}
    const emptyDetails=document.createElement('details');emptyDetails.className='recording-empty-datasets';emptyDetails.dataset.overviewKey=`empty:${group.id}`;
    const emptyTitle=document.createElement('summary');emptyTitle.textContent=`Show empty datasets · ${groupEmpty.length}`;emptyDetails.append(emptyTitle);
    for(const item of [...groupPresent,...groupEmpty]) {
      const dataset=document.createElement('details');dataset.className='recording-dataset';dataset.dataset.overviewKey=`item:${group.id}:${item.id}`;
      dataset.dataset.datasetId=item.id;dataset.dataset.retention=item.retention??'';
      const title=document.createElement('summary'),name=document.createElement('span'),state=document.createElement('small');
      name.className='recording-dataset-name';name.textContent=item.label;state.textContent=inventoryItemSummary(item);
      title.append(name,state);dataset.append(title);
      if(item.description){const description=document.createElement('p');description.textContent=item.description;dataset.append(description);}
      const behavior=document.createElement('dl');behavior.className='recording-dataset-facts';
      const fact=(label,value)=>{
        const key=document.createElement('dt'),text=document.createElement('dd');key.textContent=label;text.textContent=value===null||value===undefined?'Not measured':String(value);behavior.append(key,text);
      };
      fact('Recorded',item.count===null?'Not measured · use Measure complete inventory':inventoryCount(item));
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
      dataset.open=expanded.get(dataset.dataset.overviewKey)??false;
      (emptyItem(item)&&groupPresent.length?emptyDetails:details).append(dataset);
      if(dataset.open||focusedKey===dataset.dataset.overviewKey)emptyDetails.open=true;
    }
    if(groupPresent.length&&groupEmpty.length) {emptyDetails.open=expanded.get(emptyDetails.dataset.overviewKey)??emptyDetails.open;details.append(emptyDetails);}
    details.open=expanded.get(details.dataset.overviewKey)??false;
    if(emptyGroups.includes(group)) {emptyGroupDetails.append(details);if(details.open||focusedKey===details.dataset.overviewKey)emptyGroupDetails.open=true;}
    else nodes.push(details);
  }
  if(emptyGroups.length){emptyGroupDetails.open=expanded.get('empty-groups')??emptyGroupDetails.open;nodes.push(emptyGroupDetails);}
  if(!overview.groups?.length){const empty=document.createElement('p');empty.textContent='No dataset inventory is available yet.';nodes.push(empty);}
  if(overview.accounting?.tables?.length) {
    const details=document.createElement('details');details.className='recording-storage-accounting';details.dataset.overviewKey='accounting';
    const summary=document.createElement('summary');summary.textContent='Storage accounting';details.append(summary);
    const description=document.createElement('p');description.className='muted';
    description.textContent=overview.accounting.description??'Each physical table is counted once below.';details.append(description);
    const queries=document.createElement('p');queries.className='muted';
    queries.textContent='Charts read original committed records. Point reduction and cached chart responses stay in memory. Database indexes support lookups; they do not store another history series.';details.append(queries);
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
  if(focusedKey) {
    const target=[...root.querySelectorAll('[data-overview-key]')].find(node=>node.dataset.overviewKey===focusedKey)?.querySelector('summary, a')??root.querySelector('summary');
    // A dataset can move into or out of the empty disclosure between scans.
    // Its focused summary must remain reachable after that regrouping.
    for(let ancestor=target?.parentElement?.parentElement?.closest('details');ancestor&&root.contains(ancestor);ancestor=ancestor.parentElement?.closest('details'))ancestor.open=true;
    target?.focus({preventScroll:true});
  }
}

const recordedDataStages = {
  queued:'Waiting for a storage turn', catalogue:'Reading dataset descriptions',
  observations:'Measuring saved observations', events:'Measuring saved events',
  state:'Measuring saved state', provider_snapshot_fetches:'Measuring saved forecasts', provider_snapshot_contents:'Measuring saved forecasts',
  learning_journal_entries:'Measuring recorded learning inputs', learning_checkpoints:'Measuring saved learning models',
  recorder_coverage:'Measuring source coverage', recorder_metrics:'Measuring recording statistics',
  energy_audits:'Measuring meter references', charging_reports:'Measuring charging reports', charging_report_events:'Measuring charging report details',
  allocation:'Measuring database allocation', complete:'Finishing the inventory',
  'reading-meter-history':'Reading property meter history', 'reading-recorded-energy':'Reading recorded phase energy',
  'reading-charging-sessions':'Checking completed charging sessions', 'comparing-energy':'Comparing recorded and metered energy',
  'checking-cache':'Checking which history is already measured',
};
const recordedDataErrors = {
  INVENTORY_SOURCE_CHANGED:'The selected history changed during the measurement. Start a new measurement.',
  INVENTORY_STORAGE_BUSY:'Storage is busy. Retry when the current storage work finishes.',
  INVENTORY_DATABASE_UNREADABLE:'The database could not be read. Check Storage health before retrying.',
  INVENTORY_READ_FAILED:'A saved-history read failed. Check Storage health, then retry the measurement.',
  INVENTORY_WORKER_FAILED:'The background worker stopped before completing the measurement. Retry to start a new worker.',
  INVENTORY_TOO_COMPLEX:'A dataset has too many distinct groups to measure within the supported memory limit. Other completed results remain available.',
  'history-changed':'The selected history changed during the check. Refresh the checks to use the current history.',
  'checks-failed':'Recorded energy could not be compared completely. Check Storage health, then refresh the checks.',
  'storage-busy':'Storage is busy. Retry when the current storage work finishes.',
  'database-unreadable':'The database could not be read. Check Storage health before retrying.',
  'worker-stopped':'The background worker stopped before completing the check. Refresh checks to start a new worker.',
};

/** Whole-history work belongs to a local job; a browser only reads its progress. */
export function recordedDataJobView(view, {kind='inventory',now=Date.now()}={}) {
  const job=view?.job,energy=kind==='energy',active=['queued','running'].includes(job?.state);
  const title=energy?'Energy check':'Inventory measurement';
  const hasResult=view?.result!==null&&view?.result!==undefined;
  const generatedAt=view?.resultGeneratedAt??(!Array.isArray(view?.result)?view?.result?.generatedAt:null);
  const resultTime=dateLabel(generatedAt);
  const retained=hasResult?`Last complete ${energy?'check':'inventory'}: ${resultTime??'time unavailable'} · Finnish time.`:'';
  let message=active?`${title} ${job.state==='queued'?'queued':'running'}. ${recordedDataStages[job.stage]??'Processing saved history'}.`
    : job?.state==='failed'?`${title} failed. ${recordedDataErrors[job.error?.code]??'The saved history could not be read completely. Retry the check.'}`
      : job?.state==='cancelled'?`${title} cancelled.`
        : hasResult?`${energy?'Recorded energy checks':'Complete inventory'} ready.`
          : energy?`${view?.latest?.summary?.latestReading?'The latest meter reading is shown below.':'Meter history has not been checked yet.'} Historical comparisons have not completed.`
            :'Dataset descriptions are ready. Measure the complete inventory to add counts, recorded dates and detailed sizes.';
  if(retained)message=energy&&!active&&!['failed','cancelled'].includes(job?.state)
    ? `Last checked: ${resultTime??'time unavailable'} · Finnish time.` : `${message} ${retained}`;
  const processed=Number.isSafeInteger(job?.processed)&&job.processed>=0?job.processed:null;
  const total=Number.isSafeInteger(job?.total)&&job.total>=0?job.total:null;
  const details=[active&&processed!==null?`${integerLabel(processed)}${total!==null?` of ${integerLabel(total)}`:''} ${energy?'source rows inspected':'rows and pages examined'}`:null,
    active&&validDate(job?.startedAt)?`Started ${dateLabel(job.startedAt)}${now>=job.startedAt?` · ${durationText(now-job.startedAt)} elapsed`:' · ahead of browser clock'}`:null,
    hasResult&&validDate(view?.resultAsOf)?`History through ${dateLabel(view.resultAsOf)}`:null,
    active?'You can leave this page. Recording and control continue.':null].filter(Boolean).join(' · ');
  return {active,message,details,processed,total,failed:job?.state==='failed'};
}

export function renderRecordedDataJob(view,elements,{kind='inventory',now=Date.now(),busy=false}={}) {
  const display=recordedDataJobView(view,{kind,now});
  const {message,button,cancel,progress,detail}=elements;
  if(message){message.textContent=display.message;message.classList?.toggle('form-error',display.failed);}
  if(button)button.disabled=busy||display.active;
  if(cancel){cancel.hidden=!display.active;cancel.disabled=busy;}
  if(detail){detail.textContent=display.details;detail.hidden=!display.details;}
  if(progress){
    progress.hidden=!display.active;
    if(display.total>0&&display.processed!==null){progress.max=display.total;progress.value=Math.min(display.processed,display.total);}
    else progress.removeAttribute('value');
    progress.setAttribute('aria-valuetext',display.active?display.message:'No active check');
  }
  return display;
}

export function recordingOverviewRefresh({request,root,details,parent,message,button,cancel,progress,detail,
  clock=Date.now,isVisible=()=>document.visibilityState!=='hidden',render=renderRecordingOverview,onState=()=>{},onView=()=>{}}) {
  let fetchedAt=null,active=null,view=null,generation=0,queuedAction=null;
  const elements={message,button,cancel,progress,detail};
  const refresh=async({force=false,action=null}={})=>{
    if(force)queuedAction='measure';
    if(action)queuedAction=action;
    if(active||!details.some(fold=>fold.open)||!parent.open||!isVisible())return;
    const display=recordedDataJobView(view,{now:clock()});
    const interval=display.active?2000:30000;
    if(!queuedAction&&fetchedAt!==null&&clock()>=fetchedAt&&clock()-fetchedAt<interval)return;
    const requestedAction=queuedAction;queuedAction=null;
    const operation={generation,controller:new AbortController()};active=operation;
    renderRecordedDataJob(view,elements,{now:clock(),busy:true});root.setAttribute('aria-busy','true');
    if(!view)message.textContent='Loading dataset descriptions…';
    try {
      const next=await request('/api/recording-overview',{signal:operation.controller.signal,
        ...(requestedAction?{method:'POST',body:JSON.stringify({action:requestedAction})}:{})});
      if(operation.generation!==generation)return;
      if(!next||!Array.isArray(next.catalogue?.groups)||!next.job||next.result!==null&&!Array.isArray(next.result?.groups))throw new Error('Invalid recorded-data overview');
      view=next;fetchedAt=clock();render(next.result??next.catalogue,root);onView(next);
      const state=renderRecordedDataJob(next,elements,{now:clock()});
      onState(state.failed?'failed':state.active?'loading':'ready');
    } catch {
      if(operation.generation!==generation)return;
      message.classList.add('form-error');
      message.textContent=view?'Could not refresh inventory status. The last received descriptions and complete results are still shown. Reopen this section to retry.'
        :'Dataset descriptions could not be loaded. Reopen this section to retry.';
      onState('failed');
    } finally {
      if(active===operation) {
        active=null;button.disabled=recordedDataJobView(view).active;
        if(cancel)cancel.disabled=false;root.removeAttribute('aria-busy');
        if(queuedAction)await refresh();
      }
    }
  };
  refresh.cancel=()=>refresh({action:'cancel'});
  refresh.visibilityChanged=()=>{
    if(details.some(fold=>fold.open)&&parent.open&&isVisible())return refresh();
    generation++;active?.controller.abort();active=null;queuedAction=null;fetchedAt=null;
    root.removeAttribute('aria-busy');renderRecordedDataJob(view,elements,{now:clock()});
  };
  refresh.reset=()=>{
    generation++;active?.controller.abort();active=null;queuedAction=null;fetchedAt=null;view=null;
    root.replaceChildren();root.removeAttribute('aria-busy');renderRecordedDataJob(null,elements,{now:clock()});
    onState('idle');
  };
  return refresh;
}

const checkDate = value => validDate(value) ? new Intl.DateTimeFormat('en-GB', {
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
  'comparison-pending': 'Historical comparison has not completed',
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
        ...(Number.isSafeInteger(s.readingCount)?[`${s.readingCount} cumulative meter reading${s.readingCount === 1 ? '' : 's'} recorded.`]:['The complete meter-reading count has not been measured.']),
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
  const nodes = [];
  for (const item of rows) {
    const display = energyAuditRow(item), article = document.createElement('article');
    article.className = 'energy-check'; article.dataset.checkKey = display.key;
    const identity = document.createElement('div'), title = document.createElement('h3');
    title.textContent = display.title; identity.append(title, paragraph(display.subtitle, 'energy-check-source'));
    const body = document.createElement('div'); body.className = 'energy-check-body';
    body.append(paragraph(display.value, 'energy-check-result'),
      ...display.context.map(text => paragraph(text, 'energy-check-context')));
    if (display.notice) body.append(paragraph(display.notice, 'energy-check-notice'));
    body.append(disclosure(display.key, display.detailsLabel, [display.method,...display.details]));
    article.append(identity, body); nodes.push(article);
  }
  nodes.push(disclosure('method', 'How comparisons work', [
    'Property and Charger 1 compare stored phase-energy totals, estimated by integrating power, with meter references over matching periods. Charger 2 records lifetime meter increments directly; only the phase split is estimated, so it has no equivalent integration check.',
    'The Property check uses the latest comparable meter interval wholly inside the selected dates. Charger 1 includes finalized sessions wholly inside those dates; sessions crossing a boundary are omitted. Only matching periods with complete recording are compared. Percentages use the summed recorded and metered energy, so larger sessions contribute more. Gaps stay excluded. Dates and times are Finnish time.',
    'These checks are read-only. They do not change recorded history, calibrate estimates, train the house model or adjust recording thresholds.',
  ]));
  root.replaceChildren(...nodes);
  if (focused) [...root.querySelectorAll('details[data-check-key]')].find(node => node.dataset.checkKey === focused)?.querySelector('summary')?.focus({ preventScroll: true });
}

/** Show the bounded meter preview in the Property row until comparisons finish. */
export function renderEnergyAuditView(view,root) {
  if(!root)return;
  const hasResult=view?.result!==null&&view?.result!==undefined;
  renderEnergyAudits(hasResult?view.result:view?.latest?[view.latest]:[],root);
  if(!hasResult){
    const pending=document.createElement('p');pending.className='muted';
    pending.textContent='Completed comparisons will appear here after the historical check finishes. Missing coverage remains excluded.';
    root.prepend(pending);
  }
}
