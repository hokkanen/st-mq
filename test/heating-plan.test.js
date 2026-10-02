import test from 'node:test';
import assert from 'node:assert/strict';
import { homePlannedChange, renderHomePlannedChange } from '../chart/heating-plan.js';

const now = Date.parse('2026-09-15T12:00:00Z');
const hour = 3_600_000;
const scheduled = () => ({ now, input: 'providers', automation: { home: { enabled: true } },
  decision: { phase: 'normal', plan: { schedule: {
    preheatStart: now + hour, preheatEnd: now + 2 * hour,
    reductionStart: now + 2 * hour, reductionEnd: now + 4 * hour,
  } } } });

test('Home next change uses the chosen future schedule and skips zero-duration preheat', () => {
  const status = scheduled();
  assert.deepEqual(homePlannedChange(status), {
    label: 'Planned actions', value: 'Preheat at 16:00', at: now + hour,
    detail: 'The controller rechecks the plan as conditions change.',
  });
  status.decision.plan.schedule.preheatStart = now + 2 * hour;
  assert.equal(homePlannedChange(status).value, 'Reduce heating at 17:00');
  status.decision.plan.trial = true;
  assert.match(homePlannedChange(status).detail, /bounded learning trial/);
});

test('active Home phases expose their next transition without assigning a recovery completion time', () => {
  const status = scheduled();
  status.now += hour;
  status.decision.phase = 'preheat';
  assert.equal(homePlannedChange(status).value, 'Reduce heating at 17:00');
  status.now += hour;
  status.decision.phase = 'reduction';
  status.decision.expiresAt = now + 3 * hour;
  assert.equal(homePlannedChange(status).value, 'Recovery at 18:00', 'active execution expiry overrides the frozen schedule');
  status.decision.phase = 'recovery';
  assert.equal(homePlannedChange(status).value, 'Next action after recovery');
  assert.equal(homePlannedChange(status).at, null, 'generic phase expiry does not promise normal heating');
  status.decision.phase = 'normal';
  assert.equal(homePlannedChange(status).value, 'Awaiting plan update', 'elapsed schedule does not become a future reduction');
});

test('Home schedule times identify a different Helsinki date', () => {
  const status = scheduled();
  for (const key of Object.keys(status.decision.plan.schedule)) status.decision.plan.schedule[key] += 24 * hour;
  assert.equal(homePlannedChange(status).value, 'Preheat at 16 Sept, 16:00');
});

test('paused planning describes the scheduled resume or absence of actions, not permission status', () => {
  const status = scheduled();
  status.automation.home.enabled = false;
  status.override = { expiresAt: now + hour };
  status.decision.manualHold = { phase: 'reduction', until: now + hour };
  assert.equal(homePlannedChange(status).label, 'Planned actions');
  assert.equal(homePlannedChange(status).value, 'Resume automatic at 16:00');
  assert.equal(homePlannedChange(status).at, now + hour);
  status.override.expiresAt = null;
  status.decision.manualHold.until = null;
  assert.equal(homePlannedChange(status).label, 'Planned actions');
  assert.equal(homePlannedChange(status).value, 'No actions scheduled', 'Paused state cannot advertise the previous automatic schedule');
  assert.equal(homePlannedChange(status).at, null);
  assert.match(homePlannedChange(status).detail, /Explore possible heating plans/);
});

test('manual preheat end and automatic resume expose the earliest independent action', () => {
  const status = scheduled();
  status.automation.home.enabled = false;
  status.override = { expiresAt: now + 2 * hour };
  status.decision.manualHold = { phase: 'preheat', until: now + hour };
  assert.equal(homePlannedChange(status).label, 'Planned actions');
  assert.equal(homePlannedChange(status).value, 'End preheat at 16:00');
  assert.equal(homePlannedChange(status).at, now + hour);
  assert.match(homePlannedChange(status).detail, /Resume automatic at 17:00/);
  status.override.expiresAt = now + hour / 2;
  assert.equal(homePlannedChange(status).value, 'Resume automatic at 15:30');
  assert.doesNotMatch(homePlannedChange(status).detail, /End preheat at/, 'Earlier resume reassesses heating rather than promising a later manual action');
  status.override.expiresAt = null;
  assert.equal(homePlannedChange(status).value, 'End preheat at 16:00', 'Indefinite pause retains the preheat deadline');
  status.decision.manualHold.until = now;
  assert.equal(homePlannedChange(status).value, 'No actions scheduled', 'Elapsed preheat deadline is not advertised as upcoming');
  status.decision.manualHold.until = Infinity;
  assert.equal(homePlannedChange(status).value, 'No actions scheduled', 'Invalid deadline does not become a scheduled action');
});

test('scheduled owner actions remain visible before an automatic decision is available', () => {
  const status = { now, automation: { home: { enabled: false } }, override: { expiresAt: now + hour } };
  assert.equal(homePlannedChange(status).value, 'Resume automatic at 16:00');
  status.override.expiresAt = now + 24 * hour;
  assert.equal(homePlannedChange(status).value, 'Resume automatic at 16 Sept, 15:00');
  status.override.expiresAt = now;
  assert.equal(homePlannedChange(status).at, null, 'Elapsed resume time is not advertised as upcoming');
});

test('simulation labels every action and empty plan without suggesting live commands', () => {
  const status = scheduled();
  status.automation.home.enabled = true;
  status.input = 'simulated';
  assert.equal(homePlannedChange(status).label, 'Simulated actions');
  assert.match(homePlannedChange(status).detail, /no commands are sent to the home/);
  status.automation.home.enabled = false;
  assert.equal(homePlannedChange(status).value, 'No actions scheduled');
  status.override = { expiresAt: now + hour };
  assert.equal(homePlannedChange(status).value, 'Resume automatic at 16:00');
  assert.equal(homePlannedChange(status).label, 'Simulated actions');
  assert.match(homePlannedChange(status).detail, /no commands are sent to the home/);
});

test('missing and invalid plans and read-only history cannot advertise a future live change', () => {
  assert.equal(homePlannedChange().value, 'Waiting for a plan');
  const status = scheduled();
  status.decision.plan.schedule.reductionEnd = null;
  assert.equal(homePlannedChange(status).value, 'Plan timing unavailable');
  status.decision.plan = null;
  status.decision.expiresAt = now + hour;
  assert.equal(homePlannedChange(status).value, 'No actions scheduled');
  assert.equal(homePlannedChange(status).at, null);
  for (const patch of [{ role: 'slave' }, { controlAuthority: { state: 'protected' } }]) {
    const display = homePlannedChange({ ...scheduled(), ...patch });
    assert.equal(display.label, 'Recorded plan');
    assert.equal(display.value, 'Normal heating');
    assert.equal(display.at, null);
  }
  assert.equal(homePlannedChange({ ...scheduled(), input: 'offline' }).value, 'Recorded history only');
});

test('preheat gaps schedule normal heating and missing timing stays unknown', () => {
  const status = scheduled();
  status.now += hour;
  status.decision.phase = 'preheat';
  status.decision.plan.schedule.preheatEnd = now + 1.5 * hour;
  assert.equal(homePlannedChange(status).value, 'Normal heating at 16:30');
  status.decision.plan = null;
  assert.equal(homePlannedChange(status).value, 'Next action unavailable');
  assert.doesNotMatch(homePlannedChange(status).detail, /No upcoming heating change is scheduled/);
});

test('the Home info row replaces a previous live schedule on transition to replica mode', () => {
  const nodes = new Map(['home-planned-change', 'home-plan-label', 'home-plan-value'].map(id => [id, {
    textContent: '', setAttribute(name, value) { this[name] = value; },
  }]));
  const document = { getElementById: id => nodes.get(id) };
  renderHomePlannedChange(document, scheduled());
  assert.equal(nodes.get('home-plan-value').textContent, 'Preheat at 16:00');
  assert.match(nodes.get('home-planned-change')['aria-label'], /Preheat at 16:00/);
  renderHomePlannedChange(document, { ...scheduled(), automation: { home: { enabled: false } } });
  assert.equal(nodes.get('home-plan-value').textContent, 'No actions scheduled');
  assert.doesNotMatch(nodes.get('home-planned-change').title, /Preheat at/);
  renderHomePlannedChange(document, { ...scheduled(), input: 'simulated' });
  assert.match(nodes.get('home-planned-change')['aria-label'], /Simulation only; no commands/);
  renderHomePlannedChange(document, { ...scheduled(), role: 'slave' });
  assert.equal(nodes.get('home-plan-label').textContent, 'Recorded plan');
  assert.equal(nodes.get('home-plan-value').textContent, 'Normal heating');
  assert.match(nodes.get('home-planned-change').title, /Saved decision/);
  assert.match(nodes.get('home-planned-change')['aria-label'], /cannot establish the master’s current plan/);
});
