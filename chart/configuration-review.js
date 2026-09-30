import { ACTION_RECEIPT_MS } from './action-receipts.js';

/** Reviews stay in this page only. The server rechecks the source before apply. */
export function createConfigurationReview({ document, request, getStatus, blocked,
  onBusy, onStatus, afterApply, clock = Date.now }) {
  const $ = id => document.getElementById(id);
  const check = $('settings-reload'), panel = $('settings-review');
  const apply = $('settings-review-apply'), cancel = $('settings-review-cancel');
  const message = $('settings-reload-message');
  let review = null, busy = false, generation = 0, receiptUntil = 0;
  const admin = () => getStatus()?.webAccess?.role === 'admin';
  function announce(text, error = false) {
    message.textContent = text;
    message.classList.toggle('form-error', error);
    receiptUntil = clock() + ACTION_RECEIPT_MS;
  }
  function clear() {
    ++generation;
    review = null;
    panel.hidden = true;
    $('settings-review-changes').replaceChildren();
    $('settings-review-restart').replaceChildren();
  }
  function update() {
    if (!admin()) clear();
    check.hidden = !admin();
    check.disabled = !admin() || busy || blocked();
    apply.disabled = !admin() || busy || blocked() || review?.canApply !== true;
    cancel.disabled = busy;
    if (receiptUntil && clock() >= receiptUntil) {
      message.textContent = ''; message.classList.remove('form-error'); receiptUntil = 0;
    }
  }
  function setBusy(value) {
    busy = value;
    check.setAttribute('aria-busy', String(value));
    onBusy(value);
    update();
  }
  function showReview(result) {
    review = result;
    const changes = result.changes;
    $('settings-review-summary').textContent = changes.length
      ? `Configuration is valid. ${changes.length} changed ${changes.length === 1 ? 'field' : 'fields'}.`
      : 'Configuration is valid. No configuration values have changed. Applying reconnects providers.';
    $('settings-review-import').hidden = !result.imported;
    $('settings-review-table').hidden = changes.length === 0;
    for (const change of changes) {
      const row = document.createElement('tr'), field = document.createElement('th');
      field.scope = 'row';
      field.textContent = change.path;
      row.append(field);
      for (const key of ['before', 'after']) {
        const cell = document.createElement('td'), value = change[key];
        cell.setAttribute('data-label', key === 'before' ? 'Current' : 'Proposed');
        cell.textContent = value == null ? 'Not set' : change.redacted ? 'Hidden' : JSON.stringify(value);
        if (change.redacted) cell.className = 'muted';
        row.append(cell);
      }
      $('settings-review-changes').append(row);
    }
    $('settings-review-restart-note').hidden = result.restartRequired.length === 0;
    for (const text of result.restartRequired) {
      const item = document.createElement('li'); item.textContent = text;
      $('settings-review-restart').append(item);
    }
    panel.hidden = false;
    $('settings-review-title').focus();
  }
  check.addEventListener('click', async () => {
    if (!admin() || busy || blocked()) return;
    clear();
    const current = generation;
    setBusy(true);
    announce('Checking saved configuration…');
    try {
      const result = await request('/api/settings/preview', {});
      if (current !== generation || !admin()) return;
      showReview(result);
      announce('Check complete. Review the changes before applying.');
    } catch (error) {
      if (current === generation && admin()) announce(error.message, true);
    } finally { setBusy(false); }
  });
  cancel.addEventListener('click', () => {
    if (busy) return;
    clear(); update(); announce('Review cancelled. Configuration was not applied.'); check.focus();
  });
  apply.addEventListener('click', async () => {
    if (!admin() || busy || blocked() || review?.canApply !== true) return;
    const reviewId = review.reviewId;
    clear();
    const current = generation;
    setBusy(true);
    announce('Applying reviewed configuration and reconnecting providers…');
    try {
      const result = await request('/api/settings/reload', { reviewId });
      if (current !== generation || !admin()) return;
      onStatus(result);
      announce('Configuration applied.');
    } catch (error) {
      if (current === generation && admin()) announce(error.message, true);
    } finally {
      setBusy(false);
      if (current === generation && admin()) { check.focus(); await afterApply(); }
    }
  });
  update();
  return { update, clear };
}
