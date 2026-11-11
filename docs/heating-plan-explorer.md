# Heating plan explorer

Select the heating-plan row on the Home card to open the explorer. It also opens
when no change is planned: the reason for staying with normal heating is often
as useful as a proposed reduction. Family and admin users can inspect plans and
calculate hypothetical alternatives. An admin must explicitly authorize any
one-cycle application.

## Read the plan

The first capture shows one loading status. If it fails, **Retry loading** starts
a new read. Later refreshes keep the captured plan and edited limits visible;
a failed refresh leaves that comparison stale and unavailable for approval.

The window follows one reading order:

- **Selected heating plan** shows the captured controller selection and its
  timeline. **What shapes this plan** belongs to this section and shows that
  plan's effective limits and evidence, including any approved overrides.
- **Explore different limits** contains suggestions, editable limits, the scenario
  comparison and its approval action. **Limits & evidence for this scenario**
  describes that search; its rejections never replace the selected plan's context.
- **Approved heating cycle** identifies an active approval. **Last approved
  heating cycle** identifies an earlier record, with its approval time and status.
  It follows exploration and is collapsed initially when no longer active.

The selected plan and its context stay fixed across comparisons. An approval
record explicitly says whether it belongs to that captured plan, using the actual
approval identity. A newer record or an ended approval does not silently relabel
the capture. Approval automatically loads the newly selected plan while keeping
edited limits and the approval receipt. If that read fails, the approval remains
saved and the old capture stays visibly stale; retry the read rather than
approving again. Cancellation also automatically updates the selection. Reopening
a stale capture updates it while preserving edited limits. **Update & compare**
refreshes stale conditions and calculates the draft in one action. Expanding a
record or switching to it preserves drafts. If source evidence changes while a
comparison runs, calculation obtains a new capture and retries once with the
same edited limits. A changed opportunity still needs a separate explicit approval.

The normal-temperature reference reports its actual origin alongside the value:
learned, provisional learned, explicitly configured, retained for an accepted
cycle, measured at startup, or simulated. A resolved planning number alone does
not establish configuration ownership. If provenance is unavailable, the value
remains visible with **Origin unavailable**. Both selected and scenario evidence
use this same provenance; allowed temperature drop and rise are separate limits.

The plan describes the selected preheat, reduction and recovery phases. Times
use Finnish local time. Recovery completion is an estimate, not a fixed command
deadline. The predicted recovery period includes checking indoor and stored heat
against Normal heating and a settling interval; it can include ordinary heating
and does not mean continuous extra heating, even without a visible indoor drop.
Once treatment has begun, the explorer shows **completion unconfirmed** rather
than restarting the settling forecast from the current time. A fresh simulation
without the executed prefix cannot establish recovery of the original cycle.
Its recovery cost and electricity estimates also remain unavailable.
Reduced heating changes native heat demand; it does not promise that
the compressor will stop. The normal recovery hold and restoration duties still
apply; see [planning and recovery](learning-and-control.md#planning-and-recovery).
The Home card's **Planned actions** row shows the next scheduled action and its
time: preheat, reduced heating, recovery, the end of manual preheat, or an
automatic resume. Manual preheat and automatic resume have independent deadlines;
the earlier action appears first. With no scheduled action it reads **No actions
scheduled**, including during an indefinite pause. The **Heat control** badge shows
the current Automatic / Paused choice. Heating can continue while paused.
Recovery does not promise a completion time; the row reads **Next action after
recovery**. Missing timing remains explicitly unavailable. Simulation uses
**Simulated actions**, and history views show **Recorded plan**. Select **Explore**
to inspect the plan and alternatives, even when no action is scheduled.

Configured policy limits, learning evidence, forecast coverage and equipment
readiness have different effects. For example, raising a configured reduction ceiling cannot manufacture evidence for longer
reductions. Shared defaults are 12 hours occupied and 24 hours away; an explicit
installation override can set a shorter ceiling. The
planner starts from explicit initial estimates and refines them with observed
response. Lack of previous trials is not a separate execution prohibition.
Preheat also requires evidence for its actual native ROOM increase. A longer
demonstrated duration does not establish support for a larger ROOM increase;
the explorer and Learning details show the separate demonstrated limit.

A limit being reached does not establish that it prevents a better choice.
An opportunity to review is supported by a tested alternative, with its estimated
benefit and tradeoffs. This is advice about the captured conditions, not a finding
that the household's chosen limit is wrong. Repeated simulations add no learning
evidence and do not justify a permanent recommendation.

## Explore limits

Change a hypothetical limit and calculate a comparison. The available controls
cover reduction and preheat duration, permitted indoor-average drop and rise,
savings strategy and the native ROOM increase used for preheat. The ceiling is
the maximum permitted duration; it does not force the planner to choose that
duration. Several limits can be changed together.

The separate approval record follows exploration and review. Its status, approval and
execution times, authorization deadline and outcome assessment are separate.
**Approved limits** expands the original authorized values without changing them.
A future authorization deadline does not mean an interrupted or completed cycle
is still active. Missing recovery evidence leaves savings unassessed; restoration
remains independent. Recorded cost differences still use an estimated Normal
heating reference and do not establish measured savings or model validation.

The approval summary names the scenario's actual reduction duration and window.
An illustration of using the full duration limit has its own disclosure and cannot
be approved. After a successful approval, the window opens and focuses the newly
approved cycle's record. Active and historical record contents use the same layout;
polling preserves the reader's chosen disclosure state for that approval.
Closing the plan window after confirming approval does not withdraw that action
or reopen the window when its response arrives. Reopening shows the saved result.

The main controls remain visible on narrow and wide screens. Less frequently
changed budget and economic controls are under **Advanced settings**, initially
folded. Each control has an explanation popup available by click, tap or keyboard.
Savings strategy changes only the share of the best eligible conservative saving
to retain; the monetary fields remain independent. Reduction limit without pump
telemetry ends the upper Advanced settings region. A separate **Learning trials**
box follows, with **Enable learning trials** in its heading. Its two body inputs
are **One-cycle experiment budget** and **Learning priority price threshold**;
both remain visible but disabled when trials are unchecked. Exploration follows
the selected plan directly. A suggestion’s **Use in scenario** action fills the
draft and focuses the first changed field for review; **Compare scenario** runs
the calculation. **Reset to configured limits** is available after draft edits,
a comparison or an error and resets locally without refreshing conditions.
Enter durations and monetary limits directly; several limits can be reviewed together. These are one-cycle
preferences, with wider ranges than the automatic defaults.

The checkbox initially follows automatic trial permission. An untouched budget
keeps the captured automatic per-cycle limit and remaining daily allowance;
changing only the checkbox or priority grants no new allowance. Only changing the
budget supplies a separate allowance for the reviewed cycle. Zero permits only
zero-exposure trials. An uncaptured remaining allowance stays unavailable, never
an invented zero or full budget. Home automatic permission remains independent.

**Reset to captured baseline** restores the loaded plan, settings and budget
context locally without another optimization or request. It does not cancel an
active cycle. **Refresh conditions** explicitly captures a new baseline, retaining
edited drafts; a later Reset restores that new baseline. A live plan change makes
the older comparison stale instead of silently rewriting its original context.
Closing and reopening the window retains the capture and draft until Refresh.

| Explorer control | Related automatic configuration | Manual range |
| --- | --- | --- |
| Maximum reduction | `controller.max_reduction_hours` | 0.25–46 hours |
| Maximum reduction while away | `controller.max_away_reduction_hours` | 0.25–46 hours |
| Reduction limit without pump telemetry | `controller.max_unobserved_reduction_hours` | 0.25–46 hours; an additional ceiling within the ordinary reduction limit |
| Allowed average temperature drop | `controller.max_drop_c` | 0–35 °C |
| Allowed average temperature rise | `controller.max_rise_c` | 0.25–35 °C |
| Maximum preheat | `controller.max_preheat_hours` | 0.25–24 hours |
| ROOM setting increase | `controller.preheat_room_boost_c` | Whole degrees, 1–5 °C, within native ROOM headroom |
| Enable learning trials | `controller.learning_trials` | Boolean; reviewed cycle only, independent of saved permission |
| One-cycle experiment budget | `controller.max_trial_cost_cents` | Nonnegative cents; separate from the automatic daily experiment budget |
| Minimum estimated saving | `controller.minimum_home_benefit_cents` | Cents; a negative value explicitly permits estimated extra cost |
| Temperature deviation penalty | `controller.home_discomfort_cents_per_degree_squared_hour` | Nonnegative cents per °C²-hour |
| Cycle start penalty | `controller.cycle_start_cost_cents` | Nonnegative cents |
| Preheat/reduction duration penalty | `controller.cycle_hour_cost_cents` | Nonnegative cents per extra preheat/reduction hour |
| Minimum savings uncertainty deduction | `controller.economic_uncertainty_floor_cents` | Minimum savings deduction, in nonnegative cents |
| Learning priority price threshold | `controller.learning_priority_price_cents` | Nonnegative cents per kWh; priority threshold, not a trial price ceiling |
| Savings strategy | `controller.savings_strategy` | Gentle (60%), Balanced (80%), More savings (100%); percentage only |

Duration ranges fit the bounded 48-hour forecast and its recovery coverage; they
are not promises that forecasts or the selected schedule cover the full range.
Native overrides retain bounded leases and refresh only with current authority.
The telemetry ceiling uses fresh native setting observations, separately from
readiness to issue another setting change. The controller's own preparation or
restoration does not create a telemetry outage. Disconnected, stale or missing
native settings, and disabled native writes, retain the additional ceiling;
actuator readiness and restoration still constrain execution independently.

The current plan and alternatives share one captured set of temperatures, stored
heat, model, weather, prices, occupancy and equipment evidence. Polling does not
silently replace the baseline or discard edits. Refresh the comparison when it
becomes stale. **Refresh conditions** keeps explicitly edited limits, updates
untouched defaults and requires a new comparison before approval. **Reset to
captured baseline** discards those edits and restores the captured plan, limits
and automatic allowance context locally, without a refresh or optimization.
A retained current schedule remains distinct from a fresh planner choice under
unchanged settings. When they differ, the comparison explicitly labels its
additional saving as a fresh calculation with unchanged limits; that difference
does not arise from edited limits.

Compare the additional estimated saving against the current plan first. The
comparison with normal heating is also available. Cost and energy cover modeled
space heating over the evaluated horizon, including recovery. Cost also includes
an estimated cost for remaining thermal deficit; electricity totals exclude
that unobserved tail and show its estimate separately. Hot-water demand and
recovery are not counterfactually modeled;
the figures are not measured whole-house or bill savings.
All comparisons begin at the captured time. For a cycle already running, its
earlier actions and recorded costs are outside this forward comparison; the
recorded cycle assessment retains them. Indoor extremes include the captured
starting temperature, so an initially cold or warm room average is not hidden
by its first modeled recovery step.

Temperature checks use the same configured indoor average and single normal
reference as the Home model. Individual room limits and offset forecasts are not
part of this policy. A bounded estimate for one unavailable room retains its
weight and adds uncertainty; it cannot start a learning trial. The comparison
identifies that estimated starting point and its initial uncertainty allowance.
Temperature allowances and adverse physical scenarios are engineering uncertainty estimates,
not statistical confidence levels. Initial estimates support execution before independent validation; configured
temperature limits and adverse physical scenarios still apply. Demonstrated
durations report evidence for comparable executed treatments, rather than a
hidden startup limit.
Unknown uncertainty interrupts the chart's shaded allowance and is labelled
unavailable; it never appears as a zero-width certainty band.

When the selected ceiling is longer than the eligible plan and forecast coverage
permits it, an additional fixed-duration illustration shows the requested longer
reduction. It is explicitly outside demonstrated coverage where applicable and
cannot be applied through the approval button. It can also fail comfort or
economic checks even when sufficient duration evidence exists.

The same production planner and predictor calculate comparisons. Their search is
bounded: the chosen alternative is not proof of a global optimum. Simulation
does not send commands, change defaults, replace the pending plan, reserve a trial
budget or update learning.

Comparisons require recently updated controller conditions. If these are unavailable,
the planner directs you to Recording status before refreshing; repeatedly refreshing
cannot repair a failing controller update. Other comparison failures retain their
separate unavailable or retry messages.

## Use a scenario for one cycle

The admin action applies a reviewed scenario to a specific upcoming opportunity,
with a visible expiry. Under the owner-approved 2026-11-04 policy, approval grants
a separate one-cycle authority even while Home automatic control is paused or
disabled. It preserves those saved choices and cannot override an independent
manual action or grant authority to a history viewer or slave. The server enforces
this independently of the buttons. The approved opportunity may start within
the available forecast. Its remaining treatment may start within the original
cycle window, before reduction ends; missing an earlier preheat start does not
invalidate the remaining reduction. The outer scope expires after the planned reduction
and the configured recovery timeout, or earlier when the cycle ends. History and
slave views show recorded-plan context; live simulation is unavailable there.

The confirmation summarizes estimated saving or extra cost against Normal,
maximum predicted temperature drop and any learning-trial cost exposure and
reviewed budget. The approval uses server-held comparison data. It is bound to the current
equipment and configuration, expires, and is checked again before the cycle
starts. Changes before approval can require a fresh comparison. After approval, missing
feeds or model work retain the accepted opportunity and its estimates. Routine water-temperature, integral, runtime-counter and compressor
cycle updates do not erase the reviewed opportunity. The original approved schedule remains separate from execution adjustments.
Current device capability, equipment identity, independent instructions and native
protection still govern dispatch. Remaining preheat can be moved or shortened
without moving reduction. The same accepted-cycle continuation policy applies
to automatic and approved cycles; see [accepted schedules](learning-and-control.md#accepted-schedules-and-continuation).
If a device acknowledgement arrives after the start window or approval scope has
ended, the exposure remains recorded, and recovery ends the approved action
without renewing permission or discarding restoration duties.

Admin-selected temperature limits are explicit temporary preferences. A
reviewed drop greater than 2°C overrides that ordinary occupied guard for this
cycle. Provisional model/reference quality and previous demonstrated durations
add no hidden policy cap. An explicit experiment budget can enable learning
for this cycle even when automatic experiments are disabled or their daily
budget is exhausted; its accepted exposure is separate from that automatic
budget. Zero experiment budget permits only trials with no modeled extra cost or
displaced saving; the separate automatic experiment switch still disables
automatic trials. A negative minimum estimated saving permits a deliberately
paid economic cycle, separately from the learning budget.
Native protections, real device capability, current inputs and durable
restoration remain required. Approval is checked again after queued intent writes
and before new activation. The action never writes configuration defaults. A permanent change
uses the existing configuration source and **Apply reviewed configuration**.

An unused approval cannot silently transfer to another opportunity. Cancellation
ends the authorized scope; an active cycle follows the normal restoration and
recovery path. Cancellation does not pause Automatic or remove ordinary
scheduling: an unused approval returns to selection under the configured limits.
That automatic plan can use similar times, but does not retain the cancelled
approval's identity or one-cycle preferences. A newly calculated scenario can explicitly **Replace approved
cycle** while the previous approval has not started. Confirmation identifies that
replacement; the old approval ends only when the new one commits successfully.
A changed approval or a cycle that started during review rejects the replacement.
Changing the saved Automatic / Paused choice does not cancel this
independent reviewed cycle; use its cancellation action to end it. Closing the browser does not cancel a cycle or erase restoration
obligations. Restart preserves the approval and its original expiry. The existing executor
reconciles outstanding physical obligations before the currently due feasible
action resumes; copied intent cannot grant a slave or replacement equipment
control authority.

## What the model learns

Approval context accompanies the real cycle's frozen plan, forecast and recorded
outcome. Actual qualifying observations pass through the existing learning
journal and completion checks. Incomplete attempts remain incomplete and cannot
certify successful full-cycle validation. An approval or simulation alone supplies
no training data.

Comparison snapshots are short-lived and bounded in memory. There is no new
archive of every slider movement or every planning tick. Existing cycle and
journal records retain their provenance and reconstruction meaning; see
[model reconstruction](reconstruction-and-versioning.md).

## API and bounded work

`GET /api/heating/explorer` captures a fresh comparison. Family and admin can call
`POST /api/heating/explorer/simulate` with `{snapshotId, limits}`; only the documented
policy fields are accepted. Admin-only `POST /api/heating/explorer/apply` accepts
the server's `previewId`, and `POST /api/heating/explorer/cancel` accepts
`{approvalId}` for the exact record being cancelled. A late cancellation cannot
cancel a newer approval. A client-supplied schedule or model cannot authorize control.

`current.constraints` describes the captured selected plan's effective policy and
evidence, independently of scenario `constraints`. `current.approvalId` identifies
its actual one-cycle approval, or is null. A match with `activeTrial.id` establishes
the record relationship; status text, similar dates or similar limits do not.

Snapshots expire after five minutes and require a planning input no more than two
minutes old. The service keeps at most eight snapshots and sixteen approval
previews, with eight cached comparisons per snapshot. Computation runs in a
worker with one active request, at most two queued requests and a thirty-second
deadline. These limits bound workload; they do not imply a guaranteed response
time on every host. Simulation writes no database records. Explicit approvals
and real cycle outcomes use the existing state, events, cycle and journal stores.
