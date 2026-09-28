import { isReadOnlyReplica } from './replica-status.js';

const explain = value => ({
  'prepare-for-later-price-opportunity': 'Waiting for a later electricity-price opportunity.',
  'flat-prices-preserve-normal-warmth': 'Normal heating; no worthwhile price difference.',
  'waiting-for-temperature-evidence': 'Waiting for fresh temperature evidence.',
  'unvalidated-thermal-model': 'Learning how the house holds and recovers heat.',
  'unvalidated-heating-energy-model': 'Learning how much electricity heating uses.',
  'missing-or-stale-observations': 'Waiting for fresh temperature readings.',
  'thermal-state-reconciliation': 'Checking heat reserve after startup.',
  'adapter-monitoring': 'The adapter has not been armed for automatic pauses.',
  'installed-commissioning-required': 'Installed OFF/ON recovery checks are incomplete.',
})[value] ?? (typeof value === 'string' ? value.replaceAll('-', ' ').replace(/^./, letter => letter.toUpperCase()) : null);

export function automationView(status, feature) {
  const control = status?.automation?.[feature];
  const readOnly = !status || isReadOnlyReplica(status) || status.input === 'offline';
  const pauseUntil = control?.pausedUntil;
  let activity = ({
    unavailable: control?.reason,
    'plan-only': 'Plan only. Manual heating controls remain available when the equipment is ready.',
    automatic: 'Automatic heating is enabled. The current plan and protection checks determine the next action.',
    paused: Number.isFinite(pauseUntil) ? `Paused until ${new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Helsinki', dateStyle: 'short', timeStyle: 'short',
    }).format(pauseUntil)}. Manual heating choices retain their own duration.` : 'Automatic heating is paused.',
  })[control?.activity] ?? control?.activity;
  if (control?.activity === 'automatic') {
    const reasons = feature === 'garage' ? status.garage?.adapter?.automaticPauseReasons : status.decision?.reasons;
    const reason = reasons?.find(value => typeof value === 'string');
    const detail = explain(reason ?? (feature === 'garage' ? status.garage?.reason : null));
    if (detail) activity = `Automatic · ${detail}`;
  }
  const manual = feature === 'garage' ? status?.garage?.heatingControls?.activity
    : status?.decision?.manualHold?.until > status?.now ? 'A temporary manual heating selection is held.' : null;
  if (manual && control?.activity !== 'unavailable') activity = [activity, manual].filter(Boolean).join(' ');
  return {
    enabled: control?.enabled === true,
    available: !readOnly && control?.available === true,
    canDisable: !readOnly && control?.enabled === true,
    activity: readOnly ? 'Recorded automation choice; current equipment control is unavailable.'
      : activity || control?.reason || (control?.enabled
        ? 'Automatic planning is enabled. Equipment and protection checks still apply.'
        : 'Plan only. Manual heating controls remain available when the equipment is ready.'),
  };
}

/** Independent, durable automation choices. A manual override never toggles these. */
export function createAutomationControls({ document, request, onStatus, blocked = () => false,
  onBusy = () => {}, beforeRequest = () => {}, afterRequest = () => {} }) {
  const $ = id => document.getElementById(id);
  let status, busy = false;
  const refreshControls = () => {
    for (const feature of ['home', 'garage']) {
      const view = automationView(status, feature);
      for (const [suffix, enabled] of [['plan', false], ['automatic', true]]) {
        const button = $(`${feature}-automation-${suffix}`);
        if (!button) continue;
        button.disabled = busy || blocked() || !(view.available || !enabled && view.canDisable);
        button.setAttribute('aria-pressed', String(enabled === view.enabled));
      }
    }
  };
  const update = next => {
    status = next;
    for (const feature of ['home', 'garage']) {
      const activity = $(`${feature}-automation-activity`);
      if (activity) activity.textContent = automationView(status, feature).activity;
    }
    refreshControls();
  };
  for (const feature of ['home', 'garage']) for (const [suffix, enabled] of [['plan', false], ['automatic', true]]) {
    $(`${feature}-automation-${suffix}`)?.addEventListener('click', async () => {
      const view = automationView(status, feature);
      if (busy || blocked() || !(view.available || !enabled && view.canDisable)) return;
      const message = $(`${feature}-automation-message`);
      busy = true; beforeRequest(); onBusy(true); refreshControls();
      message.classList.remove('form-error');
      message.textContent = enabled ? 'Enabling automatic heating…' : 'Selecting Plan only…';
      try {
        const result = await request('/api/automation', { feature, enabled });
        update(result); onStatus(result);
        message.textContent = `${enabled ? 'Automatic' : 'Plan only'} saved for this heating system.`;
      } catch (error) {
        message.classList.add('form-error'); message.textContent = error.message;
      } finally {
        busy = false; onBusy(false); refreshControls();
      }
      await afterRequest();
    });
  }
  return { update, refreshControls };
}
