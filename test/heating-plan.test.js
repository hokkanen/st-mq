import test from 'node:test';
import assert from 'node:assert/strict';
import { homePlannedChange, renderHomePlannedChange } from '../chart/heating-plan.js';

const now = Date.parse('2026-09-15T12:00:00Z');
const hour = 3_600_000;
const scheduled = () => ({ now, input: 'providers', mode: 'active', liveWrites: true,
  decision: { phase: 'normal', plan: { schedule: {
    preheatStart: now + hour, preheatEnd: now + 2 * hour,
    reductionStart: now + 2 * hour, reductionEnd: now + 4 * hour,
  } } } });

test('Home next change uses the chosen future schedule and skips zero-duration preheat', () => {
  const status = scheduled();
  assert.deepEqual(homePlannedChange(status), {
    label: 'Next planned change', value: 'Preheat at 16:00', at: now + hour,
    detail: 'The controller rechecks the plan as conditions change.',
  });
  status.decision.plan.schedule.preheatStart = now + 2 * hour;
  assert.equal(homePlannedChange(status).value, 'Reduction at 17:00');
  status.decision.plan.trial = true;
  assert.match(homePlannedChange(status).detail, /bounded learning trial/);
});

test('active Home phases expose their next transition without assigning a recovery completion time', () => {
  const status = scheduled();
  status.now += hour;
  status.decision.phase = 'preheat';
  assert.equal(homePlannedChange(status).value, 'Reduction at 17:00');
  status.now += hour;
  status.decision.phase = 'reduction';
  status.decision.expiresAt = now + 3 * hour;
  assert.equal(homePlannedChange(status).value, 'Recovery at 18:00', 'active execution expiry overrides the frozen schedule');
  status.decision.phase = 'recovery';
  assert.equal(homePlannedChange(status).value, 'Recovery in progress');
  assert.equal(homePlannedChange(status).at, null, 'generic phase expiry does not promise normal heating');
  status.decision.phase = 'normal';
  assert.equal(homePlannedChange(status).value, 'Awaiting plan update', 'elapsed schedule does not become a future reduction');
});

test('Home schedule times identify a different Helsinki date', () => {
  const status = scheduled();
  for (const key of Object.keys(status.decision.plan.schedule)) status.decision.plan.schedule[key] += 24 * hour;
  assert.equal(homePlannedChange(status).value, 'Preheat at 16 Sept, 16:00');
});

test('pause, monitoring, simulation and shadow plans retain their actual authority', () => {
  const status = scheduled();
  status.override = { expiresAt: now + hour };
  status.decision.manualHold = { phase: 'reduction', until: now + hour };
  assert.equal(homePlannedChange(status).label, 'Price control paused');
  assert.equal(homePlannedChange(status).value, 'Until 16:00');
  delete status.override;
  delete status.decision.manualHold;
  status.mode = 'monitoring';
  assert.equal(homePlannedChange(status).value, 'Monitoring only');
  status.mode = 'shadow'; status.liveWrites = false;
  assert.equal(homePlannedChange(status).label, 'Next shadow change');
  assert.match(homePlannedChange(status).detail, /no automatic commands/);
  status.input = 'simulated';
  assert.equal(homePlannedChange(status).label, 'Next simulated change');
  assert.match(homePlannedChange(status).detail, /no commands are sent to the home/);
});

test('missing and invalid plans and read-only history cannot advertise a future live change', () => {
  assert.equal(homePlannedChange().value, 'Waiting for a plan');
  const status = scheduled();
  status.decision.plan.schedule.reductionEnd = null;
  assert.equal(homePlannedChange(status).value, 'Plan timing unavailable');
  status.decision.plan = null;
  status.decision.expiresAt = now + hour;
  assert.equal(homePlannedChange(status).value, 'No change planned');
  assert.equal(homePlannedChange(status).at, null);
  for (const patch of [{ role: 'replica' }, { controlAuthority: { state: 'protected' } }]) {
    const display = homePlannedChange({ ...scheduled(), ...patch });
    assert.equal(display.label, 'Recorded plan');
    assert.equal(display.value, 'Normal heating');
    assert.equal(display.at, null);
  }
  assert.equal(homePlannedChange({ ...scheduled(), input: 'offline' }).value, 'Recorded history only');
});

test('the Home info row replaces a previous live schedule on transition to replica mode', () => {
  const nodes = new Map(['home-planned-change', 'home-plan-label', 'home-plan-value'].map(id => [id, { textContent: '' }]));
  const document = { getElementById: id => nodes.get(id) };
  renderHomePlannedChange(document, scheduled());
  assert.equal(nodes.get('home-plan-value').textContent, 'Preheat at 16:00');
  renderHomePlannedChange(document, { ...scheduled(), role: 'replica' });
  assert.equal(nodes.get('home-plan-label').textContent, 'Recorded plan');
  assert.equal(nodes.get('home-plan-value').textContent, 'Normal heating');
  assert.match(nodes.get('home-planned-change').title, /Saved decision/);
});
