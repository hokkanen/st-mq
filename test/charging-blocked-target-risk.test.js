import test from 'node:test';
import assert from 'node:assert/strict';
import { chargerDisplay } from '../chart/charging.js';
import { chargerSummary, chargingNotice } from '../chart/charging-summary.js';

const now = Date.parse('2026-09-15T22:00:00Z');
const deadlineAt = now + 4 * 3_600_000;
const reading = value => ({ value, available: true, source: 'mqtt' });

function blockedCharger(id, risk) {
  return {
    id,
    provider: id === 'charger1' ? 'easee' : 'shelly-evse',
    settings: { enabled: true },
    controls: { enabled: true, revision: 1 },
    capabilities: { scheduling: true },
    association: `fixture:${id}`,
    request: { sessionId: `fixture:${id}:connection`, revision: 1, deadlineAt, overrides: {} },
    values: {
      connected: reading(true), charging: reading(false), powerKw: reading(0),
      soc: reading(45), minimumSoc: reading(85), capacityKwh: reading(70),
    },
    requiredGridKwh: 30,
    control: {
      phase: id === 'charger1' ? 'unavailable' : 'waiting', confirmed: false,
      reason: id === 'charger1' ? 'ocpp-disconnected' : 'device-permission-held',
      devicePermissionHeld: id === 'charger2',
    },
    plan: {
      state: 'release', startAt: now - 60_000, finishAt: deadlineAt - 60_000, deadlineAt,
      assumptions: [{ code: 'maximum-available-current', maximumCurrentA: 16 }],
    },
    forecast: {
      state: 'forecast', controlled: false, finishAt: risk ? null : deadlineAt - 60_000,
      feasible: !risk, reason: risk ? 'insufficient-time' : 'automatic-current-forecast',
    },
  };
}

for (const id of ['charger1', 'charger2']) {
  test(`${id}: unconfirmed control retains the computed target risk in its attention details`, () => {
    const item = blockedCharger(id, true);
    const view = chargerDisplay(item, { now });
    const summary = chargerSummary(item, view, { now });
    const notice = chargingNotice(item, view, summary);

    assert.equal(view.risk, true);
    assert.equal(view.readiness, '85 % by ready-by is at risk');
    assert.equal(summary.roleState, 'uncertain');
    assert.equal(summary.completion.value, 'Checking');
    assert.equal(summary.completion.at, null);
    assert.equal(notice.label, 'Charger needs attention');
    assert.equal(notice.state, 'attention');
    assert(notice.detail.includes(view.problem), 'The control problem remains explained');
    assert(notice.detail.includes(view.readiness), 'The computed target risk is also explained');
    assert.equal(notice.detail.split(view.readiness).length - 1, 1);
    assert.doesNotMatch(notice.detail, /Expected on time|Target reached/);
  });

  test(`${id}: unconfirmed control does not add a healthy or unproved readiness claim`, () => {
    const item = blockedCharger(id, false);
    const view = chargerDisplay(item, { now });
    const summary = chargerSummary(item, view, { now });
    const notice = chargingNotice(item, view, summary);

    assert.equal(view.risk, false);
    assert.equal(summary.roleState, 'uncertain');
    assert.equal(summary.completion.value, 'Checking');
    assert.equal(notice.label, 'Charger needs attention');
    assert(notice.detail.includes(view.problem));
    assert(!notice.detail.includes(view.readiness));
    assert.doesNotMatch(notice.detail, /Expected on time|Target reached|by ready-by is at risk/);
  });
}
