import { actionReceiptRecent } from './action-receipts.js';

export function floorPreheatView(status = {}) {
  const floor = status?.preheatValves;
  const commissioning = floor?.commissioned === false ? 'Not recorded' : 'Unknown';
  const renewal = 'Automatic preheating will need a verified release deadline on the device. Connection loss or an expired request must release all four contacts.';
  const view = (label, state, detail) => ({ label, state, detail, commissioning, renewal });

  // Retiring a device integration does not erase an existing physical obligation.
  if (floor?.restorationPending === true || floor?.brokerMismatch === true)
    return view('Release pending', 'attention', 'A previous floor override still needs physical release verification. The controller cannot confirm that its contacts are OFF.');
  if (floor?.integrationSupported !== false)
    return view('Status unavailable', 'pending', 'Floor control status is unavailable. Readiness and relay positions are unknown.');
  return view('Integration unavailable', 'pending', 'Floor preheating has no supported device integration yet. Configuration cannot enable it. Device communication, contact readback and automatic release must be implemented and verified first.');
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
