import { isReadOnlyReplica } from './replica-status.js';
import { ACTION_RECEIPT_MS } from './action-receipts.js';

const explain = value => ({
  'prepare-for-later-price-opportunity': 'Waiting for a later electricity-price opportunity.',
  'flat-prices-preserve-normal-warmth': 'Normal heating; no worthwhile price difference.',
  'waiting-for-temperature-evidence': 'Waiting for fresh temperature evidence.',
  'unvalidated-thermal-model': 'Learning how the house holds and recovers heat.',
  'unvalidated-heating-energy-model': 'Learning how much electricity heating uses.',
  'missing-or-stale-observations': 'Waiting for fresh temperature readings.',
  'thermal-state-reconciliation': 'Checking heat reserve after startup.',
  'installed-commissioning-required': 'Installed OFF/ON recovery checks are incomplete.',
})[value] ?? (typeof value === 'string' ? value.replaceAll('-', ' ').replace(/^./, letter => letter.toUpperCase()) : null);

export function automationView(status, feature) {
  const control = status?.automation?.[feature];
  const readOnly = !status || isReadOnlyReplica(status) || status.input === 'offline';
  const pauseUntil = control?.pausedUntil;
  let activity = ({
    unavailable: control?.reason,
    automatic: 'Automatic heating is enabled. The current plan and protection checks determine the next action.',
    paused: Number.isFinite(pauseUntil) ? `Paused until ${new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Helsinki', dateStyle: 'short', timeStyle: 'short',
    }).format(pauseUntil)}. Normal and Reduced stay selected until then; Preheat has its own deadline.` : 'Paused until you select Automatic. Manual Normal and Reduced stay selected; Preheat has its own deadline.',
  })[control?.activity] ?? control?.activity;
  if (control?.activity === 'automatic') {
    const reasons = status.decision?.reasons;
    const reason = reasons?.find(value => typeof value === 'string');
    const detail = explain(reason);
    if (detail) activity = `Automatic · ${detail}`;
  }
  const hold = status?.decision?.manualHold;
  const manual = hold && (hold.until == null || hold.until > status?.now) ? 'Manual heating override is selected.' : null;
  if (manual && control?.activity !== 'unavailable') activity = [activity, manual].filter(Boolean).join(' ');
  return {
    enabled: control?.enabled === true,
    available: !readOnly && control?.available === true,
    canDisable: !readOnly && control?.enabled === true,
    activity: readOnly ? 'Recorded automation choice; current equipment control is unavailable.'
      : activity || control?.reason || (control?.enabled
        ? 'Automatic planning is enabled. Equipment and protection checks still apply.'
        : 'Paused until you select Automatic. Manual heating controls remain available.'),
  };
}

/** Independent, durable automation choices. A manual override never toggles these. */
export function createAutomationControls({ document, request, onStatus, blocked = () => false,
  onBusy = () => {}, beforeRequest = () => {}, afterRequest = () => {} }) {
  const $ = id => document.getElementById(id);
  let status, busy = false, receiptUntil = 0, uncertainSave;
  const refreshControls = () => {
    for (const feature of ['home']) {
      const view = automationView(status, feature);
      for (const [suffix, enabled] of [['automatic', true], ['pause', false]]) {
        const button = $(`${feature}-automation-${suffix}`);
        if (!button) continue;
        button.disabled = busy || blocked() || !(view.available || !enabled && view.canDisable);
        button.setAttribute('aria-pressed', String(enabled === view.enabled));
      }
    }
  };
  const update = next => {
    status = next;
    const current = status?.automation?.home;
    if (uncertainSave && current?.revision > uncertainSave.revision && current.enabled === uncertainSave.enabled) {
      const message = $('home-automation-message');
      message.classList.remove('form-error');
      message.textContent = current.enabled ? 'Automatic heating is saved for this system.' : 'Pause is saved for this system.';
      uncertainSave = undefined;
    }
    if (receiptUntil && Date.now() >= receiptUntil) {
      $('home-automation-message').textContent = '';
      $('home-automation-message').classList.remove('form-error');
      receiptUntil = 0;
    }
    for (const feature of ['home']) {
      const activity = $(`${feature}-automation-activity`);
      if (activity) activity.textContent = automationView(status, feature).activity;
    }
    refreshControls();
  };
  for (const feature of ['home']) for (const [suffix, enabled] of [['automatic', true], ['pause', false]]) {
    $(`${feature}-automation-${suffix}`)?.addEventListener('click', async () => {
      const view = automationView(status, feature);
      if (busy || blocked() || !(view.available || !enabled && view.canDisable)) return;
      const message = $(`${feature}-automation-message`);
      const previousRevision = status?.automation?.[feature]?.revision ?? -1;
      uncertainSave = undefined;
      busy = true; beforeRequest(); onBusy(true); refreshControls();
      message.classList.remove('form-error');
      message.textContent = enabled ? 'Enabling automatic heating…' : 'Pausing automatic heating…';
      try {
        const result = await request('/api/automation', { feature, enabled });
        update(result); onStatus(result);
        message.textContent = enabled ? 'Automatic heating resumed.' : 'Paused. No resume time is set.';
        receiptUntil = Date.now() + ACTION_RECEIPT_MS;
      } catch (error) {
        message.classList.add('form-error'); message.textContent = error.message;
        uncertainSave = { enabled, revision: previousRevision };
        receiptUntil = Date.now() + ACTION_RECEIPT_MS;
      } finally {
        busy = false; onBusy(false); refreshControls();
      }
      await afterRequest();
    });
  }
  return { update, refreshControls };
}
