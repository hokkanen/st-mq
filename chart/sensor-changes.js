const pendingKey = 'stmq-sensor-change-pending';
const labels = Object.freeze({ indoor_temperature: 'Upstairs Hallway', downstairs_temperature: 'Downstairs',
  bedroom_temperature: 'Bedroom', garage_temperature: 'Garage', outdoor_temperature: 'Outdoor' });
const reasons = Object.freeze({ replacement: 'Replacement', moved: 'Moved', calibration: 'Calibration changed', other: 'Other change' });
const dateFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const validChange = body => body && Object.hasOwn(labels, body.signal) && Object.hasOwn(reasons, body.reason);
const available = view => view?.available === true && view.readOnly !== true;

function requestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function restorePending(storage) {
  try {
    const body = JSON.parse(storage?.getItem(pendingKey) ?? 'null');
    if (validChange(body) && typeof body.requestId === 'string' && body.requestId.length <= 128) {
      return { signal: body.signal, reason: body.reason, requestId: body.requestId };
    }
  } catch { /* Recording remains usable when browser storage is unavailable. */ }
  return null;
}

/** Keep an uncertain submission intact across refreshes and retries. */
export function createSensorChangeActions({ request, storage, makeRequestId = requestId,
  onChange = () => {}, beforeMutation = () => {}, afterMutation = () => {} }) {
  let view, busy = false, loading = false, generation = 0, pending = restorePending(storage);
  let message = pending ? 'A previous save was not confirmed. Retry the same change without adding a duplicate.' : '', error = !!pending;
  const snapshot = () => ({ view, busy, loading, pending, message, error });
  const notify = () => onChange(snapshot());
  const persist = () => { try { if (pending) storage?.setItem(pendingKey, JSON.stringify(pending)); else storage?.removeItem(pendingKey); } catch {} };
  function update(next) {
    if (busy || !next || Number.isFinite(view?.revision) && next.revision < view.revision) return;
    view = next; notify();
  }
  async function refresh() {
    if (busy || loading) return false;
    const sequence = ++generation;
    loading = true; notify();
    try {
      const next = await request('/api/sensor-changes');
      if (sequence !== generation) return false;
      if (!pending) { message = ''; error = false; }
      update(next);
      return true;
    } catch {
      if (sequence === generation && !pending) { message = 'Sensor changes could not be loaded. Refresh to try again.'; error = true; }
      return false;
    } finally { if (sequence === generation) { loading = false; notify(); } }
  }
  async function send(body) {
    if (busy || !available(view) || pending && body) return false;
    if (body && !view.sensors?.some(sensor => sensor.signal === body.signal && sensor.configured)) return false;
    pending ??= body;
    if (!pending) return false;
    ++generation; loading = false; busy = true; error = false;
    message = 'Recording sensor change…'; persist(); beforeMutation(); notify();
    let saved = false;
    try {
      const result = await request('/api/sensor-changes', pending);
      view = result;
      message = `${labels[pending.signal]} change recorded.`;
      pending = null; persist(); saved = true;
    } catch (failure) {
      error = true;
      if (failure.status >= 400 && failure.status < 500 && ![408, 429].includes(failure.status)) {
        pending = null; persist();
        message = failure.status === 401 ? 'Enter your access token, then try again.'
          : failure.status === 403 ? 'Sensor changes must be recorded on the active primary computer.'
            : 'The change could not be saved. Refresh the sensors and try again.';
      } else message = 'Save not confirmed. Retry the same change without adding a duplicate.';
    } finally { busy = false; notify(); }
    if (saved) await afterMutation();
    return saved;
  }
  return { snapshot, update, refresh, retry: () => send(),
    add: (signal, reason) => validChange({ signal, reason })
      ? send({ signal, reason, requestId: makeRequestId() }) : Promise.resolve(false) };
}

export function createSensorChangePanel({ document, request, storage, beforeMutation, afterMutation }) {
  const $ = id => document.getElementById(id), sensor = $('sensor-change-signal'), reason = $('sensor-change-reason');
  let selectionKey;
  const actions = createSensorChangeActions({ request, storage, beforeMutation, afterMutation, onChange: render });
  function render(state) {
    const sensors = (state.view?.sensors ?? []).filter(row => row.configured && Object.hasOwn(labels, row.signal));
    if (state.pending && !sensors.some(row => row.signal === state.pending.signal)) sensors.push({ signal: state.pending.signal });
    const key = `${!!state.view}:${sensors.map(row => row.signal).join(',')}`;
    if (key !== selectionKey) {
      const selected = sensor.value;
      const options = sensors.map(row => {
        const option = document.createElement('option'); option.value = row.signal; option.textContent = labels[row.signal]; return option;
      });
      if (!options.length) {
        const option = document.createElement('option'); option.value = ''; option.textContent = state.view ? 'No configured sensors' : 'Loading sensors…'; options.push(option);
      }
      sensor.replaceChildren(...options);
      if (sensors.some(row => row.signal === selected)) sensor.value = selected;
      selectionKey = key;
    }
    if (state.pending) { sensor.value = state.pending.signal; reason.value = state.pending.reason; }
    const disabled = state.busy || !!state.pending || !available(state.view) || !sensors.length;
    sensor.disabled = disabled; reason.disabled = disabled; $('sensor-change-submit').disabled = disabled;
    $('sensor-change-submit').textContent = state.busy ? 'Recording…' : 'Sensor changed';
    $('sensor-change-content').setAttribute('aria-busy', String(state.busy || state.loading));
    $('sensor-change-message').textContent = state.message;
    $('sensor-change-message').classList.toggle('form-error', state.error);
    $('sensor-change-retry').hidden = !state.pending || state.busy;
    $('sensor-change-retry').disabled = !available(state.view);
    $('sensor-change-refresh').disabled = state.busy || state.loading;
    $('sensor-change-availability').textContent = state.view?.readOnly ? 'Record changes on the active primary computer.'
      : state.view && !available(state.view) ? 'Sensor changes are unavailable in this installation.' : '';
    const events = (state.view?.events ?? []).filter(event => validChange(event) && Number.isFinite(event.at))
      .sort((a, b) => b.at - a.at || b.id - a.id).slice(0, 10);
    $('sensor-change-overview').textContent = events.length ? `Last ${dateFormat.format(events[0].at)}` : 'Replacement, move or calibration';
    $('sensor-change-empty').hidden = events.length > 0;
    $('sensor-change-entries').replaceChildren(...events.map(event => {
      const row = document.createElement('li'), description = document.createElement('span'), at = document.createElement('time');
      description.textContent = `${labels[event.signal]} · ${reasons[event.reason]}`;
      at.dateTime = new Date(event.at).toISOString(); at.textContent = dateFormat.format(event.at);
      row.append(description, at); return row;
    }));
  }
  $('sensor-change-form').addEventListener('submit', event => { event.preventDefault(); void actions.add(sensor.value, reason.value); });
  $('sensor-change-retry').addEventListener('click', () => { void actions.retry(); });
  $('sensor-change-refresh').addEventListener('click', () => { void actions.refresh(); });
  $('sensor-change-details').addEventListener('toggle', () => { if ($('sensor-change-details').open) void actions.refresh(); });
  render(actions.snapshot());
  if (actions.snapshot().pending) { $('sensor-change-details').open = true; void actions.refresh(); }
  return { update: actions.update, refresh: actions.refresh };
}
