import { HISTORY_GROUPS } from '../src/domain/history-series.js';
import { durationText, qualityReasonText } from './reading-status.js';
import { providerName } from './provider-status.js';
import { recordingPolicy, recordedSignalInfo, RECORDING_POLICIES } from '../src/domain/recording-policy.js';

export function durationLabel(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'Collecting';
  if (ms < 60_000) return `${Math.round(ms/1000)} s`;
  if (ms < 3_600_000) return `${Number((ms/60_000).toFixed(1))} min`;
  return `${Number((ms/3_600_000).toFixed(1))} h`;
}
const number = value => Number.isFinite(value) ? new Intl.NumberFormat('en-GB',{maximumSignificantDigits:3}).format(value) : '—';
const readable = value => String(value ?? '').replaceAll('_',' ');

export function recordingStatus(row = {}, { now = Date.now() } = {}) {
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
  const result = (status.parameters ?? []).filter(parameter =>
    (RECORDING_POLICIES[parameter.policy] ?? recordingPolicy(parameter)).adaptive)
    .map(parameter => ({ ...recordedSignalInfo(parameter.signal, parameter.unit), ...parameter }));
  const duplicates = new Map();
  const sourceKey = row => JSON.stringify([row.signal, row.source]);
  for (const row of result) duplicates.set(sourceKey(row), (duplicates.get(sourceKey(row)) ?? 0) + 1);
  for (const row of result) if (duplicates.get(sourceKey(row)) > 1) row.streamQualifier = row.streamId?`Stream ${row.streamId}`:'Stream identity unavailable';
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
  for (const [label,value] of [['Adaptive streams',rows.length],
    ['Projected growth',recording.measurementHours?`${number(recording.projectedAnnualBytes/1e9)} GB/year`:'Collecting'],
    ['Rolling target',`${number((recording.annualBudgetBytes??1e10)/1e9)} GB/year`],
    ['Database',`${number((recording.measuredDatabaseBytes??0)/1e6)} MB`]]) {
    const group=document.createElement('div'),term=document.createElement('dt'),detail=document.createElement('dd');
    term.textContent=label;detail.textContent=String(value);group.append(term,detail);summary.append(group);
  }
  const description=document.createElement('p');description.className='muted';
  description.textContent='These observed streams use learned change thresholds. Fresh unchanged readings extend availability coverage. Energy keeps accumulating in a saved open interval until power or quality changes close it. Exact sensor changes, states, settings, counters and every-report feedback are under Other recorded data.';
  const note=document.createElement('p');note.className='muted';
  note.textContent='Mean spacing uses actual saved timestamps. Source details explain freshness separately. Payload sizes are approximate. The rolling target covers database growth; only adaptive streams use the learned threshold. Saved adaptive datasets, including recovered history without a current checkpoint, are listed under Other recorded data → Recording and storage support.';
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
    tr.dataset.signal=row.signal;tr.dataset.streamId=row.streamId??row.signal;
    if(row.source) {const source=document.createElement('small');const name=({ 'garage-adapter':'Garage heat pump', 'mqtt-equipment':'MQTT equipment', 'shelly-mqtt':'Shelly', simulation:'Simulation' })[row.source]??providerName(row.source)??readable(row.source);
      source.textContent=`${name} · ${({degC:'°C','degree-minutes':'°min'})[row.unit]??row.unit??''}`;title.append(source);}
    if(row.streamQualifier) {const qualifier=document.createElement('small');qualifier.className='recording-stream-qualifier';qualifier.textContent=row.streamQualifier;title.append(qualifier);}
    tr.append(title);
    const saved=document.createElement('td');saved.textContent=integerLabel(row.day?.records);saved.dataset.label='Saved · 24 h';
    if(Number.isFinite(row.day?.estimatedBytes)) {const bytes=document.createElement('small');bytes.textContent=`Approx. ${number(row.day.estimatedBytes/1000)} kB payload`;saved.append(bytes);}tr.append(saved);
    for(const [label,text] of [
      ['Mean spacing · 1 h / 24 h / 7 d',[row.hour,row.day,row.week].map(period=>Number.isFinite(period?.averageIntervalMs)?durationLabel(period.averageIntervalMs):'—').join(' / ')],
      ['Change threshold',Number.isFinite(row.threshold)?row.threshold<1e-9?'Any measurable change':`${number(row.threshold)} ${({degC:'°C','degree-minutes':'°min'})[row.thresholdUnit??row.unit]??row.thresholdUnit??row.unit??''}${row.grouped?' (phase group)':''}`:'Collecting'],
    ]) {const cell=document.createElement('td');cell.dataset.label=label;cell.textContent=text;tr.append(cell);}
    const sourceCell=document.createElement('td'),details=document.createElement('details'),heading=document.createElement('summary'),detail=document.createElement('p');
    sourceCell.dataset.label='Source / open interval';details.className='recording-reading-details';details.dataset.streamId=row.streamId??row.signal;details.open=expanded.has(details.dataset.streamId);
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
  root.replaceChildren(summary,description,note,wrap);
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
  intro.textContent=overview.summary??'Exact measurements, equipment states, every-report feedback and the remaining stored datasets are listed here. Each row explains its saving rule, retained history or overwritten state, record count and dates. Matching scalar signals with the same unit and saving rule are combined across sources.';
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

export function energyAuditRow(item) {
  const date = value => Number.isFinite(value) ? new Intl.DateTimeFormat('en-GB',{
    timeZone:'Europe/Helsinki',dateStyle:'short',timeStyle:'short'}).format(value) : '—';
  if (item.kind==='charging-session-summary') {
    const s=item.summary ?? {}, second=item.source==='shelly-evse', count=s.comparedSessions ?? 0;
    const reasonLabels={
      'incomplete-coverage':'recorded energy does not cover the whole session',
      'missing-start':'charging start was not fully recorded',
      'missing-end':'charging end could not be confirmed',
      'disconnected':'recording was interrupted by a disconnect or restart',
      'stale':'charging data stopped updating',
      'duplicate-suspected':'possible overlap with Charger 1 energy',
      'assignment-uncertain':'charger assignment could not be confirmed',
      'counter-reset':'session energy counter reset',
      'out-of-order':'session order or boundaries conflict',
      'missing-final-reference':'final physical meter reading was not confirmed',
      'missing-estimate':'recorded energy total is unavailable',
      'missing-reference':'Session-meter reference is unavailable',
      'zero-reference':'Session-meter reference is zero',
      'comparison-incomplete':'complete recording or final reference could not be confirmed',
    };
    const reasons=Object.entries(reasonLabels).filter(([key])=>Number.isSafeInteger(s.exclusionReasons?.[key])&&s.exclusionReasons[key]>0)
      .map(([key,label])=>`${s.exclusionReasons[key]} × ${label}`);
    return { title:second?'Charger 2':'Charger 1', subtitle:'Completed-session averages',
      when:Number.isFinite(s.lastSessionEnd)?`Last session: ${date(s.lastSessionEnd)}`:'No completed sessions recorded yet',
      value:count>0?`${number(s.differencePercent)}% energy-weighted difference · ${number(s.differenceKwh/count)} kWh average difference`
        :s.excludedSessions>0?'No sessions qualify for comparison yet.'
          :'Session comparison pending: waiting for a completed session with full recording and a final reference.',
      details:[...(count>0?[`${number(s.estimatedKwh/count)} kWh recorded / ${number(s.referenceKwh/count)} kWh metered per session`]:[]),
        `${count} compared · ${s.excludedSessions ?? 0} excluded · ${s.recordedSessions ?? 0} recorded sessions`,
        ...(reasons.length?[`Excluded because: ${reasons.join('; ')}.`,
          'A session can have several reasons. Excluded sessions stay recorded and do not affect the averages.']:[]),
        ...(count>0?[`Compared sessions: ${date(s.start)} – ${date(s.end)}`]:[]),
        `Recorded power estimate minus Charger ${second?'2':'1'} electricity meter; excluded coverage is never extrapolated.`] };
  }
  const c=item.comparison;
  return {title:'Property',subtitle:'Cumulative import meter',when:`Meter reading: ${date(item.sourceTime)}`,
    value:c?`${number(c.differenceKwh)} kWh difference · ${number(c.differencePercent)}% · estimated minus meter`
      :'Comparison pending: two valid counters and matching energy coverage needed',
    details:c?[`${number(c.estimatedKwh)} kWh estimated / ${number(c.meteredKwh)} kWh meter${c.edgeEstimated?' · interval edges prorated':''}${c.includesOpenInterval?' · includes ongoing recorded interval':''}`,
      `Compared: ${date(c.start)} – ${date(c.end)}`]:[]};
}

export function renderEnergyAudits(rows, root) {
  if(!root)return;
  root.replaceChildren();
  const note=document.createElement('p');note.className='muted';
  note.textContent='Property shows its latest cumulative-meter check. Charger 1 and Charger 2 summarize completed sessions with matching recording coverage; percentages are weighted by reference energy. These checks never change history, calibrate estimates, train the house model or affect recording thresholds.';root.append(note);
  if(!rows?.length) {const p=document.createElement('p');p.textContent='Waiting for fresh accumulated-kWh updates.';root.append(p);return;}
  const table=document.createElement('table');table.className='recording-table';
  for(const item of rows) {
    const display=energyAuditRow(item);
    const row=document.createElement('tr'),title=document.createElement('th');title.scope='row';
    title.textContent=display.title;
    const meter=document.createElement('small');meter.textContent=display.subtitle;title.append(meter);
    const when=document.createElement('small');when.textContent=display.when;title.append(when);row.append(title);
    const cell=document.createElement('td');cell.textContent=display.value;
    for (const text of display.details) {const detail=document.createElement('small');detail.textContent=text;cell.append(detail);}
    row.append(cell);table.append(row);
  }
  const wrap=document.createElement('div');wrap.className='table-scroll';wrap.append(table);root.append(wrap);
}
