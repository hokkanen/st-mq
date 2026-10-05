import { homePlannedChange } from './heating-plan.js';
import { isReadOnlyReplica } from './replica-status.js';
import { confirmAction } from './confirmation.js';
import { actionReceiptRecent } from './action-receipts.js';

const endpoint = '/api/heating/explorer';
const hour = 3_600_000;
const timeFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const clockFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', hour: '2-digit', minute: '2-digit' });
const decimal = value => Number.isFinite(value) ? new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 }).format(value) : 'Unavailable';
const money = value => Number.isFinite(value) ? `${value < 0 ? '−' : ''}€${(Math.abs(value) / 100).toFixed(2)}` : 'Unavailable';
const signed = (value, unit) => Number.isFinite(value) ? `${value > 0 ? '+' : ''}${decimal(value)}${unit}` : 'Unavailable';
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
  'room-comfort-limit': 'A monitored room is outside its temperature allowance.',
  'missing-or-stale-observations': 'Fresh temperature observations are needed.',
  'currently-selected-cycle': 'This is the cycle currently selected by the controller.',
  'normal-operation': 'Normal heating continues. No change is scheduled.',
};
const reasonsText = reasons => (reasons ?? []).map(reason => reasonLabels[reason] ?? humanize(reason)).join(' · ');
const validTrial = trial => ['pending', 'running'].includes(trial?.status);
const errorMessage = error => error?.status === 401 ? 'Your session ended. Sign in again to continue.'
  : [409, 410].includes(error?.status) ? 'This comparison is no longer current. Refresh conditions and compare again.'
    : error?.status === 429 ? 'Another comparison is running. Please try again in a moment.'
      : error?.status === 403 ? 'This action is unavailable with your current access or control authority.'
        : error?.status === 503 ? 'Current conditions or the model comparison are unavailable. Refresh conditions to try again.'
        : error?.status === 400 ? 'Check the limits and try again. The scenario was not accepted.'
          : 'The request could not be confirmed. Refresh conditions before trying again.';

/** One pinned comparison at a time; editing never sends a control request. */
export function createHeatingExplorerState({ request, clock = Date.now, onChange = () => {} }) {
  let result = null, limits = {}, busy = false, message = '', error = false, dirty = false, stale = false;
  let generation = 0;
  let receipt = null;
  const snapshot = () => ({ result, limits: { ...limits }, busy, message, error, dirty,
    receipt: actionReceiptRecent(receipt?.at, clock()) ? receipt : null,
    stale: stale || !!result && Number.isFinite(result.expiresAt) && clock() >= result.expiresAt });
  const notify = () => onChange(snapshot());
  async function run(path, body, { reset = false, mutation = false } = {}) {
    if (busy) return false;
    const ownGeneration = ++generation;
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
        result = next; stale = false; dirty = false;
        if (reset) limits = Object.fromEntries((next.controls ?? []).map(control => [control.key, control.value]));
        message = reset ? '' : 'Comparison ready. Live settings are unchanged.';
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
    load: () => run(endpoint, undefined, { reset: true }),
    edit(key, value) {
      if (busy || !result?.controls?.some(control => control.key === key)) return;
      limits[key] = value; dirty = true; notify();
    },
    reset() {
      if (busy || !result) return;
      limits = Object.fromEntries(result.controls.map(control => [control.key, control.value])); dirty = true; notify();
    },
    compare() {
      if (!result || snapshot().stale) return Promise.resolve(false);
      const changes = Object.fromEntries(result.controls.filter(control => limits[control.key] !== control.value)
        .map(control => [control.key, limits[control.key]]));
      return run(`${endpoint}/simulate`, { snapshotId: result.snapshotId, limits: changes });
    },
    apply() {
      if (!result?.previewId || !result.application?.allowed || dirty || snapshot().stale) return Promise.resolve(false);
      return run(`${endpoint}/apply`, { previewId: result.previewId }, { mutation: true });
    },
    cancel: () => validTrial(result?.activeTrial) ? run(`${endpoint}/cancel`, {}, { mutation: true }) : Promise.resolve(false),
    markStale() { if (result && !stale) { stale = true; notify(); } },
    updateTrial(trial) {
      if (result && JSON.stringify(trial) !== JSON.stringify(result.activeTrial)) {
        result = { ...result, activeTrial: trial }; notify();
      }
    },
    tick: notify,
    clear() { ++generation; result = null; limits = {}; busy = false; message = ''; error = false; dirty = false; stale = false; receipt = null; notify(); },
  };
}

export function heatingComparisonMetrics(result) {
  const current = result.current ?? {}, scenario = result.scenario ?? {}, comparison = result.comparison ?? {};
  return [
    { label: 'Additional estimated saving', value: money(comparison.additionalBenefitCents),
      detail: 'Compared with the current plan, over the evaluated cycle.' },
    { label: 'Largest room temperature drop', value: Number.isFinite(scenario.outcomes?.maxRoomDropC) ? `${decimal(scenario.outcomes.maxRoomDropC)} °C` : 'Unavailable',
      detail: Number.isFinite(current.outcomes?.maxRoomDropC) ? `Current plan ${decimal(current.outcomes.maxRoomDropC)} °C · change ${signed(comparison.additionalRoomDropC, ' °C')}` : 'No supported room estimate for the current plan.' },
    { label: 'Chosen reduction duration', value: Number.isFinite(scenario.schedule?.reductionStart) && Number.isFinite(scenario.schedule?.reductionEnd)
      ? `${decimal((scenario.schedule.reductionEnd - scenario.schedule.reductionStart) / hour)} h` : 'No reduction',
      detail: scenario.trial ? 'Bounded learning trial; evidence gates still apply.' : 'A maximum is permission, not a requested duration.' },
  ];
}

export function createHeatingExplorerPanel({ document, request, afterMutation = () => {}, confirm = confirmAction }) {
  const $ = id => document.getElementById(id);
  const dialog = $('heating-explorer-dialog'), opener = $('home-planned-change');
  let status, receivedAt = Date.now(), renderedResult, controlsSnapshot, wasStale = false;
  const controls = new Map();
  const now = () => Number.isFinite(status?.now) ? status.now + Math.max(0, Date.now() - receivedAt) : Date.now();
  const actions = createHeatingExplorerState({ request, clock: now, onChange: render });
  const element = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
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
      const description = phase.phase === 'recovery' ? 'Returns toward normal warmth. Completion time is an estimate.'
        : phase.phase === 'reduction' ? 'Reduced space-heating demand; protection and required services remain.'
          : phase.phase === 'preheat' ? 'Builds warmth ahead of the reduction, within room limits.'
            : 'Normal heating demand.';
      item.append(title, timing, element('small', description)); list.append(item);
    }
  }
  function renderControls(result) {
    controls.clear(); $('heating-explorer-controls').replaceChildren();
    const order = ['savingsStrategy', 'preheatRoomBoostC', 'maxDropC', 'maxRiseC', 'maxReductionHours', 'maxAwayReductionHours', 'maxPreheatHours'];
    const orderedControls = [...(result.controls ?? [])].sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
    for (const control of orderedControls) {
      const row = element('div', null, 'heating-explorer-control');
      const label = element('label', control.label); const id = `heating-limit-${control.key}`; label.htmlFor = id;
      const input = element(control.options ? 'select' : 'input'); input.id = id;
      const wrapper = element('div', null, 'heating-explorer-control-input');
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
      const help = element('small', `${effectiveDiffers ? 'Configured' : 'Current'}: ${current}${control.unit ? ` ${control.unit}` : ''}${effectiveDiffers ? ` · Active cycle: ${effective}${control.unit ? ` ${control.unit}` : ''}` : ''}`); help.id = `${id}-current`;
      row.append(label, wrapper, help);
      $('heating-explorer-controls').append(row);
      controls.set(control.key, { input, row, control });
    }
    $('heating-explorer-reset').textContent = result.controls.some(control => control.effectiveValue != null && control.effectiveValue !== control.value)
      ? 'Reset to configured limits' : 'Reset to current limits';
  }
  function renderConstraints(result) {
    const list = $('heating-explorer-constraints'); list.replaceChildren();
    const labels = { blocking: 'Limits this search', reached: 'Reached', available: 'Within limit', unknown: 'Not assessable' };
    for (const constraint of result.constraints ?? []) {
      const item = element('li', null, 'heating-explorer-constraint'); item.dataset.status = constraint.status;
      const head = element('div', null, 'heating-explorer-constraint-head');
      const value = Number.isFinite(constraint.value) ? ` · ${decimal(constraint.value)}${constraint.unit ? ` ${constraint.unit}` : ''}` : '';
      head.append(element('strong', `${constraint.label}${value}`), element('span', labels[constraint.status] ?? 'Not assessable', 'heating-explorer-constraint-status'));
      item.append(head, element('p', constraint.detail));
      for (const diagnostic of constraint.diagnostics ?? []) {
        if (!diagnostic.roomId) continue;
        item.append(element('p', `${humanize(diagnostic.roomId)}${Number.isFinite(diagnostic.at) ? ` · ${atTime(diagnostic.at)}` : ''}${Number.isFinite(diagnostic.value) ? ` · ${decimal(diagnostic.value)} ${diagnostic.unit ?? ''}` : ''}${Number.isFinite(diagnostic.limit) ? ` / limit ${decimal(diagnostic.limit)} ${diagnostic.unit ?? ''}` : ''}`));
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
          $('heating-explorer-form').scrollIntoView({ block: 'nearest' }); $('heating-explorer-calculate').focus({ preventScroll: true });
        }); card.append(button);
      }
      opportunities.append(card);
    }
    $('heating-explorer-opportunities-section').hidden = !opportunities.children.length;
  }
  function renderChart(result) {
    const series = [result.current?.trajectory ?? [], result.scenario?.trajectory ?? []].map(points => points.filter(point => Number.isFinite(point.at) && Number.isFinite(point.indoorC)));
    const figure = $('heating-explorer-chart'); figure.hidden = series.some(points => points.length < 2);
    $('heating-explorer-chart-plot').replaceChildren();
    if (figure.hidden) return;
    const all = series.flat(), start = Math.min(...all.map(point => point.at)), end = Math.max(...all.map(point => point.at));
    const width = Math.max(250, $('heating-explorer-chart-plot').clientWidth || 748), plotEnd = width - 18;
    const low = Math.floor((Math.min(...all.map(point => point.indoorC - (point.uncertaintyC ?? 0))) - .2) * 2) / 2;
    const high = Math.ceil((Math.max(...all.map(point => point.indoorC + (point.uncertaintyC ?? 0))) + .2) * 2) / 2;
    const x = at => 40 + (at - start) / Math.max(1, end - start) * (plotEnd - 40);
    const y = c => 164 - (c - low) / Math.max(.5, high - low) * 144;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} 196`); svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `Predicted indoor average for the current plan and your scenario, from ${decimal(low)} to ${decimal(high)} degrees. Individual room extremes are listed below.`);
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
    const band = [...series[1].map(point => `${x(point.at)},${y(point.indoorC + (point.uncertaintyC ?? 0))}`),
      ...[...series[1]].reverse().map(point => `${x(point.at)},${y(point.indoorC - (point.uncertaintyC ?? 0))}`)];
    part('polygon', { points: band.join(' '), fill: 'var(--chart-indoor)', opacity: '.12' });
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
      ['Remaining thermal deficit', summary => unit(summary.outcomes?.terminalKwh, 'kWh')],
      ['Remaining deficit cost estimate', summary => money(summary.outcomes?.terminalCostCents)],
      ['Predicted recovery completion', summary => summary.outcomes?.completeRecoveryPredicted === false ? 'Beyond evaluated horizon' : atTime(summary.outcomes?.recoveredAt)],
      ['Coldest monitored room', summary => room(summary.outcomes?.coldestRoom)],
      ['Warmest monitored room', summary => room(summary.outcomes?.warmestRoom)],
      ['Largest room temperature rise', summary => unit(summary.outcomes?.maxRoomRiseC, '°C')],
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
      ? 'The changed limits produce a different evaluated plan. Compare the benefit, room temperatures and recovery together.'
      : 'These limits do not change the selected plan in this comparison. Other constraints, evidence or the economic trade-off may still determine the choice.';
    $('heating-explorer-metrics').replaceChildren();
    for (const metric of heatingComparisonMetrics(result)) {
      const card = element('div', null, 'heating-explorer-metric');
      card.append(element('span', metric.label), element('strong', metric.value), element('small', metric.detail)); $('heating-explorer-metrics').append(card);
    }
    timeline('heating-explorer-scenario-timeline', result.scenario);
    const evidence = result.evidence ?? {};
    $('heating-explorer-scenario-evidence').textContent = [evidence.actionValidated ? 'Execution evidence is available for this comparison.' : 'Evidence limits still apply to execution.',
      Number.isFinite(evidence.validatedReductionHours) ? `Demonstrated reduction duration: ${decimal(evidence.validatedReductionHours)} h.` : '',
      reasonsText(evidence.reasons), 'The best evaluated alternative is not a guarantee of the global optimum.'].filter(Boolean).join(' ');
    renderChart(result); renderBreakdown(result);
    const illustrative = result.illustrative;
    $('heating-explorer-illustrative').hidden = !illustrative;
    $('heating-explorer-illustrative').textContent = illustrative ? `Illustrative ${illustrative.schedule ? `${decimal((illustrative.schedule.reductionEnd - illustrative.schedule.reductionStart) / hour)} h reduction` : 'prediction'} only · ${illustrative.extrapolated ? 'Outside demonstrated coverage. ' : ''}${Number.isFinite(illustrative.outcomes?.maxRoomDropC) ? `Largest predicted room drop ${decimal(illustrative.outcomes.maxRoomDropC)} °C. ` : ''}${Number.isFinite(illustrative.estimatedBenefitCents) ? `Estimated saving vs normal heating ${money(illustrative.estimatedBenefitCents)}. ` : ''}${reasonsText(illustrative.reasons)}. This prediction cannot be applied as an automatic plan.` : '';
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
      if (String(value ?? '') !== row.input.value) row.input.value = value == null ? '' : String(value);
      row.input.disabled = busy;
      row.row.dataset.changed = String(value !== row.control.value);
    }
    $('heating-explorer-snapshot').textContent = `${state.stale ? 'Comparison needs refreshing' : 'Conditions pinned'} · ${atTime(result.snapshotAt)} · Europe/Helsinki`;
    $('heating-explorer-calculate').disabled = busy || state.stale;
    $('heating-explorer-calculate').textContent = busy ? 'Working' : 'Compare scenario';
    $('heating-explorer-reset').disabled = busy;
    $('heating-explorer-dirty').hidden = !state.dirty || !result.previewId;
    const context = [status?.input === 'simulated' ? 'Simulated installation: all conditions and outcomes are synthetic.' : '',
      status?.automation?.home?.enabled === false ? 'Automatic control is paused. Heating can continue. Exploring does not enable automatic control.' : '',
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
    const authorized = Object.entries(trial?.limits ?? {}).map(([key, value]) => {
      const control = result.controls.find(control => control.key === key);
      return `${control?.label ?? humanize(key)}: ${control?.options?.find(option => option.value === value)?.label ?? (typeof value === 'number' ? decimal(value) : humanize(value))}${control?.unit ? ` ${control.unit}` : ''}`;
    }).join(' · ');
    const outcome = trial?.outcome;
    $('heating-explorer-trial-description').textContent = trial ? [
      `${humanize(trial.status)} · approved ${atTime(trial.approvedAt)}${trial.status === 'pending' ? ` · latest start ${atTime(trial.latestStartAt)}` : ''} · expires ${atTime(trial.expiresAt)}.`,
      authorized ? `Authorized limits: ${authorized}.` : '', trial.reason ?? '',
      outcome ? `Recorded assessment: estimated space-heating benefit ${money(outcome.profitCents)}; recovery cost forecast error ${money(outcome.recoveryErrorCents)}${Number.isFinite(outcome.uncertaintyCents) ? `; uncertainty allowance ${money(outcome.uncertaintyCents)}` : ''}. The normal-heating reference remains an estimate.`
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
    render(actions.snapshot()); await actions.load();
  }
  const close = () => { if (dialog.open) dialog.close(); };
  opener.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); void open(); });
  $('heating-explorer-close').addEventListener('click', close);
  dialog.addEventListener('close', () => { opener.setAttribute('aria-expanded', 'false'); opener.focus({ preventScroll: true }); });
  $('heating-explorer-refresh').addEventListener('click', () => { void actions.load(); });
  $('heating-explorer-reset').addEventListener('click', () => actions.reset());
  $('heating-explorer-jump').addEventListener('click', () => {
    $('heating-explorer-form').scrollIntoView({ block: 'center' });
    controls.values().next().value?.input.focus({ preventScroll: true });
  });
  $('heating-explorer-form').addEventListener('submit', event => { event.preventDefault(); void actions.compare(); });
  $('heating-explorer-apply').addEventListener('click', async () => {
    if (status?.webAccess?.role !== 'admin') return;
    const state = actions.snapshot();
    if (state.busy || state.dirty || state.stale || !state.result?.application?.allowed) return;
    const accepted = await confirm({ document, title: 'Use these limits for one cycle?',
      message: `The reviewed limits apply only to this cycle${state.result.application.expiresAt ? ` and expire by ${atTime(state.result.application.expiresAt)}` : ''}. The controller rechecks evidence and room limits, and may shorten or cancel the cycle. Configured defaults remain unchanged.`, action: 'Approve one cycle' });
    if (accepted && await actions.apply()) await afterMutation();
  });
  $('heating-explorer-cancel').addEventListener('click', async () => {
    if (status?.webAccess?.role !== 'admin') return;
    if (await actions.cancel()) await afterMutation();
  });
  const Observer = document.defaultView?.ResizeObserver;
  if (Observer) new Observer(() => {
    const margin = `${dialog.querySelector('.heating-explorer-header').offsetHeight + 24}px`;
    $('heating-explorer-comparison-section').style.scrollMarginTop = margin;
    $('heating-explorer-form').style.scrollMarginTop = margin;
    if (dialog.open && renderedResult?.previewId) renderChart(renderedResult);
  }).observe(dialog);
  return { open, close, actions,
    update(next) {
      const previous = status; status = next; receivedAt = Date.now();
      if (isReadOnlyReplica(next) || next?.input === 'offline' || !next) {
        const transition = !next || previous && !isReadOnlyReplica(previous) && previous.input !== 'offline';
        if (dialog.open && transition) close();
        actions.clear();
        if (dialog.open) renderRecorded();
      } else {
        if (Object.hasOwn(next, 'heatingScenario')) actions.updateTrial(next.heatingScenario);
        if (dialog.open) render(actions.snapshot());
      }
    },
    tick() { if (dialog.open) actions.tick(); },
    clear() { close(); actions.clear(); controlsSnapshot = undefined; renderedResult = undefined; },
  };
}
