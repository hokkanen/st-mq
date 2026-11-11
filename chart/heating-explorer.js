import { heatingReasonText } from './heating-reasons.js';
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
const reasonsText = reasons => (reasons ?? []).map(heatingReasonText).join(' · ');
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
const selectionSignature = value => JSON.stringify({ schedule: value?.schedule ?? null,
  phase: value?.phase ?? null, trial: value?.approvalId ?? null });
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
  let confirmedTrial = null;
  let expectedSelection = null;
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
    busy = true; error = false; message = mutation ? path.endsWith('/cancel') ? 'Cancelling cycle approval…' : 'Approving heating cycle…'
      : reset ? 'Loading current conditions…' : 'Comparing your scenario…'; notify();
    try {
      const next = await request(path, body);
      if (generation !== ownGeneration) return false;
      if (mutation) {
        confirmedTrial = next.activeTrial;
        ++trialRevision; ++freshnessRevision;
        result = { ...result, previewId: null, activeTrial: next.activeTrial,
          application: { allowed: false, reason: 'Updating the selected plan…' } };
        message = path.endsWith('/cancel') ? 'Cycle approval cancelled. Any required recovery and restoration still continue.'
          : 'Heating cycle approved. Its reviewed limits apply only to that cycle. The controller rechecks current conditions before execution.';
        if (next.reconciliationPending) message += ' The controller update is still pending; the saved action succeeded.';
        receipt = { at: clock(), message }; message = '';
        dirty = true; stale = true;
      } else {
        const activeTrial = result?.activeTrial;
        result = capturedTrialRevision === trialRevision ? next : { ...next, activeTrial };
        stale = capturedFreshnessRevision !== freshnessRevision && (expectedSelection !== selectionSignature(result.current)
          || capturedTrialRevision !== trialRevision && JSON.stringify(next.activeTrial) !== JSON.stringify(activeTrial));
        dirty = false;
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
    async compare() {
      if (busy || !result) return false;
      if (snapshot().stale && !await run(endpoint, undefined, { reset: true, preserveDraft: true })) return false;
      if (!result || snapshot().stale) return false;
      const changes = Object.fromEntries((baseline?.controls ?? result.controls)
        .filter(control => limits[control.key] !== control.value
          && (!['maxTrialCostCents', 'learningPriorityPriceCents'].includes(control.key) || limits.learningTrials === true))
        .map(control => [control.key, limits[control.key]]));
      return run(`${endpoint}/simulate`, { snapshotId: result.snapshotId, limits: changes });
    },
    async apply() {
      if (!result?.previewId || !result.application?.allowed || dirty || snapshot().stale) return Promise.resolve(false);
      const approved = await run(`${endpoint}/apply`, { previewId: result.previewId }, { mutation: true });
      if (approved && result) await run(endpoint, undefined, { reset: true, preserveDraft: true });
      return approved;
    },
    async cancel() {
      if (busy || !validTrial(result?.activeTrial)) return false;
      const cancelled = await run(`${endpoint}/cancel`, { approvalId: result.activeTrial.id }, { mutation: true });
      if (cancelled && result) await run(endpoint, undefined, { reset: true, preserveDraft: true });
      return cancelled;
    },
    markStale(selected) {
      if (result) { expectedSelection = selected ? selectionSignature(selected) : null; ++freshnessRevision; stale = true; notify(); }
    },
    updateTrial(trial) {
      const current = result?.activeTrial;
      const changedAt = value => Math.max(value?.approvedAt ?? 0, value?.startedAt ?? 0, value?.endedAt ?? 0);
      if (current && (trial && changedAt(trial) < changedAt(current)
        || !trial && confirmedTrial?.id === current.id)) return;
      if (result && JSON.stringify(trial) !== JSON.stringify(result.activeTrial)) {
        ++trialRevision;
        if (trial?.id !== current?.id || trial?.status !== current?.status) { ++freshnessRevision; stale = true; }
        result = { ...result, activeTrial: trial }; notify();
      }
    },
    tick: notify,
    clear() { ++generation; result = null; baseline = null; limits = {}; edited.clear(); busy = false; message = ''; error = false; dirty = false; stale = false; receipt = null; confirmedTrial = null; expectedSelection = null; notify(); },
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
    result.application?.replacesApprovalId ? 'This replaces the previously approved cycle that has not started. The previous approval ends only if this new approval succeeds.' : '',
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
      ? `${decimal((scenario.schedule.reductionEnd - scenario.schedule.reductionStart) / hour)} h` : scenario.schedule ? 'Unavailable' : 'No reduction',
      detail: scenario.trial ? 'Learning trial within the scenario budget and temperature limits.' : 'A maximum is permission, not a requested duration.' },
  ];
}

export function heatingTrialDetails(result) {
  const trial = result.activeTrial;
  if (!trial) return null;
  const active = validTrial(trial), outcome = trial.outcome;
  const matchesCurrent = !!trial.id && trial.id === result.current?.approvalId;
  const endedAfterCapture = Number.isFinite(trial.endedAt) && Number.isFinite(result.snapshotAt) && trial.endedAt > result.snapshotAt;
  const values = { ...trial.limits, ...(typeof trial.learningTrials === 'boolean' ? { learningTrials: trial.learningTrials } : {}) };
  return {
    active, matchesCurrent,
    title: active ? 'Approved heating cycle' : 'Last approved heating cycle',
    caption: `Approved ${atTime(trial.approvedAt)}. ${matchesCurrent
      ? active ? 'This approval belongs to the selected plan captured above.'
        : endedAfterCapture ? 'This approval ended after the plan above was captured. Refresh conditions to update that plan.'
          : 'This approval is no longer active. The captured plan belongs to that cycle; recovery and restoration remain independent.'
      : active ? 'This approval is separate from the selected plan in this capture. Refresh conditions to update that plan.'
        : 'Historical approval record. Its limits and outcome do not describe the selected plan above.'}`,
    status: ({ pending: 'Awaiting start', running: 'In progress', completed: 'Completed', cancelled: 'Cancelled',
      expired: 'Expired', interrupted: 'Interrupted', rejected: 'Rejected' })[trial.status] ?? 'Status unavailable',
    dates: [
      ['Approved', atTime(trial.approvedAt)],
      ...(trial.status === 'pending' ? [['Latest start', atTime(trial.latestStartAt)]] : []),
      ...(Number.isFinite(trial.startedAt) ? [['Started', atTime(trial.startedAt)]] : []),
      ...(Number.isFinite(trial.endedAt) ? [['Ended', atTime(trial.endedAt)]] : []),
      ['Authorization deadline', atTime(trial.expiresAt)],
    ],
    reason: trial.reason ? heatingReasonText(trial.reason)
      : trial.status === 'pending' ? 'Approved for one cycle. The controller will recheck conditions before starting.'
        : trial.status === 'running' ? 'The approved cycle is in progress. Current readiness and temperature limits still apply.' : '',
    limits: Object.entries(values).map(([key, value]) => {
      const control = result.controls?.find(control => control.key === key);
      const shown = control?.options?.find(option => option.value === value)?.label
        ?? (typeof value === 'boolean' ? value ? 'On' : 'Off' : typeof value === 'number' ? decimal(value) : humanize(value));
      return [control?.label ?? humanize(key), `${shown}${control?.unit ? ` ${control.unit}` : ''}`];
    }),
    assessment: outcome ? Number.isFinite(outcome.profitCents)
      ? 'Based on recorded operation and an estimated Normal heating reference.'
      : outcome.basis === 'unassessed-indoor-observation-gap'
        ? 'The cycle ended using conservative control estimates. Gaps in indoor observations prevent assessment of savings and physical recovery.'
        : 'A savings assessment is unavailable. Recorded operation alone does not establish savings.'
      : active ? 'Available after the cycle and recovery, if recorded evidence is sufficient.'
        : 'No complete outcome assessment is available. Savings remain unassessed.',
    metrics: outcome ? [
      [outcome.profitCents < 0 ? 'Estimated extra cost' : 'Estimated space-heating saving',
        money(Number.isFinite(outcome.profitCents) ? Math.abs(outcome.profitCents) : null)],
      ['Recovery cost forecast error', money(outcome.recoveryErrorCents)],
      ['Cost uncertainty', money(outcome.uncertaintyCents)],
    ] : [],
  };
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
  let status, receivedAt = Date.now(), renderedResult, controlsSnapshot, renderedTrialId, wasStale = false, approving = false;
  const controls = new Map();
  const now = () => Number.isFinite(status?.now) ? status.now + Math.max(0, Date.now() - receivedAt) : Date.now();
  const actions = createHeatingExplorerState({ request, clock: now, onChange: render });
  const element = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const setText = (id, value) => {
    const node = $(id);
    if (node.textContent !== value) node.textContent = value;
  };
  function facts(id, rows) {
    const list = $(id);
    list.replaceChildren(...rows.map(([label, value]) => {
      const row = element('div'); row.append(element('dt', label), element('dd', value)); return row;
    }));
    list.hidden = !rows.length;
  }
  function renderTrial(result) {
    const trial = heatingTrialDetails(result);
    $('heating-explorer-trial').hidden = !trial;
    if (!trial) { renderedTrialId = undefined; return; }
    if (renderedTrialId !== result.activeTrial.id) {
      $('heating-explorer-trial-record').open = trial.active;
      renderedTrialId = result.activeTrial.id;
    }
    $('heating-explorer-trial-title').textContent = trial.title;
    $('heating-explorer-trial-caption').textContent = trial.caption;
    $('heating-explorer-trial-status').textContent = trial.status;
    $('heating-explorer-trial').dataset.status = result.activeTrial.status;
    facts('heating-explorer-trial-dates', trial.dates);
    $('heating-explorer-trial-description').textContent = trial.reason;
    $('heating-explorer-trial-description').hidden = !trial.reason;
    $('heating-explorer-trial-outcome-summary').textContent = trial.assessment;
    facts('heating-explorer-trial-outcome', trial.metrics);
    facts('heating-explorer-trial-values', trial.limits);
    $('heating-explorer-trial-limits').hidden = !trial.limits.length;
  }
  function viewApproval() {
    $('heating-explorer-trial-record').open = true;
    $('heating-explorer-trial').scrollIntoView({ block: 'start' });
    $('heating-explorer-trial-record').querySelector('summary').focus({ preventScroll: true });
  }
  function timeline(id, summary) {
    const list = $(id); list.replaceChildren();
    const phases = summary?.phases?.length ? summary.phases : [{ phase: summary?.phase ?? 'normal', start: null, end: null }];
    for (const phase of phases) {
      const item = element('li'); item.dataset.phase = phase.phase;
      const title = element('strong', phaseName(phase.phase));
      const sameDate = Number.isFinite(phase.start) && Number.isFinite(phase.end)
        && atTime(phase.start).split(',')[0] === atTime(phase.end).split(',')[0];
      const timing = element('time', Number.isFinite(phase.start) ? `${atTime(phase.start)}${Number.isFinite(phase.end) ? ` – ${sameDate ? clockFormat.format(phase.end) : atTime(phase.end)}` : phase.phase === 'recovery' ? ' – completion unconfirmed' : ' onward'}` : 'No scheduled change');
      if (Number.isFinite(phase.start)) timing.dateTime = new Date(phase.start).toISOString();
      const description = phase.phase === 'recovery' ? `Includes checking indoor and stored heat against Normal heating. It does not mean continuous extra heating. ${Number.isFinite(phase.end) ? 'Completion time is an estimate.' : 'A reliable completion estimate is unavailable.'}`
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
      const help = element('small', `Configured: ${current}${control.unit ? ` ${control.unit}` : ''}${effectiveDiffers ? ` · Selected plan: ${effective}${control.unit ? ` ${control.unit}` : ''}` : ''}`); help.id = `${id}-current`;
      row.append(heading, wrapper, help);
      $(['maxTrialCostCents', 'learningPriorityPriceCents'].includes(control.key) ? 'heating-explorer-learning-controls'
        : control.advanced ? 'heating-explorer-advanced-controls' : 'heating-explorer-controls').append(row);
      controls.set(control.key, { input, row, control });
    }
    $('heating-explorer-reset').textContent = 'Reset to captured baseline';
  }
  function renderConstraints(id, constraints, { selected = false } = {}) {
    const list = $(id); list.replaceChildren();
    const labels = { blocking: 'Limits this search', limiting: 'Limits this search', reached: 'Reached',
      initial: 'Initial estimate', learning: 'Learning', unknown: 'Not assessable', configured: 'Selected limit',
      'reference-configured': 'Configured reference', 'reference-learned': 'Learned reference',
      'reference-provisional': 'Provisional learned reference', 'reference-retained': 'Retained cycle reference',
      'reference-startup': 'Initial planning reference', 'reference-simulated': 'Simulated reference',
      limited: 'Limited telemetry', unavailable: 'Not ready' };
    for (const constraint of constraints ?? []) {
      const item = element('li', null, 'heating-explorer-constraint'); item.dataset.status = constraint.status;
      const head = element('div', null, 'heating-explorer-constraint-head');
      const value = Number.isFinite(constraint.value) ? ` · ${decimal(constraint.value)}${constraint.unit ? ` ${constraint.unit}` : ''}`
        : constraint.key === 'normalReference' ? ' · Unavailable' : '';
      const availableLabel = constraint.kind === 'policy' ? 'Within limit'
        : constraint.kind === 'evidence' ? 'Observed support' : 'Available';
      head.append(element('strong', `${constraint.label}${value}`), element('span',
        constraint.key === 'normalReference' && constraint.status === 'unknown' ? Number.isFinite(constraint.value) ? 'Origin unavailable' : 'Unavailable'
          : selected && ['blocking', 'limiting'].includes(constraint.status) ? 'Evidence incomplete'
          : constraint.status === 'available' ? availableLabel : labels[constraint.status] ?? 'Not assessable', 'heating-explorer-constraint-status'));
      item.append(head, element('p', constraint.detail));
      for (const diagnostic of constraint.diagnostics ?? []) {
        if (!Number.isFinite(diagnostic.value)) continue;
        item.append(element('p', `Indoor average${Number.isFinite(diagnostic.at) ? ` · ${atTime(diagnostic.at)}` : ''}${Number.isFinite(diagnostic.value) ? ` · ${decimal(diagnostic.value)} ${diagnostic.unit ?? ''}` : ''}${Number.isFinite(diagnostic.limit) ? ` / limit ${decimal(diagnostic.limit)} ${diagnostic.unit ?? ''}` : ''}`));
      }
      list.append(item);
    }
    if (!list.children.length) list.append(element('li', 'Constraint diagnostics are not available for these conditions.', 'muted'));
  }
  function renderOpportunities(result) {
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
        const button = element('button', 'Use in scenario', 'secondary-button'); button.type = 'button';
        button.addEventListener('click', () => {
          for (const [key, value] of Object.entries(opportunity.overrides)) actions.edit(key, value);
          const first = Object.keys(opportunity.overrides).map(key => controls.get(key)).find(Boolean);
          if (!first) return;
          if ($('heating-explorer-advanced').contains(first.input)) $('heating-explorer-advanced').open = true;
          const field = first.row.querySelector('.app-select-trigger') ?? first.input;
          field.scrollIntoView({ block: 'center' });
          field.focus({ preventScroll: true });
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
    [result.current?.trajectory ?? [], result.scenario?.trajectory ?? []].forEach((points, index) => {
      let connected = false;
      const path = points.map(point => {
        if (!Number.isFinite(point.at) || !Number.isFinite(point.indoorC)) { connected = false; return ''; }
        const command = connected ? 'L' : 'M'; connected = true;
        return `${command}${x(point.at).toFixed(1)},${y(point.indoorC).toFixed(1)}`;
      }).filter(Boolean).join(' ');
      part('path', { d: path, fill: 'none', stroke: index ? 'var(--chart-indoor)' : 'var(--muted)', 'stroke-width': index ? 2.5 : 2, 'stroke-dasharray': index ? 'none' : '5 4', 'vector-effect': 'non-scaling-stroke' });
    });
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
    renderTrial(result);
    const matchingApproval = result.current?.approvalId && result.current.approvalId === result.activeTrial?.id;
    $('heating-explorer-current-source').textContent = matchingApproval
      ? `Captured from the cycle approved ${atTime(result.activeTrial.approvedAt)}. The approval record below has its latest status.`
      : result.current?.approvalId ? result.activeTrial
        ? 'This captured plan belongs to a different approval than the record below.'
        : 'This captured plan belongs to an approved cycle. Its approval record is unavailable in this capture.' : '';
    $('heating-explorer-current-source').hidden = !result.current?.approvalId;
    $('heating-explorer-view-approval').hidden = !matchingApproval;
    $('heating-explorer-phase').textContent = phaseName(result.current?.phase ?? result.current?.action);
    $('heating-explorer-reason').textContent = reasonsText(result.current?.reasons) || 'The controller rechecks this plan as conditions change.';
    timeline('heating-explorer-timeline', result.current);
    renderConstraints('heating-explorer-constraints', result.current?.constraints, { selected: true });
    const limitations = $('heating-explorer-limitations'); limitations.replaceChildren();
    for (const limitation of result.limitations ?? []) limitations.append(element('li', limitation));
    $('heating-explorer-comparison-section').hidden = !result.previewId;
    if (!result.previewId) return;
    renderConstraints('heating-explorer-scenario-constraints', result.constraints);
    setText('heating-explorer-comparison-summary', result.comparison?.changed
      ? 'This calculation selects a different cycle from the current plan. Compare the benefit, indoor average and recovery together.'
      : 'These limits do not change the selected plan in this comparison. Other constraints, evidence or the economic trade-off may still determine the choice.');
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
    $('heating-explorer-illustrative-description').textContent = illustrative ? `Illustrative ${illustrative.schedule ? `${decimal((illustrative.schedule.reductionEnd - illustrative.schedule.reductionStart) / hour)} h reduction` : 'prediction'} only · ${illustrative.extrapolated ? 'Outside demonstrated coverage. ' : ''}${Number.isFinite(illustrative.outcomes?.maxIndoorDropC) ? `Largest predicted average drop ${decimal(illustrative.outcomes.maxIndoorDropC)} °C. ` : ''}${Number.isFinite(illustrative.estimatedBenefitCents) ? `Estimated saving vs normal heating ${money(illustrative.estimatedBenefitCents)}. ` : ''}${reasonsText(illustrative.reasons)}` : '';
    const schedule = result.scenario?.schedule;
    $('heating-explorer-application-summary').textContent = Number.isFinite(schedule?.reductionStart) && Number.isFinite(schedule?.reductionEnd)
      ? `Approval is for the scenario above: ${decimal((schedule.reductionEnd - schedule.reductionStart) / hour)} h of reduction, from ${atTime(schedule.reductionStart)} to ${atTime(schedule.reductionEnd)}. The whole cycle shown above is included.`
      : 'This scenario has no cycle available for approval.';
    facts('heating-explorer-application-dates', [
      ...(Number.isFinite(result.application?.latestStartAt) ? [['Latest start', atTime(result.application.latestStartAt)]] : []),
      ...(Number.isFinite(result.application?.expiresAt) ? [['Authorization deadline', atTime(result.application.expiresAt)]] : []),
    ]);
  }
  function render(state) {
    if (!dialog.open) return;
    const { result, busy } = state;
    setText('heating-explorer-message', state.message);
    $('heating-explorer-message').dataset.error = String(state.error);
    $('heating-explorer-message').dataset.loading = String(busy && !result);
    $('heating-explorer-snapshot-bar').hidden = !result && !state.error;
    $('heating-explorer-snapshot').hidden = !result;
    $('heating-explorer-refresh').textContent = result ? 'Refresh conditions' : 'Retry loading';
    setText('heating-explorer-receipt', state.receipt?.message ?? '');
    $('heating-explorer-receipt').dataset.error = String(state.receipt?.error === true);
    $('heating-explorer-content').hidden = !result;
    $('heating-explorer-content').setAttribute('aria-busy', String(busy));
    $('heating-explorer-refresh').disabled = busy || !status || isReadOnlyReplica(status) || status.input === 'offline';
    if (!result) return;
    if (controlsSnapshot !== result.snapshotId) { renderControls(result); renderOpportunities(result); controlsSnapshot = result.snapshotId; }
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
    $('heating-explorer-snapshot').textContent = `${state.stale ? 'Plan capture needs refreshing' : 'Plan captured'} · ${atTime(result.snapshotAt)} · Europe/Helsinki`;
    $('heating-explorer-calculate').disabled = busy;
    $('heating-explorer-calculate').textContent = busy ? 'Working' : state.stale ? 'Update & compare' : 'Compare scenario';
    $('heating-explorer-reset').disabled = busy || !state.dirty && !result.previewId && !state.error;
    for (const button of $('heating-explorer-opportunities').querySelectorAll('button')) button.disabled = busy;
    $('heating-explorer-dirty').hidden = !state.dirty || !result.previewId;
    const context = [status?.input === 'simulated' ? 'Simulated installation: all conditions and outcomes are synthetic.' : '',
      status?.automation?.home?.enabled === false ? 'Automatic control is paused. Heating can continue. Exploring does not enable automatic control.' : '',
      result.indoorInput?.estimated ? `The captured indoor average includes an estimate for one unavailable room, retaining its configured weight.${Number.isFinite(result.indoorInput.uncertaintyC) ? ` Its starting uncertainty allowance is ±${decimal(result.indoorInput.uncertaintyC)} °C.` : ' Its uncertainty allowance is unavailable.'} This estimate adds no learning evidence.` : '',
      result.currentDiffersFromRecalculation ? 'The currently selected plan has been retained. A fresh calculation with the same limits can differ; comparisons use the selected plan.' : '',
      state.stale ? 'Conditions may have changed. Refresh before comparing or applying; this preview keeps its original inputs.' : ''].filter(Boolean).join(' ');
    setText('heating-explorer-context', context); $('heating-explorer-context').hidden = !context;
    const admin = status?.webAccess?.role === 'admin';
    const canApply = admin && !busy && !state.dirty && !state.stale && !!result.previewId && result.application?.allowed === true;
    $('heating-explorer-apply').disabled = !canApply;
    $('heating-explorer-apply').textContent = result.application?.replacesApprovalId ? 'Replace approved cycle' : 'Approve one cycle';
    $('heating-explorer-apply').hidden = !admin;
    $('heating-explorer-application-help').textContent = [!admin ? 'Family can explore. Admin sign-in is required to apply a scenario.' : '',
      state.stale ? 'Use Update & compare to refresh conditions and calculate your edited limits before approval.'
        : state.dirty ? 'Compare your edited limits before approval.' : result.application?.reason ?? ''].filter(Boolean).join(' ');
    const trial = result.activeTrial;
    $('heating-explorer-cancel').hidden = !admin || !validTrial(trial);
    $('heating-explorer-cancel').disabled = busy;
    if (state.stale && !wasStale) $('heating-explorer-context').setAttribute('role', 'status');
    wasStale = state.stale;
  }
  function renderRecorded() {
      const display = homePlannedChange(status);
      $('heating-explorer-content').hidden = true;
      $('heating-explorer-snapshot-bar').hidden = false;
      $('heating-explorer-snapshot').hidden = false;
      $('heating-explorer-snapshot').textContent = 'Recorded view';
      setText('heating-explorer-message', `${display.value}. ${display.detail} Live plan exploration is unavailable in this view.`);
      $('heating-explorer-message').dataset.error = 'false';
      $('heating-explorer-message').dataset.loading = 'false';
      $('heating-explorer-receipt').textContent = '';
      $('heating-explorer-refresh').disabled = true;
      $('heating-explorer-refresh').textContent = 'Refresh conditions';
  }
  async function open() {
    if (dialog.open) return;
    dialog.showModal(); opener.setAttribute('aria-expanded', 'true'); $('heating-explorer-close').focus();
    if (!status || isReadOnlyReplica(status) || status.input === 'offline') {
      renderRecorded(); return;
    }
    const saved = actions.snapshot();
    render(saved);
    if (!saved.result || saved.stale) await actions.load({ preserveDraft: true });
  }
  const close = () => { if (dialog.open) dialog.close(); };
  opener.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); void open(); });
  $('heating-explorer-close').addEventListener('click', close);
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    closeStatusDetails(document);
    opener.setAttribute('aria-expanded', 'false'); opener.focus({ preventScroll: true });
  });
  $('heating-explorer-refresh').addEventListener('click', () => { void actions.load({ preserveDraft: true }); });
  $('heating-explorer-reset').addEventListener('click', () => actions.reset());
  $('heating-explorer-view-approval').addEventListener('click', viewApproval);
  $('heating-explorer-form').addEventListener('submit', event => { event.preventDefault(); void actions.compare(); });
  $('heating-explorer-apply').addEventListener('click', async () => {
    if (approving || status?.webAccess?.role !== 'admin') return;
    const state = actions.snapshot();
    if (state.busy || state.dirty || state.stale || !state.result?.application?.allowed) return;
    const previewId = state.result.previewId;
    approving = true;
    closeStatusDetails(document);
    try {
      const replacing = !!state.result.application?.replacesApprovalId;
      const accepted = await confirm({ document, title: replacing ? 'Replace the approved heating cycle?' : 'Approve this heating cycle?',
        message: heatingApprovalText(state.result), action: replacing ? 'Replace approved cycle' : 'Approve one cycle' });
      if (accepted && dialog.open && status?.webAccess?.role === 'admin'
        && actions.snapshot().result?.previewId === previewId && await actions.apply()) {
        await afterMutation();
        if (dialog.open) viewApproval();
      }
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
          const captured = actions.snapshot().result.current;
          const capturedSignature = JSON.stringify({ schedule: captured?.schedule ?? null,
            phase: captured?.phase ?? null, trial: captured?.approvalId ?? null });
          if (signature(previous) !== signature(next) && signature(next) !== capturedSignature)
            actions.markStale({ schedule: next.decision.plan?.schedule ?? null, phase: next.decision.phase ?? null,
              approvalId: next.decision.plan?.userTrial?.id ?? null });
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
    clear() { close(); actions.clear(); controlsSnapshot = undefined; renderedResult = undefined; renderedTrialId = undefined; },
  };
}
