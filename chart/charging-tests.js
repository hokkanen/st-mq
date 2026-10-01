import { isReadOnlyReplica } from './replica-status.js';
import { chargingTime } from './charging.js';
import { createChargingTime } from './charging-time.js';
import { chargingTestClock, nextChargingTestTime } from './charging-test-time.js';

const terminal = run => ['completed', 'finished', 'cancelled', 'interrupted'].includes(run?.phase);
const label = value => String(value ?? '').replaceAll('-', ' ');
const DAY = 86400_000;
export const chargingTestPhases = {
  armed: 'Ready to plug in', 'awaiting-vehicle-schedule': 'Review the vehicle schedule',
  observing: 'Following the charging session', completed: 'Charging completion confirmed',
  finished: 'Assessment finished · incomplete coverage', cancelled: 'Assessment stopped early', interrupted: 'Assessment interrupted',
};
const milestonesLabels = { connection: 'New physical connection', identification: 'Expected vehicle identified',
  initialPlan: 'Real charging plan recorded', vehicleSchedule: 'Vehicle schedule confirmed',
  identifiedPlanningInputs: 'Vehicle inputs used for planning', chargingStarted: 'Physical charging started',
  chargingAfterDelay: 'Charging after the vehicle delay', vehicleTarget: 'Vehicle target reached',
  deadline: 'Ready-by outcome', completion: 'Vehicle completion observed' };
const findingLabels = {
  'wrong-vehicle-identified': 'The controller identified a different vehicle from the one selected for this test.',
  'identified-before-vehicle-start': 'The vehicle was identified before the recorded schedule. Early identification is valid; delayed identification was not exercised.',
  'charging-before-vehicle-start': 'Charging was observed before the recorded vehicle schedule. Check that the car has the intended schedule.',
  'identification-inconclusive': 'An identification attempt was inconclusive. A later match does not erase this result.',
  'normal-controls-changed': 'Automatic charging, Charge now or manual control changed during this assessment.',
  'ready-by-changed': 'The session ready-by time changed during this assessment.',
  'observation-gap': 'Observation was interrupted. Behavior during the missing interval could not be checked.',
  'vehicle-limit-differs-from-preparation': 'The vehicle reported a different target. Review the target below.',
};
const endReasons = {
  'equipment-changed': 'The configured physical charger changed.',
  'backend-changed': 'The charger control backend changed.',
  'fresh-connection-not-observed': 'A new physical connection after arming could not be established.',
  'preparation-expired': 'The 24-hour preparation window expired. Verify the current vehicle readings and prepare another test.',
  'unplugged-before-completion': 'Unplugging finished the assessment. Charging completion was not confirmed, so some coverage remains incomplete.',
  'physical-session-changed': 'The physical connection changed; this assessment does not follow the next vehicle.',
  'target-without-observed-charging': 'The vehicle reached its target, but physical charging was not observed. The full charging test is unverified.',
  'vehicle-target-and-stop-observed': 'The vehicle reached its target and the charger was observed stopped. Unplug the car to finish the connection; no End action is needed.',
  'user-cancelled': 'You stopped the assessment early. Ordinary charging continues.',
};

/** Independent vehicle feed readings are preparation suggestions, never identity evidence. */
export function chargingTestReadings(status, vehicleId) {
  const feed = status?.charging?.vehicleFeeds?.find(row => row.id === vehicleId);
  const fields = feed?.setup?.fields ?? {}, source = vehicleId === 'bmw' ? 'BMW CarData' : 'TeslaMate';
  const result = {};
  for (const [name, key, min, max] of [['soc', 'soc', 0, 100], ['nativeTargetSoc', 'minimumSoc', 1, 100],
    ['capacityKwh', 'capacityKwh', 1, 300], ['vehicleStartAt', 'vehicleNotBefore', (status?.now ?? Date.now()) + 1, Infinity]]) {
    const field = fields[key];
    if (field?.available === true && Number.isFinite(field.value) && field.value >= min && field.value <= max) {
      result[name] = { value: field.value, source, at: field.timeBasis === 'receipt-only' ? field.receivedAt : field.measuredAt,
        timeBasis: field.timeBasis };
    }
  }
  const capacity = status?.charging?.settings?.vehicles?.[vehicleId]?.capacityKwh;
  if (!result.capacityKwh && Number.isFinite(capacity) && capacity >= 1 && capacity <= 300) {
    result.capacityKwh = { value: capacity, source: 'Configured usable capacity', at: null };
  }
  return result;
}

/** The guide records assessment assumptions, independently of charging inputs. */
export function createChargingTestsPanel({ document, request, onStatus = () => {},
  beforeRequest = () => {}, afterRequest = () => {}, openReport = () => {} }) {
  const dialog = document.createElement('dialog');
  dialog.id = 'charging-test-dialog'; dialog.className = 'control-dialog charging-test-dialog';
  dialog.setAttribute('aria-labelledby', 'charging-test-title');
  dialog.innerHTML = `<div class="charging-test-heading"><h2 id="charging-test-title">Guided charging test</h2>
    <button type="button" class="secondary-button" data-test-close aria-label="Close guided charging test">Close</button></div>
    <p class="muted">Follow a real charging session from plug-in to completion. The normal controller identifies the vehicle and chooses the charging periods.</p>
    <div data-test-preparation>
      <form id="charging-test-form">
        <div class="charging-test-fields">
          <label>Vehicle<select name="vehicleId"><option value="bmw">BMW</option><option value="tesla">Tesla</option></select></label>
          <label>Physical charger<select name="chargerId" required><option value="">Choose a charger</option></select></label>
          <label class="charging-test-wide">Test program<select name="program"><option value="immediate">Normal charging</option><option value="vehicle-schedule">Vehicle waits for its schedule</option></select></label>
          <label>Battery now (%)<input name="soc" type="number" min="0" max="100" step="0.1" required><small class="muted" data-test-source="soc"></small></label>
          <label>Vehicle charge target (%)<input name="nativeTargetSoc" type="number" min="1" max="100" step="0.1" required><small class="muted" data-test-source="nativeTargetSoc"></small></label>
          <label class="charging-test-wide">Usable battery capacity (kWh)<input name="capacityKwh" type="number" min="1" max="300" step="0.1" required><small class="muted" data-test-source="capacityKwh"></small></label>
          <div class="charging-test-wide" data-test-start-label hidden>
            <label for="charging-test-initial-time">Before plugging in: start time set in the car</label>
            <input id="charging-test-initial-time" name="vehicleStartAt" aria-describedby="charging-test-initial-date">
            <small class="muted" data-test-source="vehicleStartAt"></small>
            <small id="charging-test-initial-date" data-test-initial-date></small>
          </div>
        </div>
        <div class="charging-test-actions"><button type="button" class="secondary-button" data-test-load>Replace fields with latest readings</button></div>
        <p class="muted">Verify the loaded values, or enter what you see in the car. The target is the charge target set in the car; entering it here does not change the car. Reloading replaces available readings and the capacity suggestion, including edits. It does not wake or query the vehicle.</p>
        <p data-test-instructions></p>
        <p class="muted">Leave the selected charger unplugged. Enable its Automatic charging switch and clear any manual Stop or conflicting charger schedule.</p>
        <p class="muted">These values guide the assessment’s estimates and comparisons. Actual charging continues to use the controller’s independently obtained readings and ordinary charging settings.</p>
        <label class="charging-test-check"><input name="prepared" type="checkbox" required><span>I verified these values and the car’s settings. Record them as assessment expectations for the next connection on the selected charger, within 24 hours.</span></label>
        <div class="charging-test-actions"><button type="submit" data-test-preview data-write-control>Check preparation</button><button type="button" data-test-arm data-write-control disabled>Arm test</button></div>
      </form>
      <div data-test-preview-result aria-live="polite"></div>
    </div>
    <section data-test-run hidden aria-label="Test progress">
      <p class="charging-test-phase" data-test-phase role="status"></p>
      <p data-test-scope class="muted"></p><p data-test-guidance></p>
      <p data-test-headroom class="muted"></p>
      <form id="charging-test-target-form" data-test-target-review hidden>
        <p data-test-target-discrepancy></p>
        <label>Verified target set in the car (%)<input data-test-target-value type="number" min="1" max="100" step="0.1" required></label>
        <button type="submit" data-test-target-confirm data-write-control>Record verified vehicle target</button>
        <p class="muted">Check the target in the car, then record it here for the assessment. Actual charging continues to use the controller’s own readings and settings.</p>
      </form>
      <p data-test-target-receipt role="status"></p>
      <section data-test-timer hidden aria-label="Vehicle schedule adjustment">
        <p data-test-schedule-original class="muted"></p>
        <p data-test-schedule-current></p>
        <p data-test-recommendation></p>
        <form id="charging-test-schedule-form">
          <div data-test-adjustment-field>
            <label for="charging-test-adjustment-time">Record an updated start time set in the car</label>
            <input id="charging-test-adjustment-time" data-test-confirm-time required aria-describedby="charging-test-adjustment-date">
            <small id="charging-test-adjustment-date" data-test-adjustment-date></small>
          </div>
          <p class="muted">Change the schedule in the car first, then save the same time here. Saving records your confirmation; it does not send a command to the car.</p>
          <button type="submit" data-test-confirm data-write-control>Save the time set in the car</button>
        </form>
        <p data-test-schedule-receipt role="status" aria-live="polite"></p>
      </section>
      <dl class="charging-test-milestones" data-test-milestones></dl>
      <ul data-test-findings></ul><p data-test-restoration></p>
      <div class="charging-test-actions"><button type="button" class="secondary-button" data-test-report>Open session report</button>
        <button type="button" class="secondary-button" data-test-cancel data-write-control>Stop assessment early</button>
        <button type="button" class="secondary-button" data-test-new hidden>Prepare another test</button></div>
      <p class="muted">To finish normally, wait for charging completion to be confirmed, then unplug. Unplugging earlier also ends the assessment, with incomplete coverage. Stopping the assessment early leaves ordinary charging running. Restore temporary schedules in the car. Closing this window leaves the assessment running.</p>
    </section>
    <p data-test-message role="status" aria-live="polite"></p>`;
  document.body.append(dialog);
  const q = selector => dialog.querySelector(selector), form = q('#charging-test-form');
  const field = name => form.elements.namedItem(name);
  const timePicker = createChargingTime({ document, idPrefix: 'charging-test-time' });
  let status, busy = false, preview = null, checkedInput = null, selectedRun = null, opener = null, pickerKey = '', switchingDialog = false;
  let draftVehicle = null, draftSources = {}, initialAt = null, adjustmentAt = null;
  const drafts = new Map(), names = ['soc', 'nativeTargetSoc', 'capacityKwh', 'vehicleStartAt'];
  const now = () => status?.now ?? Date.now();
  const timezone = () => status?.charging?.timezone ?? 'Europe/Helsinki';
  const runs = () => status?.charging?.physicalTests?.runs ?? [];
  const manageable = () => status && !isReadOnlyReplica(status) && status.charging?.physicalTests?.canManage === true;
  const currentRun = () => runs().find(run => run.id === selectedRun);
  const make = (tag, text) => { const element = document.createElement(tag); element.textContent = text; return element; };
  const fullTime = at => Number.isFinite(at) ? new Intl.DateTimeFormat('en-GB', { timeZone: timezone(),
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(at) : 'Not recorded';
  const recent = at => Number.isFinite(at) && now() >= at && now() - at < DAY;
  timePicker.attach(field('vehicleStartAt'), q('[data-test-start-label]'), { label: 'Choose initial vehicle schedule',
    title: () => `Initial vehicle schedule · ${timezone()}`, description: 'Choose the start time already set in the car before plugging in. Verify the day shown in the guide.' });
  timePicker.attach(q('[data-test-confirm-time]'), q('[data-test-adjustment-field]'), { label: 'Choose updated vehicle schedule',
    title: () => `Updated vehicle schedule · ${timezone()}`, description: 'Choose the time set in the car, then save your confirmation in the guide. Verify the day before saving.' });
  function message(text = '', error = false) {
    q('[data-test-message]').textContent = text;
    q('[data-test-message]').classList.toggle('form-error', error);
  }
  function invalidate() {
    preview = null; checkedInput = null; q('[data-test-preview-result]').replaceChildren();
  }
  function sourceText(source) {
    if (!source) return 'No available reading. Enter and verify this value.';
    if (source.manual) return 'Entered by you. Verify this matches the car.';
    if (!Number.isFinite(source.at)) return `${source.source} · editable assumption`;
    const minutes = Math.max(0, Math.floor((now() - source.at) / 60_000));
    const age = minutes < 1 ? 'less than a minute ago' : minutes < 60 ? `${minutes} min ago`
      : minutes < 1440 ? `${Math.floor(minutes / 60)} h ago` : `${Math.floor(minutes / 1440)} d ago`;
    return `${source.source} · ${source.timeBasis === 'receipt-only' ? 'received' : 'measured'} ${fullTime(source.at)} (${age}). Verify before use.`;
  }
  function renderSources() {
    for (const name of names) q(`[data-test-source="${name}"]`).textContent = sourceText(draftSources[name]);
  }
  function saveDraft() {
    if (!draftVehicle) return;
    drafts.set(draftVehicle, { values: Object.fromEntries(names.map(name => [name, field(name).value])), sources: draftSources, initialAt });
  }
  function loadReadings(replace = false) {
    const vehicle = field('vehicleId').value;
    if (!replace && draftVehicle === vehicle) return;
    if (draftVehicle !== vehicle) saveDraft();
    draftVehicle = vehicle;
    const saved = !replace && drafts.get(vehicle);
    if (saved) {
      for (const name of names) field(name).value = saved.values[name];
      draftSources = saved.sources; initialAt = saved.initialAt;
    } else {
      const values = chargingTestReadings(status, vehicle);
      if (!replace) { for (const name of names) field(name).value = ''; draftSources = {}; initialAt = null; }
      for (const [name, reading] of Object.entries(values)) {
        field(name).value = name === 'vehicleStartAt' ? chargingTestClock(reading.value, timezone()) : reading.value;
        draftSources[name] = reading;
        if (name === 'vehicleStartAt') initialAt = reading.value;
      }
      if (replace) message(Object.keys(values).length ? 'Available readings replaced the corresponding fields. Verify the values before continuing.'
        : 'No vehicle readings are available. Your entered values were kept; verify them in the car.');
    }
    field('prepared').checked = false; invalidate(); renderSources(); instructions();
  }
  function timerValue(input, recordedAt) {
    return Number.isFinite(recordedAt) && chargingTestClock(recordedAt, timezone()) === input.value
      ? recordedAt : nextChargingTestTime(input.value, timezone(), now());
  }
  function timerDate(input, recordedAt, node) {
    if (!input.value) { node.textContent = `Time in ${timezone()}. Enter the next start scheduled in the car.`; return; }
    try { node.textContent = `Applies to ${fullTime(timerValue(input, recordedAt))} · ${timezone()}`; }
    catch (error) { node.textContent = error.message; }
  }
  function readInput() {
    const charger = status?.charging?.chargers?.find(row => row.id === field('chargerId').value);
    const input = { chargerId: field('chargerId').value, vehicleId: field('vehicleId').value,
      program: field('program').value, association: charger?.association, capacityKwh: Number(field('capacityKwh').value),
      soc: Number(field('soc').value), nativeTargetSoc: Number(field('nativeTargetSoc').value), prepared: field('prepared').checked };
    if (input.program === 'vehicle-schedule') input.vehicleStartAt = timerValue(field('vehicleStartAt'), initialAt);
    return input;
  }
  function instructions() {
    const delayed = field('program').value === 'vehicle-schedule', tesla = field('vehicleId').value === 'tesla';
    q('[data-test-start-label]').hidden = !delayed; field('vehicleStartAt').required = delayed;
    q('[data-test-instructions]').textContent = delayed
      ? 'Before plugging in, set a future charging start in the car so it waits instead of drawing immediately. '
        + (tesla ? 'Tesla’s reported next start can fill this field; verify its day and use a Start-at-only schedule without overlapping schedules. '
          : 'BMW does not report its charging windows to this application, so enter and verify the time yourself. ')
        + 'After plug-in, the guide recommends a schedule using the real charging plan. Early vehicle identification is valid.'
      : 'Disable vehicle charging schedules and allow immediate charging. After arming, plug in and let the controller identify the vehicle and plan charging.';
    timerDate(field('vehicleStartAt'), initialAt, q('[data-test-initial-date]'));
  }
  function buttons() {
    for (const input of form.querySelectorAll('input,select')) input.disabled = busy;
    field('vehicleStartAt').disabled = busy || field('program').value !== 'vehicle-schedule';
    q('[data-test-load]').disabled = busy;
    q('[data-test-preview]').disabled = busy || !manageable();
    q('[data-test-arm]').disabled = busy || !manageable() || preview?.eligible !== true;
    const run = currentRun(), editable = !busy && manageable() && run?.sessionId && !terminal(run);
    q('[data-test-cancel]').disabled = busy || !manageable() || !run || terminal(run);
    const editableSchedule = editable && run.recommendation?.state === 'available';
    q('[data-test-confirm]').disabled = !editableSchedule;
    q('[data-test-confirm-time]').disabled = !editableSchedule;
    q('[data-test-target-confirm]').disabled = !editable;
    q('[data-test-target-value]').disabled = !editable;
    timePicker.update(field('vehicleStartAt'), draftVehicle);
    timePicker.update(q('[data-test-confirm-time]'), run?.id);
    if (!manageable() && !busy) message('Guided tests need the live controller with permission to save an assessment. Existing reports remain readable.');
  }
  function displayPreview(value) {
    const container = q('[data-test-preview-result]'); container.replaceChildren();
    const headroom = value.headroom;
    if (Number.isFinite(headroom?.minutes)) container.append(make('p', `About ${Math.round(headroom.minutes)} minutes of active charging remain to the vehicle target, using ${headroom.capacityKwh} kWh usable capacity and an assumed ${Number(headroom.powerKw).toFixed(1)} kW. Aim for at least ${headroom.minimumMinutes} minutes for this program.`));
    else container.append(make('p', 'Charging headroom cannot be estimated until usable battery capacity and charging power are available.'));
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
    const charger = status.charging.chargers.find(c => c.id === run.chargerId);
    q('[data-test-phase]').textContent = chargingTestPhases[run.phase] ?? label(run.phase);
    q('[data-test-scope]').textContent = `${run.vehicleId === 'bmw' ? 'BMW' : 'Tesla'} · ${charger?.label ?? run.chargerId} · ${run.program === 'immediate' ? 'Normal charging' : 'Vehicle waits for its schedule'}`;
    const endMessage = run.endReason === 'vehicle-target-and-stop-observed' && charger?.request?.sessionId !== run.sessionId
      ? 'The vehicle reached its target and the charger was observed stopped. This assessment records that completed charging occasion.'
      : endReasons[run.endReason] ?? 'The assessment has ended.';
    q('[data-test-guidance]').textContent = run.phase === 'armed'
      ? `Plug into the selected charger now. The assessment will follow its next new connection${Number.isFinite(run.expiresAt) ? ` before ${fullTime(run.expiresAt)}` : ''}. Identification and actual charging use the controller’s independent evidence and settings.`
      : terminal(run) ? `${endMessage} Review the findings and coverage below.`
        : 'Leave the car connected until charging completion is confirmed, then unplug to finish. No End action is required. The assessment continues when this window or browser is closed.';
    q('[data-test-headroom]').textContent = `Assessment expectations: starting charge ${run.expectations.soc}% · vehicle target ${run.expectations.nativeTargetSoc}% · usable capacity ${run.expectations.capacityKwh} kWh. These verified declarations remain separate from the controller’s charging inputs.`;
    const reviewTarget = run.target?.requiresConfirmation === true && Boolean(run.sessionId) && !terminal(run);
    q('[data-test-target-review]').hidden = !reviewTarget;
    if (reviewTarget) {
      const reported = Number.isFinite(run.target.reportedSoc)
        ? `Last reported vehicle target: ${run.target.reportedSoc}% · ${Number.isFinite(run.target.reportedAt) ? fullTime(run.target.reportedAt) : 'source timestamp unavailable'}. ` : '';
      q('[data-test-target-discrepancy]').textContent = `${reported}The assessment assumes a ${run.expectations.nativeTargetSoc}% vehicle target. Verify the target set in the car and update the assessment’s expectation if needed.`;
      const target = q('[data-test-target-value]'), key = `${run.id}:${run.target.reportedSoc}:${run.target.reportedAt}`;
      if (target.dataset.run !== run.id) { target.dataset.run = run.id; target.dataset.edited = 'false'; }
      if (target.dataset.edited !== 'true' && target.dataset.reading !== key) {
        target.dataset.reading = key; target.value = run.target.reportedSoc ?? run.expectations.nativeTargetSoc;
      }
    }
    const targetHistory = run.target?.history ?? [], lastTarget = targetHistory.at(-1);
    q('[data-test-target-receipt]').textContent = targetHistory.length > 1 && recent(lastTarget?.confirmedAt)
      ? `Saved assessment target: ${lastTarget.targetSoc}% · ${fullTime(lastTarget.confirmedAt)}. Recorded as your verified vehicle target.` : '';
    const timer = run.program === 'vehicle-schedule';
    q('[data-test-timer]').hidden = !timer;
    if (timer) {
      const schedule = run.schedule, input = q('[data-test-confirm-time]');
      q('[data-test-schedule-original]').textContent = `Initially recorded before plug-in: ${fullTime(run.expectations.vehicleStartAt)}.`;
      q('[data-test-schedule-current]').textContent = `Currently recorded in the guide: ${fullTime(schedule?.startAt)}${schedule?.confirmedAt ? ' · confirmed by you' : ' · verified during preparation'}.`;
      const recommendation = run.recommendation;
      q('[data-test-recommendation]').textContent = (recommendation?.state === 'available' && Number.isFinite(recommendation.startAt)
        ? `Recommended start time to set in the car: ${fullTime(recommendation.startAt)}. ` : '')
        + (recommendation?.message ?? 'A recommendation becomes available after plug-in and the real charging plan.')
        + (Number.isFinite(recommendation?.estimatedFinishAt) ? ` Estimated target time: ${fullTime(recommendation.estimatedFinishAt)}. The plan may change as new evidence arrives.` : '');
      q('#charging-test-schedule-form').hidden = !run.sessionId || terminal(run)
        || recommendation?.state !== 'available' && !Number.isFinite(schedule?.confirmedAt);
      const savedKey = `${run.id}:${schedule?.startAt}:${schedule?.confirmedAt}`;
      const displayedAt = Number.isFinite(schedule?.confirmedAt) ? schedule.startAt
        : recommendation?.state === 'available' && Number.isFinite(recommendation.startAt) ? recommendation.startAt : schedule?.startAt;
      if (input.dataset.saved !== savedKey || input.dataset.edited !== 'true' && input.dataset.suggested !== String(displayedAt)) {
        input.dataset.saved = savedKey; input.dataset.edited = 'false';
        input.dataset.suggested = String(displayedAt);
        adjustmentAt = displayedAt; input.value = chargingTestClock(adjustmentAt, timezone());
      }
      timerDate(input, adjustmentAt, q('[data-test-adjustment-date]'));
      q('[data-test-schedule-receipt]').textContent = recent(schedule?.confirmedAt)
        ? `Saved: start time set in the car ${fullTime(schedule.startAt)}. Recorded ${fullTime(schedule.confirmedAt)}.` : '';
    }
    const milestones = q('[data-test-milestones]'); milestones.replaceChildren();
    for (const [key, title] of Object.entries(milestonesLabels)) {
      if (run.program === 'immediate' && ['vehicleSchedule', 'chargingAfterDelay'].includes(key)) continue;
      const value = run.milestones?.[key];
      const currentTarget = !['vehicleTarget', 'deadline'].includes(key) || value?.targetSoc === run.expectations.nativeTargetSoc
        && !run.target?.requiresConfirmation;
      const detail = value && !currentTarget ? 'Current vehicle target unconfirmed'
        : typeof value === 'object' && value !== null
        ? value.message ?? (value.state ? label(value.state) : Number.isFinite(value.at) ? chargingTime(value.at, timezone(), now()) : 'Awaiting evidence')
        : Number.isFinite(value) ? chargingTime(value, timezone(), now()) : value === true ? 'Observed' : value === false || value == null ? terminal(run) ? 'Not exercised' : 'Not yet observed' : label(value);
      milestones.append(make('dt', title), make('dd', detail));
    }
    const findings = q('[data-test-findings]'); findings.replaceChildren();
    for (const finding of run.findings ?? []) {
      const targetFinding = finding.code === 'vehicle-limit-differs-from-preparation';
      const text = targetFinding && run.target?.requiresConfirmation !== true
        ? 'A different target was observed earlier. The current assessment target is shown above; this finding preserves the earlier discrepancy.'
        : finding.message ?? findingLabels[finding.code] ?? label(finding.code ?? finding);
      findings.append(make('li', text));
    }
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
        if (action === 'target') q('[data-test-target-value]').dataset.edited = 'false';
        onStatus(result); renderRun();
      }
      await afterRequest();
    } catch (error) { message(error.message || 'The assessment could not be saved. Refresh and try again.', true); }
    finally { busy = false; buttons(); }
  }
  form.addEventListener('submit', event => {
    event.preventDefault(); if (!form.reportValidity()) return;
    try { void send('preview', readInput()); } catch (error) { message(error.message, true); }
  });
  form.addEventListener('input', event => {
    invalidate();
    if (event.target === field('vehicleId')) loadReadings();
    else if (names.includes(event.target.name)) {
      draftSources[event.target.name] = { manual: true };
      if (event.target.name === 'vehicleStartAt') initialAt = null;
      field('prepared').checked = false; renderSources();
    } else if (event.target !== field('prepared')) field('prepared').checked = false;
    instructions(); buttons();
  });
  q('[data-test-load]').addEventListener('click', () => { loadReadings(true); buttons(); });
  q('[data-test-arm]').addEventListener('click', () => { if (checkedInput && form.reportValidity()) void send('start', checkedInput); });
  q('[data-test-confirm-time]').addEventListener('input', event => {
    event.target.dataset.edited = 'true'; adjustmentAt = null;
    timerDate(event.target, adjustmentAt, q('[data-test-adjustment-date]'));
  });
  q('#charging-test-schedule-form').addEventListener('submit', event => {
    event.preventDefault(); const run = currentRun(); if (!run || !event.target.reportValidity()) return;
    try { void send('schedule', { id: run.id, association: run.association, sessionId: run.sessionId,
      startAt: timerValue(q('[data-test-confirm-time]'), adjustmentAt) }); }
    catch (error) { message(error.message, true); }
  });
  q('#charging-test-target-form').addEventListener('submit', event => {
    event.preventDefault(); const run = currentRun(); if (!run || !event.target.reportValidity()) return;
    void send('target', { id: run.id, association: run.association, sessionId: run.sessionId,
      targetRevision: run.target.revision, nativeTargetSoc: Number(q('[data-test-target-value]').value) });
  });
  q('[data-test-target-value]').addEventListener('input', event => { event.target.dataset.edited = 'true'; });
  q('[data-test-cancel]').addEventListener('click', () => { const run = currentRun(); if (run) void send('cancel', { id: run.id, association: run.association }); });
  q('[data-test-report]').addEventListener('click', () => {
    const run = currentRun(); if (run?.report?.id) { switchingDialog = true; dialog.close(); openReport(run.chargerId, run.report.id); }
  });
  q('[data-test-new]').addEventListener('click', () => {
    selectedRun = null; invalidate(); field('prepared').checked = false; renderRun(); loadReadings(true); buttons();
  });
  q('[data-test-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    timePicker.dismiss(); saveDraft();
    if (switchingDialog) { switchingDialog = false; return; }
    if (!document.querySelector('dialog[open]') && opener?.isConnected) opener.focus();
  });
  return {
    open(vehicleId = 'bmw', runId = null) {
      opener = document.activeElement; field('vehicleId').value = vehicleId; loadReadings();
      selectedRun = runId !== null ? runs().find(run => run.vehicleId === vehicleId && run.id === runId)?.id ?? null
        : runs().find(run => run.vehicleId === vehicleId && !terminal(run))?.id
          ?? runs().find(run => run.vehicleId === vehicleId)?.id ?? null;
      invalidate(); message(); instructions(); renderRun(); buttons();
      if (runId !== null && selectedRun === null) message('This assessment is no longer retained. No other assessment was selected.', true);
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
        instructions(); renderSources(); renderRun(); buttons();
        if (next.charging?.physicalTests?.available === false) message('The charging assessment could not be saved. Ordinary charging continues; test evidence may be incomplete.', true);
      }
    },
    close() { if (dialog.open) dialog.close(); },
  };
}
