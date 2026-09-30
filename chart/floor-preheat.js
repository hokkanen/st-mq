import { actionReceiptRecent } from './action-receipts.js';

function duration(seconds) {
  if (!Number.isInteger(seconds) || seconds <= 0) return null;
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  }
  return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
}

export function floorPreheatView(status = {}) {
  const floor = status?.preheatValves;
  const commissioning = floor?.commissioned === true ? 'Recorded in configuration'
    : floor?.commissioned === false ? 'Not recorded' : 'Unknown';
  const renew = duration(floor?.renewSeconds), lease = duration(floor?.leaseSeconds);
  const renewal = renew && lease
    ? `The controller renews an admitted override every ${renew}. The local script and native switch timer end it at the planned deadline or within ${lease} without renewal.`
    : 'Renewal timing unavailable. The local script and native switch timer end an admitted override at the planned deadline or when its local lease expires.';
  const view = (label, state, detail) => ({ label, state, detail, commissioning, renewal });

  // An outstanding release survives changes to the configuration. Keep that
  // obligation visible even when new overrides are disabled.
  if (floor?.brokerMismatch === true)
    return view('Release pending', 'attention', 'A previous floor override still needs release confirmation. The broker identity has changed, so the controller cannot confirm release on the original devices.');
  if (floor?.restorationPending === true)
    return view('Release pending', 'attention', 'The controller is waiting for confirmation that the floor override contacts are OFF. Relay feedback cannot confirm thermostat operation, valve movement or water flow.');
  if (floor?.enabled === false)
    return view('Not enabled', 'pending', 'The controller will not start floor overrides. Complete commissioning before enabling floor preheating.');
  if (floor?.enabled !== true)
    return view('Status unavailable', 'pending', 'Floor preheating status is unavailable. Readiness and relay positions are unknown.');
  if (floor.commissioned === false)
    return view('Commissioning required', 'attention', 'Complete the installation checks and record commissioning before enabling floor preheating. Relay feedback alone does not complete commissioning.');
  if (floor.commissioned !== true)
    return view('Commissioning status unavailable', 'pending', 'The commissioning record is unavailable. Relay feedback alone does not complete commissioning.');
  if (floor.connected === false || floor.available === false)
    return view('Floor feedback unavailable', 'attention', 'Both floor devices need fresh local script and relay feedback before a floor override can start.');
  if (floor.available !== true || typeof floor.active !== 'boolean')
    return view('Status unavailable', 'pending', 'Floor readiness and override activity are not fully reported. Commissioning recorded in configuration does not establish current device readiness.');
  if (floor.active)
    return view('Floor override active', 'available', 'All four override contacts report ON. This confirms the relay contacts only; valve movement and water flow are not measured.');
  return view('Ready for preheating', 'available', 'Both floor devices report ready for an override. Heating control permissions and the plan determine whether preheating starts.');
}

export function renderFloorPreheat(document, status) {
  const display = floorPreheatView(status);
  const receipt = status?.heatingTests?.manualPreheatReport;
  const report = document.getElementById('heating-preheat-report');
  if (report) {
    const visible = actionReceiptRecent(receipt?.at, status?.now ?? Date.now());
    report.hidden = !visible;
    report.textContent = visible ? receipt.message : '';
    report.classList.toggle('form-error', Boolean(visible && (receipt.floorOutcome === 'unverified' || receipt.roomOutcome === 'pending')));
  }
  const summary = document.getElementById('floor-preheat-state');
  if (summary) {
    summary.textContent = display.label;
    summary.dataset.state = display.state;
  }
  for (const [id, text] of [
    ['floor-preheat-status', display.detail],
    ['floor-preheat-commissioning-status', display.commissioning],
    ['floor-preheat-renewal', display.renewal],
  ]) {
    const element = document.getElementById(id);
    if (element) element.textContent = text;
  }
  return display;
}
