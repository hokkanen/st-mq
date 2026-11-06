import { homePlannedChange } from './heating-plan.js';
import { isReadOnlyReplica } from './replica-status.js';
import { confirmAction } from './confirmation.js';
import { actionReceiptRecent } from './action-receipts.js';
import { setStatusDetail, closeStatusDetails } from './status-details.js';

const endpoint = '/api/heating/explorer';
const hour = 3_600_000;
const timeFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const clockFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', hour: '2-digit', minute: '2-digit' });
const decimal = value => {
  if (!Number.isFinite(value)) return 'Unavailable';
  const text = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 }).format(value);
  return text === '-0' ? '0' : text;
};
const money = value => {
  if (!Number.isFinite(value)) return 'Unavailable';
  const amount = (Math.abs(value) / 100).toFixed(2);
  return `${value < 0 && Number(amount) > 0 ? '−' : ''}€${amount}`;
};
const signed = (value, unit) => Number.isFinite(value) ? `${value > 0 && decimal(value) !== '0' ? '+' : ''}${decimal(value)}${unit}` : 'Unavailable';
const atTime = value => Number.isFinite(value) ? timeFormat.format(value) : 'Time unavailable';
const phaseName = phase => ({ normal: 'Normal heating', preheat: 'Preheat', reduction: 'Reduction', recovery: 'Recovery', hold: 'Normal heating' })[phase] ?? 'Heating';
const humanize = value => String(value ?? '').replace(/[-_]/g, ' ');
const reasonLabels = {
  'normal-operation-preferred': 'Normal heating is preferred among the evaluated alternatives.',
  'continuous-normal-preferred': 'Normal heating is preferred among the evaluated alternatives.',
  'unvalidated-thermal-model': 'The model is still learning how the house holds and recovers heat.',
  'unvalidated-heating-energy-model': 'Heating electricity estimates are not yet sufficiently validated.',
  'flat-prices-preserve-normal-warmth': 'The price difference does not justify changing normal heating.',
  'heating-paused': 'Automatic control is paused. Heating can continue. Exploring keeps that choice unchanged.',
  'heating-planning-in-progress': 'The next heating plan is being calculated. Normal heating is requested; device feedback confirms the actual state.',
  'heating-planning-unavailable': 'The next heating plan is unavailable. Normal heating is the fallback request; device feedback confirms the actual state.',
  'estimated-indoor-thermal-state-unavailable': 'The indoor estimate lacks continuous heating evidence for the heat-reserve forecast.',
  'trial-needs-measured-indoor-temperature': 'A learning trial requires measured indoor temperatures.',
  'trial-cost-estimate-unavailable': 'The complete trial cost estimate lacks required cost or stored-heat evidence. Recovery and restoration continue.',
  'indoor-comfort-limit': 'The indoor average is outside its temperature allowance.',
  'missing-or-stale-observations': 'Fresh temperature observations are needed.',
  'currently-selected-cycle': 'This is the cycle currently selected by the controller.',
  'normal-operation': 'Normal heating is selected. No change is scheduled.',
  'continuous-normal-heating': 'Normal heating throughout the evaluated period.',
  'bounded-learning-trial': 'A learning cycle is scheduled within its experiment budget and temperature limits.',
  'predicted-full-cycle-benefit': 'The complete cycle is expected to cost less than Normal heating.',
  'reviewed-experimental-cycle': 'This reviewed cycle permits estimated extra cost under your chosen limits.',
  'missing-or-stale-indoor': 'Current indoor temperature readings are needed before scheduling a cycle.',
  'awaiting-normal-temperature-reference': 'The normal temperature reference is unavailable. Occupied Normal heating observations are needed to establish it.',
  'missing-or-incomplete-price-weather-horizon': 'Price and weather coverage is too short or incomplete to assess a full cycle.',
  'awaiting-tariff-response-evidence': 'The requested heating response cannot currently be assessed.',
  'no-useful-space-heating-window': 'No immediate trial offers useful space-heating evidence under these conditions.',
  'trial-comfort-or-forecast-limited': 'The evaluated trials do not fit the temperature limits or available forecast.',
  'trial-incremental-cost-exceeds-allowance': 'The evaluated trials exceed the available experiment budget.',

};
const reasonsText = reasons => (reasons ?? []).map(reason => reasonLabels[reason] ?? humanize(reason)).join(' · ');
export function heatingEvidenceText(evidence = {}) {
  const validationNames = {
    'awaiting-held-out-thermal-trajectories': 'thermal response',
    'awaiting-held-out-tariff-response': 'requested heating response',
    'awaiting-frozen-advance-cycle-predictions': 'advance cycle forecasts',
    'awaiting-fireplace-response-evidence': 'fireplace response',
    'awaiting-held-out-matching-treatment': 'the selected heating treatment',
  };
  const pending = [...new Set((evidence.reasons ?? []).map(reason => Object.hasOwn(validationNames, reason)
    ? validationNames[reason] : null).filter(Boolean))];
  return [evidence.actionValidated ? 'Independent action validation is available for this comparison.'
    : evidence.initialReady ? 'The initialized model supports executable plans within the reviewed limits while independent validation accumulates.'
      : 'Independent action validation is incomplete.',
  evidence.validatedReductionHours === 0 ? 'No reduction duration has been independently validated yet.'
    : Number.isFinite(evidence.validatedReductionHours) ? `Independently validated reduction duration: ${decimal(evidence.validatedReductionHours)} h.` : '',
  pending.length ? `Validation still being collected: ${pending.join(', ')}.` : ''].filter(Boolean).join(' ');
}
const validTrial = trial => ['pending', 'running'].includes(trial?.status);
const errorMessage = error => error?.status === 401 ? 'Your session ended. Sign in again to continue.'
  : error?.status === 503 && error?.code === 'heating_snapshot_unavailable'
    ? 'The controller has not updated heating conditions. Check Recording status, then refresh conditions.'
  : [409, 410].includes(error?.status) ? 'This comparison is no longer current. Refresh conditions and compare again.'
    : error?.status === 429 ? 'Another comparison is running. Please try again in a moment.'
      : error?.status === 403 ? 'This action is unavailable with your current access or control authority.'
        : error?.status === 503 ? 'Current conditions or the model comparison are unavailable. Refresh conditions to try again.'
        : error?.status === 400 ? 'Check the limits and try again. The scenario was not accepted.'
          : 'The request could not be confirmed. Refresh conditions before trying again.';

/** One pinned comparison at a time; editing never sends a control request. */
export function createHeatingExplorerState({ request, clock = Date.now, onChange = () => {} }) {
  let result = null, baseline = null, limits = {}, busy = false, message = '', error = false, dirty = false, stale = false;
  let generation = 0;
  let freshnessRevision = 0, trialRevision = 0;
  let receipt = null;
  const edited = new Set();
  const snapshot = () => ({ result, limits: { ...limits }, busy, message, error, dirty,
    receipt: actionReceiptRecent(receipt?.at, clock()) ? receipt : null,
    stale: stale || !!result && Number.isFinite(result.expiresAt) && clock() >= result.expiresAt });
  const notify = () => onChange(snapshot());
  async function run(path, body, { reset = false, mutation = false, preserveDraft = false } = {}) {
    if (busy) return false;
    const draft = preserveDraft ? new Map([...edited].map(key => [key, limits[key]])) : null;
    const ownGeneration = ++generation;
    const capturedFreshnessRevision = freshnessRevision, capturedTrialRevision = trialRevision;
    busy = true; error = false; message = mutation ? 'Saving one-cycle limits…' : reset ? 'Reading current conditions…' : 'Comparing the same conditions…'; notify();
    try {
      const next = await request(path, body);
      if (generation !== ownGeneration) return false;
      if (mutation) {
        result = { ...result, activeTrial: next.activeTrial, application: { allowed: false, reason: 'Refresh conditions to review another cycle.' } };
        message = path.endsWith('/cancel') ? 'One-cycle limits cancelled. Any required recovery and restoration still continue.'
          : 'One-cycle limits approved. The controller will recheck conditions before and during the cycle.';
        receipt = { at: clock(), message }; message = '';
        dirty = true;
      } else {
        const activeTrial = result?.activeTrial;
        result = capturedTrialRevision === trialRevision ? next : { ...next, activeTrial };
        stale = capturedFreshnessRevision !== freshnessRevision; dirty = false;
        if (reset) {
          baseline = structuredClone(next);
          limits = Object.fromEntries((next.controls ?? []).map(control => [control.key, control.value])); edited.clear();
          for (const control of next.controls ?? []) if (draft?.has(control.key)) {
            limits[control.key] = draft.get(control.key);
            if (limits[control.key] !== control.value) edited.add(control.key);
          }
          dirty = edited.size > 0;
        }
        message = reset ? draft?.size ? 'Conditions refreshed. Your edited limits are kept; compare again.' : ''
          : 'Comparison ready. Live settings are unchanged.';
      }
      return true;
    } catch (failure) {
      if (generation !== ownGeneration) return false;
      error = true; message = errorMessage(failure);
      if (result) stale = true;
      if (mutation) receipt = { at: clock(), message, error: true };
      return false;
    } finally {
      if (generation === ownGeneration) { busy = false; notify(); }
    }
  }
  return { snapshot,
    load: ({ preserveDraft = false } = {}) => run(endpoint, undefined, { reset: true, preserveDraft }),
    edit(key, value) {
      if (busy || !result?.controls?.some(control => control.key === key)) return;
      if (value !== baseline?.controls?.find(control => control.key === key)?.value) edited.add(key);
      else edited.delete(key);
      limits[key] = value; dirty = true;
      notify();
    },
    reset() {
      if (busy || !result) return;
      const activeTrial = result.activeTrial;
      result = { ...structuredClone(baseline), activeTrial, previewId: null,
        application: { ...baseline.application, allowed: false, reason: 'Compare a scenario before applying it.' } };
      limits = Object.fromEntries(result.controls.map(control => [control.key, control.value])); dirty = false;
      message = 'Preview reset to the captured baseline. Live settings are unchanged.'; error = false;
      edited.clear(); notify();
    },
    compare() {
      if (!result || snapshot().stale) return Promise.resolve(false);
      const changes = Object.fromEntries((baseline?.controls ?? result.controls)
        .filter(control => limits[control.key] !== control.value
          && (!['maxTrialCostCents', 'learningPriorityPriceCents'].includes(control.key) || limits.learningTrials === true))
        .map(control => [control.key, limits[control.key]]));
      return run(`${endpoint}/simulate`, { snapshotId: result.snapshotId, limits: changes });
    },
    apply() {
      if (!result?.previewId || !result.application?.allowed || dirty || snapshot().stale) return Promise.resolve(false);
      return run(`${endpoint}/apply`, { previewId: result.previewId }, { mutation: true });
    },
    cancel: () => validTrial(result?.activeTrial) ? run(`${endpoint}/cancel`, {}, { mutation: true }) : Promise.resolve(false),
    markStale() { if (result) { ++freshnessRevision; stale = true; notify(); } },
    updateTrial(trial) {
      if (result && JSON.stringify(trial) !== JSON.stringify(result.activeTrial)) {
        ++trialRevision;
        result = { ...result, activeTrial: trial }; notify();
      }
    },
    tick: notify,
    clear() { ++generation; result = null; baseline = null; limits = {}; edited.clear(); busy = false; message = ''; error = false; dirty = false; stale = false; receipt = null; notify(); },
  };
}

export function heatingApprovalText(result) {
  const scenario = result.scenario ?? {}, benefit = scenario.estimatedBenefitCents;
  const budget = result.limits?.maxTrialCostCents ?? result.controls?.find(control => control.key === 'maxTrialCostCents')?.scenarioValue
    ?? result.controls?.find(control => control.key === 'maxTrialCostCents')?.value;
  const learning = result.learningContext;
  const allowance = learning?.allowanceBasis === 'reviewed-one-cycle' ? budget
    : Number.isFinite(learning?.remainingAutomaticAllowanceCents) && Number.isFinite(budget)
      ? Math.min(budget, learning.remainingAutomaticAllowanceCents) : null;
  return [
    `The reviewed limits apply only to this cycle${result.application?.expiresAt ? ` and expire by ${atTime(result.application.expiresAt)}` : ''}.`,
    Number.isFinite(benefit) ? `Estimated ${benefit < 0 ? 'extra cost' : 'saving'} against Normal heating: ${money(Math.abs(benefit))}.` : '',
    Number.isFinite(scenario.outcomes?.maxIndoorDropC) ? `Maximum predicted drop below Normal: ${decimal(scenario.outcomes.maxIndoorDropC)} °C.` : '',
    scenario.trial ? `Learning trial: modeled cost exposure ${money(scenario.trialExposureCents)}${Number.isFinite(allowance) ? `, within the ${learning.allowanceBasis === 'reviewed-one-cycle' ? 'reviewed one-cycle' : 'captured automatic'} ${money(allowance)} experiment allowance` : '; the captured allowance is unavailable'}. This is not a bill guarantee.` : '',
    typeof result.limits?.learningTrials === 'boolean' ? `Learning trials are ${result.limits.learningTrials ? 'enabled' : 'disabled'} for this reviewed cycle; saved automatic permission is unchanged.` : '',
    'Approval authorizes this one cycle even if Home automation is paused or disabled. Your saved choices and configured defaults stay unchanged.',
    'The controller rechecks current conditions and temperature limits, and may shorten or cancel the cycle. Independent manual actions and native protection remain active.',
  ].filter(Boolean).join(' ');
}

export function heatingComparisonMetrics(result) {
  const current = result.current ?? {}, scenario = result.scenario ?? {}, comparison = result.comparison ?? {};
  const sameLimitsReplanned = result.changedKeys?.length === 0 && result.currentDiffersFromRecalculation;
  return [
    { label: 'Additional estimated saving', value: money(comparison.additionalBenefitCents),
      detail: sameLimitsReplanned ? 'Fresh calculation with unchanged limits, compared with the selected plan.'
        : 'Compared with the current plan, from the captured time onward.' },
    { label: 'Maximum drop below Normal', value: Number.isFinite(scenario.outcomes?.maxIndoorDropC) ? `${decimal(scenario.outcomes.maxIndoorDropC)} °C` : 'Unavailable',
      detail: Number.isFinite(current.outcomes?.maxIndoorDropC) ? `Current plan ${decimal(current.outcomes.maxIndoorDropC)} °C · change ${signed(comparison.additionalIndoorDropC, ' °C')}` : 'No supported average estimate for the current plan.' },
    { label: 'Chosen reduction duration', value: Number.isFinite(scenario.schedule?.reductionStart) && Number.isFinite(scenario.schedule?.reductionEnd)
      ? `${decimal((scenario.schedule.reductionEnd - scenario.schedule.reductionStart) / hour)} h` : 'No reduction',
      detail: scenario.trial ? 'Learning trial within the scenario budget and temperature limits.' : 'A maximum is permission, not a requested duration.' },
  ];
}

/** Unknown uncertainty interrupts the allowance; it is never a zero-width band. */
export function heatingUncertaintyBands(points = []) {
  const bands = []; let current = [];
  const finish = () => { if (current.length > 1) bands.push(current); current = []; };
  for (const point of points) {
    if (!Number.isFinite(point.at) || !Number.isFinite(point.indoorC)
      || !Number.isFinite(point.uncertaintyC) || point.uncertaintyC < 0) finish();
    else current.push(point);
  }
  finish(); return bands;
}

export function createHeatingExplorerPanel({ document, request, afterMutation = () => {}, confirm = confirmAction }) {
  const $ = id => document.getElementById(id);
  const dialog = $('heating-explorer-dialog'), opener = $('home-planned-change');
  let status, receivedAt = Date.now(), renderedResult, controlsSnapshot, wasStale = false, approving = false;
  const controls = new Map();
  const now = () => Number.isFinite(status?.now) ? status.now + Math.max(0, Date.now() - receivedAt) : Date.now();
  const actions = createHeatingExplorerState({ request, clock: now, onChange: render });
  const element = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  function scrollToLimits(focus) {
    const heading = $('heating-simulator-title');
    const header = dialog.querySelector('.heating-explorer-header');
    heading.style.scrollMarginTop = `${header.offsetHeight + 24}px`;
    dialog.style.setProperty('--heating-explorer-control-scroll-margin', heading.style.scrollMarginTop);
    // A closed advanced fold can leave too little content below the heading
    // for start alignment. Reserve only the missing scroll room, even if the
    // extra content grows an auto-sized dialog to its maximum height.
    dialog.style.setProperty('--heating-explorer-scroll-tail', '0px');
    const top = dialog.scrollTop + heading.getBoundingClientRect().top - header.getBoundingClientRect().bottom - 24;
    const maximumHeight = Number.parseFloat(document.defaultView.getComputedStyle(dialog).maxHeight);
    const height = Number.isFinite(maximumHeight) ? Math.max(dialog.clientHeight, maximumHeight) : dialog.clientHeight;
    dialog.style.setProperty('--heating-explorer-scroll-tail', `${Math.max(0, Math.ceil(top + height - dialog.scrollHeight))}px`);
    heading.scrollIntoView({ block: 'start' });
    focus?.focus({ preventScroll: true });
  }
  function timeline(id, summary) {
    const list = $(id); list.replaceChildren();
    const phases = summary?.phases?.length ? summary.phases : [{ phase: summary?.phase ?? 'normal', start: null, end: null }];
    for (const phase of phases) {
      const item = element('li'); item.dataset.phase = phase.phase;
      const title = element('strong', phaseName(phase.phase));
      const sameDate = Number.isFinite(phase.start) && Number.isFinite(phase.end)
        && atTime(phase.start).split(',')[0] === atTime(phase.end).split(',')[0];
      const timing = element('time', Number.isFinite(phase.start) ? `${atTime(phase.start)}${Number.isFinite(phase.end) ? ` – ${sameDate ? clockFormat.format(phase.end) : atTime(phase.end)}` : ' onward'}` : 'No scheduled change');
      if (Number.isFinite(phase.start)) timing.dateTime = new Date(phase.start).toISOString();
      const description = phase.phase === 'recovery' ? 'Includes checking indoor and stored heat against Normal heating. It does not mean continuous extra heating. Completion time is an estimate.'
        : phase.phase === 'reduction' ? 'Reduced space-heating demand; protection and required services remain.'
          : phase.phase === 'preheat' ? 'Builds warmth ahead of the reduction, within average limits.'
            : 'Normal heating demand.';
      item.append(title, timing, element('small', description)); list.append(item);
    }
  }
  function renderControls(result) {
    controls.clear(); $('heating-explorer-controls').replaceChildren();
    $('heating-explorer-advanced-controls').replaceChildren();
    $('heating-explorer-learning-controls').replaceChildren();
    $('heating-explorer-learning-heading').replaceChildren();
    const order = ['savingsStrategy', 'preheatRoomBoostC', 'maxDropC', 'maxRiseC', 'maxReductionHours', 'maxAwayReductionHours', 'maxPreheatHours', 'minimumHomeBenefitCents', 'homeDiscomfortCentsPerDegreeSquaredHour', 'cycleStartCostCents', 'cycleHourCostCents', 'economicUncertaintyFloorCents', 'maxUnobservedReductionHours', 'learningTrials', 'maxTrialCostCents', 'learningPriorityPriceCents'];
    const orderedControls = [...(result.controls ?? [])].sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
    for (const control of orderedControls) {
      if (control.type === 'checkbox') {
        const input = element('input'); input.type = 'checkbox'; input.id = `heating-limit-${control.key}`;
        input.checked = control.value === true;
        input.setAttribute('aria-describedby', 'heating-explorer-learning-context');
        input.addEventListener('input', () => actions.edit(control.key, input.checked));
        const label = element('label', null, 'heating-explorer-learning-toggle'); label.htmlFor = input.id;
        label.append(input, element('span', control.label));
        const explanation = element('span', null, 'heating-explorer-control-help');
        const trigger = setStatusDetail(explanation, { label: 'ⓘ', title: control.label, detail: control.help,
          key: `heating-explorer-control:${control.key}` });
        if (trigger) trigger.setAttribute('aria-label', `Explain ${control.label}`);
        const heading = element('span', null, 'heating-explorer-learning-heading'); heading.append(label, explanation);
        $('heating-explorer-learning-heading').append(heading);
        controls.set(control.key, { input, row: $('heating-explorer-learning'), control });
        continue;
      }
      const row = element('div', null, 'heating-explorer-control');
      row.dataset.key = control.key;
      const label = element('label', control.label); const id = `heating-limit-${control.key}`; label.htmlFor = id;
      const heading = element('div', null, 'heating-explorer-control-label');
      const explanation = element('span', null, 'heating-explorer-control-help');
      const trigger = setStatusDetail(explanation, { label: 'ⓘ', title: control.label, detail: control.help,
        key: `heating-explorer-control:${control.key}` });
      if (trigger) trigger.setAttribute('aria-label', `Explain ${control.label}`);
      heading.append(label, explanation);
      const input = element(control.options ? 'select' : 'input'); input.id = id;
      const wrapper = element('div', null, 'heating-explorer-control-input');
      if (control.unit) wrapper.dataset.unit = control.unit;
      if (control.options) for (const option of control.options) {
        const node = element('option', option.label); node.value = option.value; input.append(node);
      } else {
        input.type = 'number'; input.inputMode = 'decimal'; input.required = true;
        for (const key of ['min', 'max', 'step']) if (Number.isFinite(control[key])) input[key] = String(control[key]);
        if (control.integer !== true && control.key !== 'preheatRoomBoostC') input.step = 'any';
      }
      input.value = String(control.value);
      input.setAttribute('aria-describedby', `${id}-current`);
      input.addEventListener('input', () => actions.edit(control.key, control.options ? input.value : input.value === '' ? null : Number(input.value)));
      wrapper.append(input);
      if (control.unit) wrapper.append(element('span', control.unit));
      const current = control.options?.find(option => option.value === control.value)?.label ?? decimal(control.value);
      const effectiveDiffers = control.effectiveValue != null && control.effectiveValue !== control.value;
      const effective = control.options?.find(option => option.value === control.effectiveValue)?.label ?? decimal(control.effectiveValue);
      const help = element('small', `Configured: ${current}${control.unit ? ` ${control.unit}` : ''}${effectiveDiffers ? ` · Active cycle: ${effective}${control.unit ? ` ${control.unit}` : ''}` : ''}`); help.id = `${id}-current`;
      row.append(heading, wrapper, help);
      $(['maxTrialCostCents', 'learningPriorityPriceCents'].includes(control.key) ? 'heating-explorer-learning-controls'
        : control.advanced ? 'heating-explorer-advanced-controls' : 'heating-explorer-controls').append(row);
      controls.set(control.key, { input, row, control });
    }
    $('heating-explorer-reset').textContent = 'Reset to captured baseline';
  }
  function renderConstraints(result) {
    const list = $('heating-explorer-constraints'); list.replaceChildren();
    const labels = { blocking: 'Limits this search', limiting: 'Limits this search', reached: 'Reached',
      initial: 'Initial estimate', learning: 'Learning', unknown: 'Not assessable' };
    for (const constraint of result.constraints ?? []) {
      const item = element('li', null, 'heating-explorer-constraint'); item.dataset.status = constraint.status;
      const head = element('div', null, 'heating-explorer-constraint-head');
      const value = Number.isFinite(constraint.value) ? ` · ${decimal(constraint.value)}${constraint.unit ? ` ${constraint.unit}` : ''}`
        : constraint.key === 'normalReference' ? ' · Unavailable' : '';
      const availableLabel = constraint.kind === 'policy' ? 'Within limit'
        : constraint.kind === 'evidence' ? 'Observed support' : 'Available';
      head.append(element('strong', `${constraint.label}${value}`), element('span',
        constraint.status === 'available' ? availableLabel : labels[constraint.status] ?? 'Not assessable', 'heating-explorer-constraint-status'));
      item.append(head, element('p', constraint.detail));
      for (const diagnostic of constraint.diagnostics ?? []) {
        if (!Number.isFinite(diagnostic.value)) continue;
        item.append(element('p', `Indoor average${Number.isFinite(diagnostic.at) ? ` · ${atTime(diagnostic.at)}` : ''}${Number.isFinite(diagnostic.value) ? ` · ${decimal(diagnostic.value)} ${diagnostic.unit ?? ''}` : ''}${Number.isFinite(diagnostic.limit) ? ` / limit ${decimal(diagnostic.limit)} ${diagnostic.unit ?? ''}` : ''}`));
      }
      list.append(item);
    }
    if (!list.children.length) list.append(element('li', 'Constraint diagnostics are not available for these conditions.', 'muted'));
    const opportunities = $('heating-explorer-opportunities'); opportunities.replaceChildren();
    for (const opportunity of result.opportunities ?? []) {
      const card = element('div', null, 'heating-explorer-opportunity');
      card.append(element('h4', opportunity.title), element('p', opportunity.detail));
      const changed = Object.entries(opportunity.overrides ?? {}).map(([key, value]) => {
        const control = result.controls?.find(control => control.key === key);
        return `${control?.label ?? humanize(key)} ${decimal(value)}${control?.unit ? ` ${control.unit}` : ''}`;
      }).join(' · ');
      card.append(element('p', `${Number.isFinite(opportunity.additionalBenefitCents) ? `${money(opportunity.additionalBenefitCents)} additional estimated saving. ` : ''}${changed}`));
      if (opportunity.evidence) card.append(element('p', opportunity.evidence, 'muted'));
      if (opportunity.overrides && Object.keys(opportunity.overrides).length) {
        const button = element('button', 'Explore these limits', 'secondary-button'); button.type = 'button';
        button.addEventListener('click', () => {
          for (const [key, value] of Object.entries(opportunity.overrides)) actions.edit(key, value);
          scrollToLimits($('heating-explorer-calculate'));
        }); card.append(button);
      }
      opportunities.append(card);
    }
    $('heating-explorer-opportunities-section').hidden = !opportunities.children.length;
  }
  function renderChart(result) {
    const series = [result.current?.trajectory ?? [], result.scenario?.trajectory ?? []].map(points => points.filter(point => Number.isFinite(point.at) && Number.isFinite(point.indoorC)));
    const bands = heatingUncertaintyBands(result.scenario?.trajectory);
    const allowanceAvailable = point => Number.isFinite(point.uncertaintyC) && point.uncertaintyC >= 0;
    const uncertaintyMissing = series[1].some(point => !allowanceAvailable(point));
    const allowanceLabel = !bands.length ? 'Model uncertainty allowance unavailable'
      : uncertaintyMissing ? 'Shaded: available model uncertainty allowance; gaps are unknown'
        : 'Shaded: model uncertainty allowance';
    $('heating-explorer-chart-uncertainty').textContent = allowanceLabel;
    const figure = $('heating-explorer-chart'); figure.hidden = series.some(points => points.length < 2);
    $('heating-explorer-chart-plot').replaceChildren();
    if (figure.hidden) return;
    const all = series.flat(), start = Math.min(...all.map(point => point.at)), end = Math.max(...all.map(point => point.at));
    const width = Math.max(250, $('heating-explorer-chart-plot').clientWidth || 748), plotEnd = width - 18;
    const low = Math.floor((Math.min(...all.map(point => allowanceAvailable(point) ? point.indoorC - point.uncertaintyC : point.indoorC)) - .2) * 2) / 2;
    const high = Math.ceil((Math.max(...all.map(point => allowanceAvailable(point) ? point.indoorC + point.uncertaintyC : point.indoorC)) + .2) * 2) / 2;
    const x = at => 40 + (at - start) / Math.max(1, end - start) * (plotEnd - 40);
    const y = c => 164 - (c - low) / Math.max(.5, high - low) * 144;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} 196`); svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `Predicted indoor average for the current plan and your scenario, from ${decimal(low)} to ${decimal(high)} degrees. ${allowanceLabel}. The predicted indoor-average extremes are listed below.`);
    const part = (tag, attributes, text) => {
      const node = document.createElementNS(svg.namespaceURI, tag);
      for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
      if (text != null) node.textContent = text; svg.append(node); return node;
    };
    for (let tick = 0; tick <= 3; tick++) {
      const value = low + (high - low) * tick / 3;
      part('line', { x1: 40, x2: plotEnd, y1: y(value), y2: y(value), stroke: 'var(--grid)', 'stroke-width': 1 });
      part('text', { x: 32, y: y(value) + 4, fill: 'var(--muted)', 'text-anchor': 'end', 'font-size': 10 }, `${value.toFixed(1)}°`);
    }
    for (const points of bands) {
      const band = [...points.map(point => `${x(point.at)},${y(point.indoorC + point.uncertaintyC)}`),
        ...[...points].reverse().map(point => `${x(point.at)},${y(point.indoorC - point.uncertaintyC)}`)];
      part('polygon', { points: band.join(' '), fill: 'var(--chart-indoor)', opacity: '.12' });
    }
    series.forEach((points, index) => part('path', { d: points.map((point, i) => `${i ? 'L' : 'M'}${x(point.at).toFixed(1)},${y(point.indoorC).toFixed(1)}`).join(' '), fill: 'none', stroke: index ? 'var(--chart-indoor)' : 'var(--muted)', 'stroke-width': index ? 2.5 : 2, 'stroke-dasharray': index ? 'none' : '5 4', 'vector-effect': 'non-scaling-stroke' }));
    for (let tick = 0; tick <= 4; tick++) {
      const at = start + (end - start) * tick / 4;
      part('text', { x: x(at), y: 187, fill: 'var(--muted)', 'text-anchor': tick === 4 ? 'end' : 'middle', 'font-size': 10 }, clockFormat.format(at));
    }
    $('heating-explorer-chart-plot').append(svg);
  }
  function renderBreakdown(result) {
    const table = element('table', null, 'heating-explorer-table');
    const head = element('thead'), titles = element('tr');
    for (const title of ['Model estimate', 'Current plan', 'Your scenario']) { const th = element('th', title); th.scope = 'col'; titles.append(th); }
    head.append(titles); table.append(head); const body = element('tbody');
    const unit = (value, suffix) => Number.isFinite(value) ? `${decimal(value)} ${suffix}` : 'Unavailable';
    const room = value => value ? `${value.label ?? humanize(value.id)} · ${unit(value.valueC, '°C')}${Number.isFinite(value.at) ? ` · ${atTime(value.at)}` : ''}` : 'Unavailable';
    const fields = [
      ['Saving vs normal heating', summary => money(summary.estimatedBenefitCents)],
      ['Adverse-case saving vs normal', summary => money(summary.lowerBenefitCents)],
      ['Space-heating cost, including remaining heat debt', summary => money(summary.outcomes?.costCents)],
      ['Space-heating electricity within forecast', summary => unit(summary.outcomes?.electricityKwh, 'kWh')],
      ['Auxiliary heating electricity', summary => unit(summary.outcomes?.auxiliaryKwh, 'kWh')],
      ['Recovery cost', summary => money(summary.outcomes?.recoveryCostCents)],
      ['Recovery electricity', summary => unit(summary.outcomes?.recoveryEnergyKwh, 'kWh')],
      ['Recovery auxiliary electricity', summary => unit(summary.outcomes?.recoveryAuxKwh, 'kWh')],
      ['Estimated electricity for remaining heat debt', summary => unit(summary.outcomes?.terminalKwh, 'kWh')],
      ['Remaining deficit cost estimate', summary => money(summary.outcomes?.terminalCostCents)],
      ['Predicted recovery completion', summary => !summary.schedule ? 'Not needed'
        : summary.outcomes?.completeRecoveryPredicted === false ? 'Beyond evaluated horizon' : atTime(summary.outcomes?.recoveredAt)],
      ['Lowest indoor average', summary => room(summary.outcomes?.coldestIndoor)],
      ['Highest indoor average', summary => room(summary.outcomes?.warmestIndoor)],
      ['Maximum rise above Normal', summary => unit(summary.outcomes?.maxIndoorRiseC, '°C')],
      ['Temperature uncertainty allowance', summary => unit(summary.outcomes?.uncertaintyC, '°C')],
    ];
    for (const [label, value] of fields) {
      const row = element('tr'), title = element('th', label); title.scope = 'row';
      row.append(title, element('td', value(result.current ?? {})), element('td', value(result.scenario ?? {}))); body.append(row);
    }
    table.append(body); $('heating-explorer-breakdown').replaceChildren(table);
  }
  function renderResult(result) {
    $('heating-constraints-title').textContent = result.previewId ? 'Limits in this comparison' : 'What shapes this plan';
    $('heating-explorer-phase').textContent = phaseName(result.current?.phase ?? result.current?.action);
    $('heating-explorer-reason').textContent = reasonsText(result.current?.reasons) || 'The controller rechecks this plan as conditions change.';
    timeline('heating-explorer-timeline', result.current);
    renderConstraints(result);
    const limitations = $('heating-explorer-limitations'); limitations.replaceChildren();
    for (const limitation of result.limitations ?? []) limitations.append(element('li', limitation));
    $('heating-explorer-comparison-section').hidden = !result.previewId;
    if (!result.previewId) return;
    $('heating-explorer-comparison-summary').textContent = result.comparison?.changed
      ? 'This calculation selects a different cycle from the current plan. Compare the benefit, indoor average and recovery together.'
      : 'These limits do not change the selected plan in this comparison. Other constraints, evidence or the economic trade-off may still determine the choice.';
    $('heating-explorer-metrics').replaceChildren();
    for (const metric of heatingComparisonMetrics(result)) {
      const card = element('div', null, 'heating-explorer-metric');
      card.append(element('span', metric.label), element('strong', metric.value), element('small', metric.detail)); $('heating-explorer-metrics').append(card);
    }
    timeline('heating-explorer-scenario-timeline', result.scenario);
    $('heating-explorer-scenario-evidence').textContent = heatingEvidenceText(result.evidence);
    renderChart(result); renderBreakdown(result);
    const illustrative = result.illustrative;
    $('heating-explorer-illustrative').hidden = !illustrative;
    $('heating-explorer-illustrative').textContent = illustrative ? `Illustrative ${illustrative.schedule ? `${decimal((illustrative.schedule.reductionEnd - illustrative.schedule.reductionStart) / hour)} h reduction` : 'prediction'} only · ${illustrative.extrapolated ? 'Outside demonstrated coverage. ' : ''}${Number.isFinite(illustrative.outcomes?.maxIndoorDropC) ? `Largest predicted average drop ${decimal(illustrative.outcomes.maxIndoorDropC)} °C. ` : ''}${Number.isFinite(illustrative.estimatedBenefitCents) ? `Estimated saving vs normal heating ${money(illustrative.estimatedBenefitCents)}. ` : ''}${reasonsText(illustrative.reasons)}. This prediction cannot be applied as an automatic plan.` : '';
  }
  function render(state) {
    if (!dialog.open) return;
    const { result, busy } = state;
    $('heating-explorer-message').textContent = state.message;
    $('heating-explorer-message').dataset.error = String(state.error);
    $('heating-explorer-receipt').textContent = state.receipt?.message ?? '';
    $('heating-explorer-receipt').dataset.error = String(state.receipt?.error === true);
    $('heating-explorer-content').hidden = !result;
    $('heating-explorer-content').setAttribute('aria-busy', String(busy));
    $('heating-explorer-refresh').disabled = busy || !status || isReadOnlyReplica(status) || status.input === 'offline';
    if (!result) return;
    if (controlsSnapshot !== result.snapshotId) { renderControls(result); controlsSnapshot = result.snapshotId; }
    if (renderedResult !== result) { renderResult(result); renderedResult = result; }
    for (const [key, row] of controls) {
      const value = state.limits[key];
      if (row.control.type === 'checkbox') row.input.checked = value === true;
      else if (String(value ?? '') !== row.input.value) row.input.value = value == null ? '' : String(value);
      row.input.disabled = busy || ['maxTrialCostCents', 'learningPriorityPriceCents'].includes(key) && state.limits.learningTrials !== true;
      row.row.dataset.changed = String(value !== row.control.value);
    }
    $('heating-explorer-learning').dataset.enabled = String(state.limits.learningTrials === true);
    const contextBudget = result.learningContext?.remainingAutomaticAllowanceCents;
    const capturedLimit = controls.get('maxTrialCostCents')?.control.value;
    const budgetEdited = state.limits.maxTrialCostCents !== capturedLimit;
    const automaticPermission = result.learningContext?.automaticEnabled;
    $('heating-explorer-learning-context').textContent = [
      typeof automaticPermission === 'boolean' ? `Automatic trial permission: ${automaticPermission ? 'enabled' : 'disabled'}.` : 'Captured automatic trial permission is unavailable.',
      Number.isFinite(contextBudget) ? `Captured allowance available for a new automatic trial: ${money(contextBudget)}.` : 'Captured automatic allowance is unavailable.',
      Number.isFinite(capturedLimit) ? `Automatic per-cycle limit: ${money(capturedLimit)}.` : '',
      state.limits.learningTrials !== true ? 'These values are retained but are not used while trials are disabled.'
        : budgetEdited ? 'The edited budget supplies a separate allowance for this reviewed cycle.' : 'An unchanged budget retains the captured automatic allowance.',
    ].filter(Boolean).join(' ');
    $('heating-explorer-snapshot').textContent = `${state.stale ? 'Comparison needs refreshing' : 'Conditions pinned'} · ${atTime(result.snapshotAt)} · Europe/Helsinki`;
    $('heating-explorer-calculate').disabled = busy || state.stale;
    $('heating-explorer-calculate').textContent = busy ? 'Working' : 'Compare scenario';
    $('heating-explorer-reset').disabled = busy;
    $('heating-explorer-dirty').hidden = !state.dirty || !result.previewId;
    const context = [status?.input === 'simulated' ? 'Simulated installation: all conditions and outcomes are synthetic.' : '',
      status?.automation?.home?.enabled === false ? 'Automatic control is paused. Heating can continue. Exploring does not enable automatic control.' : '',
      result.indoorInput?.estimated ? `The captured indoor average includes an estimate for one unavailable room, retaining its configured weight.${Number.isFinite(result.indoorInput.uncertaintyC) ? ` Its starting uncertainty allowance is ±${decimal(result.indoorInput.uncertaintyC)} °C.` : ' Its uncertainty allowance is unavailable.'} This estimate adds no learning evidence.` : '',
      result.currentDiffersFromRecalculation ? 'The currently selected plan has been retained. A fresh calculation with the same limits can differ; comparisons use the selected plan.' : '',
      state.stale ? 'Conditions may have changed. Refresh before comparing or applying; this preview keeps its original inputs.' : ''].filter(Boolean).join(' ');
    $('heating-explorer-context').textContent = context; $('heating-explorer-context').hidden = !context;
    const admin = status?.webAccess?.role === 'admin';
    const canApply = admin && !busy && !state.dirty && !state.stale && !!result.previewId && result.application?.allowed === true;
    $('heating-explorer-apply').disabled = !canApply;
    $('heating-explorer-apply').hidden = !admin;
    $('heating-explorer-application-help').textContent = [!admin ? 'Family can explore. Admin sign-in is required to apply a scenario.' : '',
      result.application?.reason ?? '', result.application?.latestStartAt ? `Latest start: ${atTime(result.application.latestStartAt)}.` : '',
      result.application?.expiresAt ? `Expires: ${atTime(result.application.expiresAt)}.` : '',
      'Applies only to the reviewed cycle. Configured defaults remain unchanged; the controller can shorten or cancel the plan as conditions change.'].filter(Boolean).join(' ');
    const trial = result.activeTrial;
    $('heating-explorer-trial').hidden = !trial;
    const authorizedValues = { ...trial?.limits, ...(typeof trial?.learningTrials === 'boolean' ? { learningTrials: trial.learningTrials } : {}) };
    const authorized = Object.entries(authorizedValues).map(([key, value]) => {
      const control = result.controls.find(control => control.key === key);
      return `${control?.label ?? humanize(key)}: ${control?.options?.find(option => option.value === value)?.label ?? (typeof value === 'boolean' ? value ? 'On' : 'Off' : typeof value === 'number' ? decimal(value) : humanize(value))}${control?.unit ? ` ${control.unit}` : ''}`;
    }).join(' · ');
    const outcome = trial?.outcome;
    $('heating-explorer-trial-description').textContent = trial ? [
      `${humanize(trial.status)} · approved ${atTime(trial.approvedAt)}${trial.status === 'pending' ? ` · latest start ${atTime(trial.latestStartAt)}` : ''} · expires ${atTime(trial.expiresAt)}.`,
      authorized ? `Authorized limits: ${authorized}.` : '', trial.reason ?? '',
      outcome ? `Recorded assessment: estimated space-heating benefit ${money(outcome.profitCents)}; recovery cost forecast error ${money(outcome.recoveryErrorCents)}${Number.isFinite(outcome.uncertaintyCents) ? `; cost uncertainty ${money(outcome.uncertaintyCents)}` : ''}. The normal-heating reference remains an estimate.`
        : !validTrial(trial) ? 'A completed outcome assessment is unavailable for this cycle.' : '',
      !validTrial(trial) ? 'Review Home learning outcomes for the recorded evidence. One completed cycle alone does not establish validation.' : '',
      'Recovery and equipment restoration remain the controller’s responsibility.',
    ].filter(Boolean).join(' ') : '';
    $('heating-explorer-cancel').hidden = !admin || !validTrial(trial);
    $('heating-explorer-cancel').disabled = busy;
    if (state.stale && !wasStale) $('heating-explorer-context').setAttribute('role', 'status');
    wasStale = state.stale;
  }
  function renderRecorded() {
      const display = homePlannedChange(status);
      $('heating-explorer-content').hidden = true;
      $('heating-explorer-snapshot').textContent = 'Recorded view';
      $('heating-explorer-message').textContent = `${display.value}. ${display.detail} Live plan exploration is unavailable in this view.`;
      $('heating-explorer-message').dataset.error = 'false';
      $('heating-explorer-receipt').textContent = '';
      $('heating-explorer-refresh').disabled = true;
  }
  async function open() {
    if (dialog.open) return;
    dialog.showModal(); opener.setAttribute('aria-expanded', 'true'); $('heating-explorer-close').focus();
    if (!status || isReadOnlyReplica(status) || status.input === 'offline') {
      renderRecorded(); return;
    }
    const saved = actions.snapshot();
    render(saved);
    if (!saved.result) await actions.load();
  }
  const close = () => { if (dialog.open) dialog.close(); };
  opener.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); void open(); });
  $('heating-explorer-close').addEventListener('click', close);
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    closeStatusDetails(document);
    dialog.style.removeProperty('--heating-explorer-scroll-tail');
    opener.setAttribute('aria-expanded', 'false'); opener.focus({ preventScroll: true });
  });
  $('heating-explorer-refresh').addEventListener('click', () => { void actions.load({ preserveDraft: true }); });
  $('heating-explorer-reset').addEventListener('click', () => actions.reset());
  $('heating-explorer-jump').addEventListener('click', () => {
    const first = controls.values().next().value;
    scrollToLimits(first?.row.querySelector('.app-select-trigger') ?? first?.input);
  });
  $('heating-explorer-form').addEventListener('submit', event => { event.preventDefault(); void actions.compare(); });
  $('heating-explorer-apply').addEventListener('click', async () => {
    if (approving || status?.webAccess?.role !== 'admin') return;
    const state = actions.snapshot();
    if (state.busy || state.dirty || state.stale || !state.result?.application?.allowed) return;
    const previewId = state.result.previewId;
    approving = true;
    closeStatusDetails(document);
    try {
      const accepted = await confirm({ document, title: 'Use these limits for one cycle?',
        message: heatingApprovalText(state.result), action: 'Approve one cycle' });
      if (accepted && dialog.open && status?.webAccess?.role === 'admin'
        && actions.snapshot().result?.previewId === previewId && await actions.apply()) await afterMutation();
    } finally { approving = false; }
  });
  $('heating-explorer-cancel').addEventListener('click', async () => {
    if (status?.webAccess?.role !== 'admin') return;
    if (await actions.cancel()) await afterMutation();
  });
  const Observer = document.defaultView?.ResizeObserver;
  if (Observer) {
    const observer = new Observer(() => {
      const margin = `${dialog.querySelector('.heating-explorer-header').offsetHeight + 24}px`;
      dialog.style.setProperty('--heating-explorer-control-scroll-margin', margin);
      $('heating-explorer-comparison-section').style.scrollMarginTop = margin;
      $('heating-explorer-form').style.scrollMarginTop = margin;
      $('heating-simulator-title').style.scrollMarginTop = margin;
      if (dialog.open && renderedResult?.previewId) renderChart(renderedResult);
    });
    observer.observe(dialog);
    observer.observe(dialog.querySelector('.heating-explorer-header'));
  }
  return { open, close, actions,
    update(next) {
      const previous = status; status = next; receivedAt = Date.now();
      if (isReadOnlyReplica(next) || next?.input === 'offline' || !next) {
        const transition = !next || previous && !isReadOnlyReplica(previous) && previous.input !== 'offline';
        if (dialog.open && transition) close();
        actions.clear();
        if (dialog.open) renderRecorded();
      } else {
        if (actions.snapshot().result && previous?.decision && next.decision) {
          const signature = value => JSON.stringify({ schedule: value.decision.plan?.schedule ?? null,
            phase: value.decision.phase ?? null, trial: value.decision.plan?.userTrial?.id ?? null });
          if (signature(previous) !== signature(next)) actions.markStale();
        }
        if (Object.hasOwn(next, 'heatingScenario')) actions.updateTrial(next.heatingScenario);
        if (dialog.open) render(actions.snapshot());
      }
    },
    tick() {
      if (!dialog.open) return;
      if (!status || isReadOnlyReplica(status) || status.input === 'offline') renderRecorded();
      else actions.tick();
    },
    clear() { close(); actions.clear(); controlsSnapshot = undefined; renderedResult = undefined; },
  };
}
