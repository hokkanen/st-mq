import { isReadOnlyReplica } from './replica-status.js';
import { chargingTime } from './charging.js';
import { chargingTestLocalTime, parseChargingTestTime } from './charging-test-time.js';

const terminal = run => ['completed', 'cancelled', 'interrupted'].includes(run?.phase);
const label = value => String(value ?? '').replaceAll('-', ' ');
export const chargingTestPhases = {
  armed: 'Ready to plug in', 'awaiting-vehicle-schedule': 'Review the vehicle timer',
  observing: 'Following the charging session', completed: 'Assessment complete',
  cancelled: 'Assessment cancelled', interrupted: 'Assessment interrupted',
};
const milestonesLabels = { connection: 'New physical connection', identification: 'Expected vehicle identified',
  initialPlan: 'Real charging plan recorded', vehicleSchedule: 'Vehicle timer confirmed by you',
  identifiedPlanningInputs: 'Vehicle inputs used for planning', chargingStarted: 'Physical charging started',
  chargingAfterDelay: 'Charging after the vehicle delay', planningMinimum: 'Requested minimum reached',
  vehicleTarget: 'Prepared vehicle target reached', deadline: 'Ready-by outcome', completion: 'Vehicle completion observed' };
const findingLabels = {
  'wrong-vehicle-identified': 'The controller identified a different vehicle from the one selected for this test.',
  'identified-before-vehicle-start': 'The vehicle was identified before the entered timer. Delayed identification was not exercised.',
  'charging-before-vehicle-start': 'Charging was observed before the entered vehicle start. The declaration does not prove that the car enforced its timer.',
  'identification-inconclusive': 'An identification attempt was inconclusive. A later match does not erase this result.',
  'normal-controls-changed': 'Automatic charging, Charge now or manual control changed during this assessment.',
  'ready-by-changed': 'The session ready-by time changed during this assessment.',
  'observation-gap': 'Observation was interrupted. Behavior during the missing interval could not be checked.',
  'vehicle-limit-differs-from-preparation': 'The reported vehicle limit differs from the limit entered during preparation.',
};
const endReasons = {
  'equipment-changed': 'The configured physical charger changed.',
  'backend-changed': 'The charger control backend changed.',
  'fresh-connection-not-observed': 'A new physical connection after arming could not be established.',
  'unplugged-before-completion': 'The vehicle was unplugged before completion was confirmed.',
  'physical-session-changed': 'The physical connection changed; this assessment does not follow the next vehicle.',
  'target-without-observed-charging': 'The vehicle reached its limit, but physical charging was not observed. The full charging test is unverified.',
  'vehicle-target-and-stop-observed': 'The vehicle reached its native limit and the charger was observed stopped.',
  'user-cancelled': 'The assessment ended at your request. Ordinary charging continues.',
};

/** The wizard records expectations. It has no charger command or settings API. */
export function createChargingTestsPanel({ document, request, onStatus = () => {},
  beforeRequest = () => {}, afterRequest = () => {}, openReport = () => {} }) {
  const dialog = document.createElement('dialog');
  dialog.id = 'charging-test-dialog'; dialog.className = 'control-dialog charging-test-dialog';
  dialog.setAttribute('aria-labelledby', 'charging-test-title');
  dialog.innerHTML = `<div class="charging-test-heading"><h2 id="charging-test-title">Guided charging test</h2>
    <button type="button" class="secondary-button" data-test-close aria-label="Close guided charging test">Close</button></div>
    <p class="muted">Follow a real charging session from plug-in to completion. The normal controller chooses and applies every charging period.</p>
    <div data-test-preparation>
      <form id="charging-test-form">
        <div class="charging-test-fields">
          <label>Vehicle<select name="vehicleId"><option value="bmw">BMW</option><option value="tesla">Tesla</option></select></label>
          <label>Physical charger<select name="chargerId" required><option value="">Choose a charger</option></select></label>
          <label class="charging-test-wide">Program<select name="program"><option value="immediate">Normal charging</option><option value="vehicle-schedule">Delayed vehicle schedule</option></select></label>
          <label>Battery now (%)<input name="soc" type="number" min="0" max="99" step="0.1" required></label>
          <label>Vehicle charge limit (%)<input name="nativeTargetSoc" type="number" min="1" max="100" step="0.1" required></label>
          <label class="charging-test-wide" data-test-start-label hidden>Vehicle start · <span data-test-zone></span><input name="vehicleStartAt" type="datetime-local"></label>
        </div>
        <p data-test-instructions></p>
        <p class="muted">Leave the selected charger unplugged. Enable its Automatic charging switch and clear any manual Stop or conflicting native charger schedule yourself. For a simple baseline, use the same vehicle limit as the requested charging target.</p>
        <p class="muted">Enter what you see in the vehicle. These declarations are kept in this assessment; they do not replace the controller’s battery inputs or identify the car.</p>
        <label class="charging-test-check"><input name="prepared" type="checkbox" required><span>I have checked the vehicle settings above and the selected charger is unplugged.</span></label>
        <div class="charging-test-actions"><button type="submit" data-test-preview data-write-control>Check preparation</button><button type="button" data-test-arm data-write-control disabled>Arm test</button></div>
      </form>
      <div data-test-preview-result aria-live="polite"></div>
    </div>
    <section data-test-run hidden aria-label="Test progress">
      <p class="charging-test-phase" data-test-phase role="status"></p>
      <p data-test-scope class="muted"></p><p data-test-guidance></p>
      <p data-test-headroom class="muted"></p>
      <section data-test-timer hidden aria-label="Vehicle timer adjustment">
        <p data-test-recommendation></p>
        <label>Start set in the vehicle · <span data-test-zone></span><input data-test-confirm-time type="datetime-local"></label>
        <button type="button" data-test-confirm data-write-control>I have set this time in the vehicle</button>
      </section>
      <dl class="charging-test-milestones" data-test-milestones></dl>
      <ul data-test-findings></ul><p data-test-restoration></p>
      <div class="charging-test-actions"><button type="button" class="secondary-button" data-test-report>Open session report</button>
        <button type="button" class="secondary-button" data-test-cancel data-write-control>End assessment</button>
        <button type="button" class="secondary-button" data-test-new hidden>Prepare another test</button></div>
      <p class="muted">Ending this assessment leaves ordinary charging running. Vehicle timers must be restored in the car. Closing this window does not end the test.</p>
    </section>
    <p data-test-message role="status" aria-live="polite"></p>`;
  document.body.append(dialog);
  const q = selector => dialog.querySelector(selector), form = q('form');
  const field = name => form.elements.namedItem(name);
  let status, busy = false, preview = null, checkedInput = null, selectedRun = null, opener = null, pickerKey = '', switchingDialog = false;
  const timezone = () => status?.charging?.timezone ?? 'Europe/Helsinki';
  const runs = () => status?.charging?.physicalTests?.runs ?? [];
  const manageable = () => status && !isReadOnlyReplica(status) && status.charging?.physicalTests?.canManage === true;
  const currentRun = () => runs().find(run => run.id === selectedRun);
  const make = (tag, text) => { const element = document.createElement(tag); element.textContent = text; return element; };
  function message(text = '', error = false) {
    q('[data-test-message]').textContent = text;
    q('[data-test-message]').classList.toggle('form-error', error);
  }
  function readInput() {
    const charger = status?.charging?.chargers?.find(row => row.id === field('chargerId').value);
    const input = { chargerId: field('chargerId').value, vehicleId: field('vehicleId').value,
      program: field('program').value, association: charger?.association,
      soc: Number(field('soc').value), nativeTargetSoc: Number(field('nativeTargetSoc').value), prepared: field('prepared').checked };
    if (input.program === 'vehicle-schedule') input.vehicleStartAt = parseChargingTestTime(field('vehicleStartAt').value, timezone());
    return input;
  }
  function instructions() {
    const delayed = field('program').value === 'vehicle-schedule', tesla = field('vehicleId').value === 'tesla';
    q('[data-test-start-label]').hidden = !delayed; field('vehicleStartAt').required = delayed;
    q('[data-test-instructions]').textContent = delayed
      ? `Before plugging in, set a future start in the vehicle so it will wait. ${tesla ? 'Use a Start-at-only schedule for this location, without overlapping schedules. ' : 'BMW charging windows are not currently supplied to the planner. '}`
        + 'After plug-in, this test suggests a timer adjustment using the real calculated charging periods. Early identification is valid and will be reported as coverage not exercised.'
      : 'Disable vehicle charging schedules and allow immediate charging. After arming, plug in and leave the controller to identify the vehicle, choose charging periods and observe completion.';
    for (const element of dialog.querySelectorAll('[data-test-zone]')) element.textContent = timezone();
  }
  function buttons() {
    for (const input of form.querySelectorAll('input,select')) input.disabled = busy;
    q('[data-test-preview]').disabled = busy || !manageable();
    q('[data-test-arm]').disabled = busy || !manageable() || preview?.eligible !== true;
    q('[data-test-cancel]').disabled = busy || !manageable() || !currentRun() || terminal(currentRun());
    q('[data-test-confirm]').disabled = busy || !manageable() || !currentRun()?.sessionId
      || terminal(currentRun()) || currentRun()?.recommendation?.state !== 'available';
    if (!manageable() && !busy) message('Guided tests need the live controller with permission to save an assessment. Existing reports remain readable.');
  }
  function displayPreview(value) {
    const container = q('[data-test-preview-result]'); container.replaceChildren();
    const headroom = value.headroom;
    if (Number.isFinite(headroom?.minutes)) container.append(make('p', `About ${Math.round(headroom.minutes)} minutes of active charging remain, using an assumed ${headroom.capacityKwh} kWh capacity and ${Number(headroom.powerKw).toFixed(1)} kW. Aim for at least ${headroom.minimumMinutes} minutes for this program.`));
    else container.append(make('p', 'Charging headroom cannot be estimated until battery capacity and charging power are available.'));
    const list = make('ul', ''); list.className = 'charging-test-gates';
    for (const gate of value.gates ?? []) {
      const item = make('li', `${gate.state === 'ready' ? 'Ready' : 'Needed'} · ${gate.message}`); item.dataset.state = gate.state; list.append(item);
    }
    container.append(list, make('p', 'Headroom is an estimate. Use a naturally suitable session; there is no need to charge to 100% or discharge the battery for this test.'));
  }
  function renderRun() {
    const run = currentRun();
    q('[data-test-preparation]').hidden = Boolean(run); q('[data-test-run]').hidden = !run;
    if (!run) return;
    q('[data-test-phase]').textContent = chargingTestPhases[run.phase] ?? label(run.phase);
    q('[data-test-scope]').textContent = `${run.vehicleId === 'bmw' ? 'BMW' : 'Tesla'} · ${status.charging.chargers.find(c => c.id === run.chargerId)?.label ?? run.chargerId} · ${run.program === 'immediate' ? 'Normal charging' : 'Delayed vehicle schedule'}`;
    q('[data-test-guidance]').textContent = run.phase === 'armed' ? 'Plug into the selected charger now. The assessment will attach only to that new physical connection.'
      : terminal(run) ? `${endReasons[run.endReason] ?? 'The assessment has ended.'} Review the findings and coverage below; unobserved scenarios remain unverified.`
        : 'Leave the vehicle connected. The assessment continues on the controller when this window or browser is closed.';
    q('[data-test-headroom]').textContent = `Declared starting charge ${run.expectations.soc}% · vehicle limit ${run.expectations.nativeTargetSoc}%. These are test expectations, separate from observed battery values.`;
    const timer = run.program === 'vehicle-schedule' && Boolean(run.sessionId) && !terminal(run);
    q('[data-test-timer]').hidden = !timer;
    if (timer) {
      const suggested = run.recommendation?.state === 'available' && Number.isFinite(run.recommendation.startAt)
        ? `Suggested vehicle start: ${chargingTime(run.recommendation.startAt, timezone(), status.now)}. ` : '';
      const opportunities = run.recommendation?.coverageOpportunities?.map(label).join(', ');
      q('[data-test-recommendation]').textContent = suggested + (run.recommendation?.message ?? 'Waiting for the real charging plan.')
        + (opportunities ? ` Possible coverage: ${opportunities}.` : '')
        + (Number.isFinite(run.recommendation?.estimatedFinishAt)
          ? ` Estimated target time using these real periods: ${chargingTime(run.recommendation.estimatedFinishAt, timezone(), status.now)}. The controller may revise its plan as new evidence arrives.` : '');
      const input = q('[data-test-confirm-time]');
      if (input.dataset.run !== run.id) {
        input.dataset.run = run.id; input.dataset.edited = 'false';
      }
      const suggestedTime = chargingTestLocalTime(run.recommendation?.startAt ?? run.expectations.vehicleStartAt, timezone());
      if (input.dataset.edited !== 'true' && input.value !== suggestedTime) input.value = suggestedTime;
    }
    const milestones = q('[data-test-milestones]'); milestones.replaceChildren();
    for (const [key, title] of Object.entries(milestonesLabels)) {
      if (run.program === 'immediate' && ['vehicleSchedule', 'chargingAfterDelay'].includes(key)) continue;
      const value = run.milestones?.[key];
      const detail = typeof value === 'object' && value !== null
        ? value.message ?? (value.state ? label(value.state) : Number.isFinite(value.at) ? chargingTime(value.at, timezone(), status.now) : 'Awaiting evidence')
        : Number.isFinite(value) ? chargingTime(value, timezone(), status.now) : value === true ? 'Observed' : value === false || value == null ? terminal(run) ? 'Not exercised' : 'Not yet observed' : label(value);
      milestones.append(make('dt', title), make('dd', detail));
    }
    const findings = q('[data-test-findings]'); findings.replaceChildren();
    for (const finding of run.findings ?? []) findings.append(make('li', finding.message ?? findingLabels[finding.code] ?? label(finding.code ?? finding)));
    q('[data-test-restoration]').textContent = run.restorationReminder ?? '';
    q('[data-test-cancel]').hidden = terminal(run); q('[data-test-new]').hidden = !terminal(run);
    q('[data-test-report]').disabled = !run.report?.id;
  }
  async function send(action, input) {
    if (busy || !manageable()) return;
    busy = true; message(); buttons(); beforeRequest();
    try {
      const result = await request(`/api/charging/tests/${action}`, input);
      if (action === 'preview') { preview = result; checkedInput = input; displayPreview(result); }
      else {
        status = result;
        if (action === 'start') selectedRun = runs().find(run => run.chargerId === input.chargerId && !terminal(run))?.id ?? runs().find(run => run.chargerId === input.chargerId)?.id;
        onStatus(result); renderRun();
      }
      if (action === 'schedule') message('Vehicle timer recorded as your declaration. Charging behavior will be checked against the actual observations.');
      await afterRequest();
    } catch (error) { message(error.message || 'The assessment could not be saved. Refresh and try again.', true); }
    finally { busy = false; buttons(); }
  }
  form.addEventListener('submit', event => {
    event.preventDefault(); if (!form.reportValidity()) return;
    try { void send('preview', readInput()); } catch (error) { message(error.message, true); }
  });
  form.addEventListener('input', () => { preview = null; checkedInput = null; q('[data-test-preview-result]').replaceChildren(); instructions(); buttons(); });
  q('[data-test-arm]').addEventListener('click', () => { if (checkedInput && form.reportValidity()) void send('start', checkedInput); });
  q('[data-test-confirm-time]').addEventListener('input', event => { event.target.dataset.edited = 'true'; });
  q('[data-test-confirm]').addEventListener('click', () => {
    const run = currentRun(); if (!run) return;
    try { void send('schedule', { id: run.id, association: run.association, sessionId: run.sessionId,
      startAt: parseChargingTestTime(q('[data-test-confirm-time]').value, timezone()) }); }
    catch (error) { message(error.message, true); }
  });
  q('[data-test-cancel]').addEventListener('click', () => { const run = currentRun(); if (run) void send('cancel', { id: run.id, association: run.association }); });
  q('[data-test-report]').addEventListener('click', () => {
    const run = currentRun(); if (run?.report?.id) { switchingDialog = true; dialog.close(); openReport(run.chargerId, run.report.id); }
  });
  q('[data-test-new]').addEventListener('click', () => { selectedRun = null; preview = null; checkedInput = null; renderRun(); buttons(); });
  q('[data-test-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    if (switchingDialog) { switchingDialog = false; return; }
    if (!document.querySelector('dialog[open]') && opener?.isConnected) opener.focus();
  });
  return {
    open(vehicleId = 'bmw') {
      opener = document.activeElement; field('vehicleId').value = vehicleId;
      selectedRun = runs().find(run => run.vehicleId === vehicleId && !terminal(run))?.id
        ?? runs().find(run => run.vehicleId === vehicleId)?.id ?? null;
      preview = null; checkedInput = null; message(); instructions(); renderRun(); buttons();
      if (!dialog.open) dialog.showModal();
    },
    update(next) {
      status = next;
      const chargers = next.charging?.chargers ?? [], key = chargers.map(c => `${c.id}:${c.label}`).join('|');
      if (key !== pickerKey) {
        pickerKey = key; const value = field('chargerId').value;
        field('chargerId').replaceChildren(Object.assign(make('option', 'Choose a charger'), { value: '' }));
        for (const charger of chargers) field('chargerId').append(Object.assign(make('option', charger.label), { value: charger.id }));
        field('chargerId').value = value;
      }
      if (dialog.open) {
        instructions(); renderRun(); buttons();
        if (next.charging?.physicalTests?.available === false) message('The charging assessment could not be saved. Ordinary charging continues; test evidence may be incomplete.', true);
      }
    },
    close() { if (dialog.open) dialog.close(); },
  };
}
