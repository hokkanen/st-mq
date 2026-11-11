import test from 'node:test';
import assert from 'node:assert/strict';
import { createHeatingExplorerState, heatingComparisonMetrics, heatingUncertaintyBands, heatingEvidenceText, heatingApprovalText, heatingTrialDetails } from '../chart/heating-explorer.js';

const now = Date.parse('2026-09-30T09:00:00Z');
test('one-cycle details separate authorization, execution and missing recovery evidence', () => {
  const details = heatingTrialDetails({ controls: [
    { key: 'maxReductionHours', label: 'Maximum reduction', unit: 'h' },
    { key: 'minimumHomeBenefitCents', label: 'Minimum estimated saving', unit: 'cents' },
    { key: 'learningTrials', label: 'Enable learning trials' },
  ], activeTrial: { status: 'interrupted', approvedAt: now, endedAt: now + 60_000, expiresAt: now + 12 * 3_600_000,
    reason: 'recovery-evidence-unavailable', learningTrials: false,
    limits: { maxReductionHours: .25, minimumHomeBenefitCents: -150 } } });
  assert.equal(details.status, 'Interrupted');
  assert.equal(details.title, 'Last approved heating cycle');
  assert.match(details.caption, /Historical approval record.*do not describe the selected plan/);
  assert.equal(details.matchesCurrent, false);
  assert.deepEqual(details.dates.map(([label]) => label), ['Approved', 'Ended', 'Authorization deadline']);
  assert.match(details.reason, /missing evidence prevented recovery confirmation/);
  assert.doesNotMatch(details.reason, /recovery-evidence-unavailable/);
  assert.match(details.assessment, /Savings remain unassessed/);
  assert.deepEqual(details.metrics, []);
  assert.deepEqual(details.limits, [['Maximum reduction', '0.25 h'], ['Minimum estimated saving', '-150 cents'], ['Enable learning trials', 'Off']]);
});
test('one-cycle assessments retain unavailable values, valid zero and estimated extra cost', () => {
  for (const status of ['pending', 'running']) {
    const detail = heatingTrialDetails({ activeTrial: { status, approvedAt: now, latestStartAt: now, expiresAt: now + 60_000 } });
    assert.match(detail.assessment, /if recorded evidence is sufficient/);
    assert.equal(detail.dates.some(([label]) => label === 'Latest start'), status === 'pending');
  }
  for (const profitCents of [-42, 0, null]) {
    const detail = heatingTrialDetails({ activeTrial: { status: 'completed',
      outcome: { profitCents, recoveryErrorCents: 0, uncertaintyCents: null } } });
    assert.match(detail.assessment, profitCents === null ? /savings assessment is unavailable/ : /estimated Normal heating reference/);
    assert.deepEqual(detail.metrics, [
      [profitCents < 0 ? 'Estimated extra cost' : 'Estimated space-heating saving', profitCents === null ? 'Unavailable' : profitCents === 0 ? '€0.00' : '€0.42'],
      ['Recovery cost forecast error', '€0.00'], ['Cost uncertainty', 'Unavailable'],
    ]);
  }
  assert.equal(heatingTrialDetails({}), null);
});
test('approval relationship requires exact identity and distinguishes ended captured plans from earlier records', () => {
  const trial = { id: 'synthetic-approval', status: 'running', approvedAt: now };
  const related = heatingTrialDetails({ current: { approvalId: trial.id }, activeTrial: trial });
  assert.equal(related.matchesCurrent, true);
  assert.match(related.caption, /belongs to the selected plan captured above/);
  assert.equal(related.title, 'Approved heating cycle');
  const separate = heatingTrialDetails({ current: { approvalId: 'different-approval' }, activeTrial: trial });
  assert.equal(separate.matchesCurrent, false);
  assert.match(separate.caption, /separate from the selected plan in this capture/);
  const ended = heatingTrialDetails({ snapshotAt: now, current: { approvalId: trial.id }, activeTrial: { ...trial, status: 'completed', endedAt: now + 60_000 } });
  assert.match(ended.caption, /ended after the plan above was captured/);
  const recovery = heatingTrialDetails({ snapshotAt: now + 120_000, current: { approvalId: trial.id }, activeTrial: { ...trial, status: 'cancelled', endedAt: now + 60_000 } });
  assert.match(recovery.caption, /no longer active.*recovery and restoration remain independent/);
  assert.doesNotMatch(recovery.caption, /ended after/);
  assert.equal(heatingTrialDetails({ current: {}, activeTrial: {} }).matchesCurrent, false);
});

test('ending the captured approved cycle withdraws comparison freshness while retaining its original plan and edits', async () => {
  const selected = { approvalId: 'synthetic-approval', schedule: { reductionStart: now, reductionEnd: now + 60_000 } };
  const state = createHeatingExplorerState({ clock: () => now, request: async () => makeResult({ current: selected,
    activeTrial: { id: selected.approvalId, status: 'running' } }) });
  await state.load(); state.edit('maxReductionHours', 8);
  state.updateTrial({ id: selected.approvalId, status: 'completed' });
  assert.equal(state.snapshot().stale, true);
  assert.deepEqual(state.snapshot().result.current, selected);
  assert.equal(state.snapshot().limits.maxReductionHours, 8);
  assert.equal(await state.compare(), false);
});
test('a stale controller snapshot directs the user to recording health without exposing raw errors', async () => {
  const state = createHeatingExplorerState({ request: async () => {
    throw Object.assign(new Error('sensitive household diagnostic'), { status: 503, code: 'heating_snapshot_unavailable' });
  } });
  assert.equal(await state.load(), false);
  assert.match(state.snapshot().message, /controller has not updated heating conditions.*Check Recording status/);
  assert.doesNotMatch(state.snapshot().message, /sensitive/);
});
test('comparison labels distinguish unchanged-limit replanning and suppress rounded signed zero', () => {
  for (const change of [-.0001, .0001, -0]) {
    const metrics = heatingComparisonMetrics({ changedKeys: [], currentDiffersFromRecalculation: true,
      current: { outcomes: { maxIndoorDropC: .2 } }, scenario: { trial: true, outcomes: { maxIndoorDropC: .2 } },
      comparison: { additionalBenefitCents: -.01, additionalIndoorDropC: change } });
    assert.equal(metrics[0].value, '€0.00');
    assert.match(metrics[0].detail, /Fresh calculation with unchanged limits/);
    assert.match(metrics[1].detail, /change 0 °C$/);
    assert.doesNotMatch(metrics[2].detail, /reviewed/);
  }
  assert.equal(heatingComparisonMetrics({ comparison: { additionalBenefitCents: -8 } })[0].value, '−€0.08');
});
test('strategy changes preserve independent monetary fields, zero and the manual budget',async()=>{
  const requests=[],controls=[{key:'savingsStrategy',value:'balanced'},
    {key:'minimumHomeBenefitCents',value:0,usesStrategyDefault:true},
    {key:'homeDiscomfortCentsPerDegreeSquaredHour',value:0,usesStrategyDefault:true},
    {key:'maxTrialCostCents',value:150}];
  const state=createHeatingExplorerState({clock:()=>now,request:async(path,body)=>{requests.push({path,body});return makeResult({controls});}});
  await state.load();state.edit('savingsStrategy','gentle');
  assert.equal(state.snapshot().limits.minimumHomeBenefitCents,0);
  assert.equal(state.snapshot().limits.homeDiscomfortCentsPerDegreeSquaredHour,0);
  state.edit('minimumHomeBenefitCents',0);await state.compare();
  assert.deepEqual(requests.at(-1).body.limits,{savingsStrategy:'gentle'});
  state.edit('savingsStrategy','balanced');state.edit('savingsStrategy','gentle');
  assert.equal(state.snapshot().limits.minimumHomeBenefitCents,0,'An explicitly edited zero remains authoritative');
  state.reset();state.edit('savingsStrategy','gentle');
  assert.equal(state.snapshot().limits.minimumHomeBenefitCents,0,'Reset restores the configured monetary policy');
});

test('learning edits submit only changed intent and Reset restores the captured baseline without a request', async () => {
  const requests = [], controls = [{ key: 'learningTrials', value: false },
    { key: 'maxTrialCostCents', value: 150 }, { key: 'learningPriorityPriceCents', value: 15 }];
  const original = makeResult({ controls, current: { schedule: { reductionStart: now, reductionEnd: now + 900000 } },
    learningContext: { automaticEnabled: false, perCycleLimitCents: 150, remainingAutomaticAllowanceCents: 0,
      allowanceBasis: 'captured-automatic' } });
  const state = createHeatingExplorerState({ clock: () => now, request: async (path, body) => {
    requests.push({ path, body }); return structuredClone(path.endsWith('/simulate')
      ? { ...original, previewId: 'changed-preview', scenario: { ...original.scenario, estimatedBenefitCents: 999 },
        learningContext: { ...original.learningContext, allowanceBasis: 'reviewed-one-cycle' } } : original);
  } });
  await state.load(); await state.compare();
  assert.deepEqual(requests.at(-1).body.limits, {}, 'Untouched fields do not create permission or an allowance');
  state.edit('learningTrials', true); await state.compare();
  assert.deepEqual(requests.at(-1).body.limits, { learningTrials: true });
  state.edit('learningPriorityPriceCents', 20); await state.compare();
  assert.deepEqual(requests.at(-1).body.limits, { learningTrials: true, learningPriorityPriceCents: 20 });
  state.edit('maxTrialCostCents', 151); await state.compare();
  assert.deepEqual(requests.at(-1).body.limits, { learningTrials: true, maxTrialCostCents: 151, learningPriorityPriceCents: 20 });
  state.updateTrial({ id: 'actual-cycle', status: 'running' });
  const count = requests.length; state.reset();
  assert.equal(requests.length, count);
  assert.deepEqual(state.snapshot().result.current, original.current);
  assert.deepEqual(state.snapshot().result.learningContext, original.learningContext);
  assert.equal(state.snapshot().result.activeTrial.id, 'actual-cycle', 'Reset does not cancel or resurrect actual cycle state');
  assert.deepEqual(state.snapshot().limits, { learningTrials: false, maxTrialCostCents: 150, learningPriorityPriceCents: 15 });
  assert.equal(state.snapshot().dirty, false); assert.equal(state.snapshot().result.previewId, null);
  assert.equal(await state.apply(), false);
  state.edit('maxTrialCostCents', 151); state.edit('maxTrialCostCents', 150); await state.compare();
  assert.deepEqual(requests.at(-1).body.limits, {}, 'Returning to the original value removes the budget override');
  state.edit('maxTrialCostCents', null); state.edit('learningPriorityPriceCents', null); await state.compare();
  assert.deepEqual(requests.at(-1).body.limits, {}, 'Disabled learning drafts cannot block an ordinary preview or grant an allowance');
  assert.equal(state.snapshot().limits.maxTrialCostCents, null, 'Disabled values are retained until edited or reset');
});

test('Reset preserves an unknown original allowance and Refresh explicitly replaces the captured context', async () => {
  let generation = 0;
  const state = createHeatingExplorerState({ clock: () => now, request: async () => makeResult({
    snapshotId: `context-${++generation}`, controls: [{ key: 'learningTrials', value: generation > 1 },
      { key: 'maxTrialCostCents', value: 150 }, { key: 'learningPriorityPriceCents', value: 15 }],
    learningContext: { remainingAutomaticAllowanceCents: generation === 1 ? null : 25 } }) });
  await state.load(); state.edit('learningTrials', true); state.edit('maxTrialCostCents', 151); state.reset();
  assert.equal(generation, 1);
  assert.equal(state.snapshot().result.learningContext.remainingAutomaticAllowanceCents, null);
  assert.equal(state.snapshot().limits.learningTrials, false);
  await state.load(); state.edit('learningTrials', false); state.reset();
  assert.equal(generation, 2);
  assert.equal(state.snapshot().result.learningContext.remainingAutomaticAllowanceCents, 25);
  assert.equal(state.snapshot().limits.learningTrials, true);
});
test('validation explanation uses complete sentences and does not turn zero observed duration into an execution ban',()=>{
  const text=heatingEvidenceText({initialReady:true,actionValidated:false,validatedReductionHours:0,
    reasons:['awaiting-held-out-thermal-trajectories','awaiting-held-out-tariff-response',
      'awaiting-frozen-advance-cycle-predictions','awaiting-fireplace-response-evidence',
      'trials-require-enabled-budget-and-observed-equipment']});
  assert.match(text,/supports executable plans/);
  assert.match(text,/No reduction duration has been independently validated yet\./);
  assert.match(text,/Validation still being collected: thermal response, requested heating response, advance cycle forecasts, fireplace response\.$/);
  assert.doesNotMatch(text,/awaiting|·|Evidence limits|duration: 0 h|global optimum/);
  assert.match(heatingEvidenceText({actionValidated:true,validatedReductionHours:4}),/Independently validated reduction duration: 4 h\./);
});
const makeResult = (extra = {}) => ({ snapshotId: 'synthetic-snapshot', snapshotAt: now, expiresAt: now + 60_000,
  controls: [{ key: 'maxReductionHours', value: 4 }, { key: 'maxDropC', value: 1.5 }],
  current: { outcomes: { maxIndoorDropC: .7 } }, scenario: { outcomes: { maxIndoorDropC: 1.1 }, schedule: { reductionStart: now, reductionEnd: now + 6 * 3_600_000 } },
  comparison: { additionalBenefitCents: 55, additionalIndoorDropC: .4 }, application: { allowed: true }, ...extra });

test('exploration pins conditions and changes only local values until explicit comparison', async () => {
  const requests = [];
  const state = createHeatingExplorerState({ clock: () => now, request: async (path, body) => {
    requests.push({ path, body }); return makeResult(path.endsWith('/simulate') ? { previewId: 'synthetic-preview' } : {});
  } });
  await state.load(); state.edit('maxReductionHours', 8); state.edit('unknownLimit', 99);
  assert.equal(requests.length, 1);
  assert.deepEqual(state.snapshot().limits, { maxReductionHours: 8, maxDropC: 1.5 });
  await state.compare();
  assert.deepEqual(requests[1], { path: '/api/heating/explorer/simulate', body: {
    snapshotId: 'synthetic-snapshot', limits: { maxReductionHours: 8 },
  } });
  assert.equal(state.snapshot().dirty, false);
  assert.equal(state.snapshot().limits.maxReductionHours, 8, 'server current controls do not reset a hypothetical draft');
  state.reset();
  assert.equal(state.snapshot().dirty, false);
  assert.equal(state.snapshot().result.previewId, null);
  assert.equal(state.snapshot().limits.maxReductionHours, 4);
  assert.equal(requests.length, 2, 'reset is also read only');
});

test('busy requests suppress duplicate calculations and edits', async () => {
  let finish;
  const state = createHeatingExplorerState({ clock: () => now, request: () => new Promise(resolve => { finish = resolve; }) });
  const loading = state.load();
  assert.equal(await state.load(), false);
  state.edit('maxReductionHours', 8);
  assert.deepEqual(state.snapshot().limits, {});
  finish(makeResult()); await loading;
});

test('late comparisons and refreshes retain newer plan freshness and active trial updates', async () => {
  for (const refresh of [false, true]) {
    let finish, calls = 0;
    const state = createHeatingExplorerState({ clock: () => now, request: async () => ++calls === 1
      ? makeResult({ activeTrial: null }) : new Promise(resolve => { finish = resolve; }) });
    await state.load();
    if (refresh) state.markStale();
    const pending = refresh ? state.load() : state.compare();
    state.markStale();
    state.updateTrial({ id: 'newer-approved-cycle', status: 'pending' });
    finish(makeResult({ previewId: 'older-preview', activeTrial: null })); await pending;
    assert.equal(state.snapshot().stale, true, 'A late response cannot erase a newer plan change');
    assert.equal(await state.apply(), false);
    assert.equal(state.snapshot().result.activeTrial.id, 'newer-approved-cycle');
    state.reset();
    assert.equal(state.snapshot().stale, true);
    assert.equal(state.snapshot().result.activeTrial.id, 'newer-approved-cycle');
  }
});

test('a completed Refresh clears an earlier stale indication when no newer plan change arrives', async () => {
  const state = createHeatingExplorerState({ clock: () => now, request: async () => makeResult() });
  await state.load(); state.markStale(); await state.load();
  assert.equal(state.snapshot().stale, false);
});

test('a late read cannot restore private comparison data after sign-out', async () => {
  let finish;
  const state = createHeatingExplorerState({ clock: () => now, request: () => new Promise(resolve => { finish = resolve; }) });
  const loading = state.load(); state.clear(); finish(makeResult());
  assert.equal(await loading, false);
  assert.equal(state.snapshot().result, null);
  assert.equal(state.snapshot().busy, false);
});

test('edited and expired previews cannot be applied and expiration does not shift the reference', async () => {
  let clock = now;
  const requests = [];
  const state = createHeatingExplorerState({ clock: () => clock, request: async (path, body) => {
    requests.push({ path, body }); return makeResult({ previewId: 'synthetic-preview' });
  } });
  await state.load(); state.edit('maxReductionHours', 6);
  assert.equal(await state.apply(), false);
  await state.compare(); clock += 60_001;
  assert.equal(state.snapshot().stale, true);
  assert.equal(await state.apply(), false);
  assert.equal(await state.compare(), false);
  assert.equal(state.snapshot().result.snapshotAt, now);
  assert.equal(requests.length, 2);
});

test('failed refresh retains the draft while withdrawing previous execution eligibility', async () => {
  let calls = 0;
  const state = createHeatingExplorerState({ clock: () => now, request: async () => {
    if (calls++) throw Object.assign(new Error('sensitive household detail'), { status: 503 });
    return makeResult({ previewId: 'synthetic-preview' });
  } });
  await state.load(); state.edit('maxReductionHours', 8);
  assert.equal(await state.load(), false);
  assert.equal(state.snapshot().limits.maxReductionHours, 8);
  assert.equal(state.snapshot().result.snapshotId, 'synthetic-snapshot');
  assert.equal(state.snapshot().stale, true);
  assert.equal(await state.apply(), false);
  assert(!state.snapshot().message.includes('sensitive'));
});

test('approval automatically loads its selected plan while preserving the receipt and edited limits', async () => {
  const requests = []; let clock = now, approved = false;
  const trial = { id: 'synthetic-trial', status: 'pending' };
  const state = createHeatingExplorerState({ clock: () => clock, request: async (path, body) => {
    requests.push({ path, body });
    if (path.endsWith('/apply')) { approved = true; return { activeTrial: trial }; }
    return makeResult({ previewId: approved ? null : 'synthetic-preview', expiresAt: now + 2 * 86400_000,
      ...(approved ? { current: { approvalId: trial.id }, activeTrial: trial } : {}) });
  } });
  await state.load(); state.edit('maxReductionHours', 8); await state.compare();
  assert.equal(await state.apply(), true);
  assert.deepEqual(requests[2], { path: '/api/heating/explorer/apply', body: { previewId: 'synthetic-preview' } });
  assert.deepEqual(requests[3], { path: '/api/heating/explorer', body: undefined });
  assert.equal(state.snapshot().result.activeTrial.status, 'pending');
  assert.equal(state.snapshot().result.current.approvalId, trial.id);
  assert.equal(state.snapshot().limits.maxReductionHours, 8);
  assert.equal(state.snapshot().stale, false);
  assert.equal(await state.apply(), false, 'a completed submission cannot be sent again');
  assert.match(state.snapshot().receipt.message, /approved/);
  clock = now + 86400_000; assert.equal(state.snapshot().receipt, null);
});

test('a failed automatic read retains successful approval and fences the old capture against another approval', async () => {
  let approved = false;
  const state = createHeatingExplorerState({ clock: () => now, request: async path => {
    if (path.endsWith('/apply')) { approved = true; return { activeTrial: { id: 'synthetic-trial', status: 'pending' } }; }
    if (approved) throw Object.assign(new Error('synthetic read failure'), { status: 503 });
    return makeResult({ previewId: 'synthetic-preview', current: { approvalId: null } });
  } });
  await state.load();
  assert.equal(await state.apply(), true, 'A failed read must not turn a committed approval into a failed command');
  assert.equal(state.snapshot().result.activeTrial.id, 'synthetic-trial');
  assert.equal(state.snapshot().result.current.approvalId, null);
  assert.equal(state.snapshot().stale, true);
  assert.equal(state.snapshot().error, true);
  assert.match(state.snapshot().receipt.message, /approved/);
  assert.equal(state.snapshot().receipt.error, undefined);
  assert.equal(await state.apply(), false);
});

test('uncertain approval cannot be blindly retried and does not claim success', async () => {
  const state = createHeatingExplorerState({ clock: () => now, request: async path => {
    if (path.endsWith('/apply')) throw new TypeError('connection lost');
    return makeResult({ previewId: 'synthetic-preview' });
  } });
  await state.load(); assert.equal(await state.apply(), false);
  assert.equal(state.snapshot().stale, true);
  assert.equal(state.snapshot().receipt.error, true);
  assert.match(state.snapshot().message, /not be confirmed/);
  assert.equal(await state.apply(), false);
});

test('a stale server rejection retains the frozen comparison and requests refresh', async () => {
  const state = createHeatingExplorerState({ clock: () => now, request: async path => {
    if (path.endsWith('/simulate')) throw Object.assign(new Error('internal stale state'), { status: 409 });
    return makeResult();
  } });
  await state.load(); state.edit('maxReductionHours', 8);
  assert.equal(await state.compare(), false);
  assert.match(state.snapshot().message, /Refresh conditions/);
  assert.equal(state.snapshot().stale, true);
  assert.equal(state.snapshot().limits.maxReductionHours, 8);
});

test('cancel is limited to a pending or running cycle and leaves restoration visible', async () => {
  const requests = [];
  const state = createHeatingExplorerState({ clock: () => now, request: async (path, body) => {
    requests.push({ path, body });
    return path.endsWith('/cancel') ? { activeTrial: { status: 'cancelled' } }
      : makeResult({ activeTrial: { status: 'running' } });
  } });
  assert.equal(await state.cancel(), false);
  await state.load(); assert.equal(await state.cancel(), true);
  assert.deepEqual(requests[1], { path: '/api/heating/explorer/cancel', body: {} });
  assert.match(state.snapshot().receipt.message, /recovery and restoration still continue/);
  assert.equal(await state.cancel(), false);
});

test('comparison cards preserve negative savings and unknown average predictions', () => {
  const metrics = heatingComparisonMetrics(makeResult({ comparison: { additionalBenefitCents: -25, additionalIndoorDropC: .4 } }));
  assert.equal(metrics[0].value, '−€0.25');
  assert.equal(metrics[1].value, '1.1 °C');
  assert.equal(metrics[2].value, '6 h');
  const missing = heatingComparisonMetrics({ current: { outcomes: null }, scenario: { outcomes: null }, comparison: {} });
  assert.equal(missing[0].value, 'Unavailable');
  assert.equal(missing[1].value, 'Unavailable');
  assert.equal(missing[2].value, 'No reduction');
});

test('actual cycle updates leave pinned forecasts and hypothetical edits intact', async () => {
  const state = createHeatingExplorerState({ clock: () => now, request: async () => makeResult({ activeTrial: { id: 'one', status: 'pending' } }) });
  await state.load(); state.edit('maxReductionHours', 8);
  const frozen = state.snapshot().result.scenario;
  state.updateTrial({ id: 'one', status: 'running' });
  assert.equal(state.snapshot().result.activeTrial.status, 'running');
  assert.equal(state.snapshot().limits.maxReductionHours, 8);
  assert.equal(state.snapshot().result.scenario, frozen);
  state.updateTrial({ id: 'one', status: 'completed', outcome: { profitCents: 12 } });
  assert.equal(state.snapshot().result.activeTrial.outcome.profitCents, 12);
  assert.equal(state.snapshot().dirty, true);
});

test('unknown uncertainty breaks the chart allowance without becoming zero certainty', () => {
  const points = [0, 0, null, .3, .4, -1, .5, NaN, .6, .7]
    .map((uncertaintyC, index) => ({ at: now + index * 900_000, indoorC: 21, uncertaintyC }));
  const bands = heatingUncertaintyBands(points);
  assert.deepEqual(bands.map(band => band.map(point => point.uncertaintyC)), [[0, 0], [.3, .4], [.6, .7]]);
  assert.deepEqual(heatingUncertaintyBands(points.map(point => ({ ...point, uncertaintyC: null }))), []);
  assert.deepEqual(heatingUncertaintyBands([{ ...points[0], indoorC: null }, points[1]]), []);
});


test('cycle approval explains paid trials, modeled exposure and its separate control authority',()=>{
  const text=heatingApprovalText({controls:[{key:'maxTrialCostCents',value:150}],learningContext:{allowanceBasis:'reviewed-one-cycle'},scenario:{trial:true,
    estimatedBenefitCents:-25,trialExposureCents:40,outcomes:{maxIndoorDropC:1.25}}});
  assert.match(text,/extra cost.*€0.25/);assert.match(text,/exposure €0.40.*€1.50/);
  assert.match(text,/drop below Normal: 1.25 °C/);assert.match(text,/even if Home automation is paused or disabled/);
  assert.match(text,/saved choices and configured defaults stay unchanged/);
});


test('refresh retains explicit draft values while updating untouched defaults and withdrawing approval',async()=>{
  let generation=0;
  const state=createHeatingExplorerState({clock:()=>now,request:async()=>makeResult({snapshotId:`draft-${++generation}`,
    controls:[{key:'maxReductionHours',value:generation===1?4:6},{key:'maxDropC',value:1.5},
      {key:'savingsStrategy',value:'balanced'},{key:'minimumHomeBenefitCents',value:0,usesStrategyDefault:true},
      {key:'homeDiscomfortCentsPerDegreeSquaredHour',value:0,usesStrategyDefault:true}],previewId:null})});
  await state.load();state.edit('maxDropC',2);state.edit('savingsStrategy','gentle');state.edit('minimumHomeBenefitCents',0);
  await state.load({preserveDraft:true});const draft=state.snapshot();
  assert.equal(draft.limits.maxDropC,2);assert.equal(draft.limits.maxReductionHours,6);
  assert.equal(draft.limits.savingsStrategy,'gentle');assert.equal(draft.limits.minimumHomeBenefitCents,0);
  assert.equal(draft.limits.homeDiscomfortCentsPerDegreeSquaredHour,0);
  assert.equal(draft.dirty,true);assert.equal(draft.stale,false);assert.equal(await state.apply(),false);
  state.reset();assert.equal(state.snapshot().limits.maxDropC,1.5);
  assert.equal(state.snapshot().limits.savingsStrategy,'balanced');
});
