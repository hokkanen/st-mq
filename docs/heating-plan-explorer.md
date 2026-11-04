# Heating plan explorer

Select the heating-plan row on the Home card to open the explorer. It also opens
when no change is planned: the reason for staying with normal heating is often
as useful as a proposed reduction. Family and admin users can inspect plans and
calculate hypothetical alternatives. An admin must explicitly authorize any
one-cycle application.

## Read the plan

The plan describes the selected preheat, reduction and recovery phases. Times
use Finnish local time. Recovery completion is an estimate, not a fixed command
deadline. Reduced heating changes native heat demand; it does not promise that
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
readiness have different effects. For example, raising the configured four-hour
reduction ceiling cannot manufacture evidence for eight-hour reductions. The
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

The main controls remain visible on narrow and wide screens. Less frequently
changed budget and economic controls are under **Advanced settings**, initially
folded. Each control has an explanation popup available by click, tap or keyboard.
Enter durations and monetary limits directly; several limits can be reviewed together. These are one-cycle
preferences, with wider ranges than the automatic defaults.

| Explorer control | Related automatic configuration | Manual range |
| --- | --- | --- |
| Maximum reduction | `controller.max_reduction_hours` | 0.25–46 hours |
| Maximum reduction while away | `controller.max_away_reduction_hours` | 0.25–46 hours |
| Reduction limit without pump telemetry | `controller.max_unobserved_reduction_hours` | 0.25–46 hours |
| Allowed average temperature drop | `controller.max_drop_c` | 0–35 °C |
| Allowed average temperature rise | `controller.max_rise_c` | 0.25–35 °C |
| Maximum preheat | `controller.max_preheat_hours` | 0.25–24 hours |
| Preheat ROOM setting increase | `controller.preheat_room_boost_c` | Whole degrees, 1–5 °C, within native ROOM headroom |
| One-cycle experiment budget | `controller.max_trial_cost_cents` | Nonnegative cents; separate from the automatic daily experiment budget |
| Minimum estimated saving | Savings strategy's benefit hurdle | Cents; a negative value explicitly permits estimated extra cost |
| Temperature deviation penalty | `controller.home_discomfort_cents_per_degree_squared_hour` | Nonnegative cents per °C²-hour |
| Cycle start penalty | `controller.cycle_start_cost_cents` | Nonnegative cents |
| Preheat/reduction duration penalty | `controller.cycle_hour_cost_cents` | Nonnegative cents per extra preheat/reduction hour |
| Minimum savings uncertainty deduction | `controller.economic_uncertainty_floor_cents` | Minimum savings deduction, in nonnegative cents |
| Learning priority price threshold | `controller.learning_priority_price_cents` | Nonnegative cents per kWh; priority threshold, not a trial price ceiling |
| Savings strategy | `controller.savings_strategy` | Gentle, Balanced, More savings |

Duration ranges fit the bounded 48-hour forecast and its recovery coverage; they
are not promises that forecasts or the selected schedule cover the full range.
Native overrides retain bounded leases and refresh only with current authority.

The current plan and alternatives share one captured set of temperatures, stored
heat, model, weather, prices, occupancy and equipment evidence. Polling does not
silently replace the baseline or discard edits. Refresh the comparison when it
becomes stale. **Refresh conditions** keeps explicitly edited limits, updates
untouched defaults and requires a new comparison before approval. **Reset to
configured limits** discards those edits. A retained current schedule remains distinct from a fresh planner
choice under unchanged settings.

Compare the additional estimated saving against the current plan first. The
comparison with normal heating is also available. Cost and energy cover modeled
space heating over the evaluated horizon, including recovery. Cost also includes
a priced allowance for remaining thermal deficit; electricity totals exclude
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

## Use a scenario for one cycle

The admin action applies a reviewed scenario to a specific upcoming opportunity,
with a visible expiry. Under the owner-approved 2026-11-04 policy, approval grants
a separate one-cycle authority even while Home automatic control is paused or
disabled. It preserves those saved choices and cannot override an independent
manual action or grant authority to a history viewer or slave. The server enforces
this independently of the buttons. The approved opportunity may start within
the available forecast; it has a five-minute latest-start grace period. The outer scope expires after the planned reduction
and the configured recovery timeout, or earlier when the cycle ends. History and
slave views show recorded-plan context; live simulation is unavailable there.

The confirmation summarizes estimated saving or extra cost against Normal,
maximum predicted temperature drop and any learning-trial cost exposure and
reviewed budget. The approval uses server-held comparison data. It is bound to the current
equipment and configuration, expires, and is checked again before the cycle
starts. Changes to the model, weighted room readings, forecasts, settings, protection or readiness
can reject it. Routine water-temperature, integral, runtime-counter and compressor
cycle updates do not erase the reviewed opportunity. The exact approved schedule
is still revalidated with current physical inputs before dispatch; a preview does
not freeze equipment conditions or bypass those checks. During execution the existing
comfort, forecast, equipment and economic checks can shorten the cycle.
If a device acknowledgement arrives after the start window or approval scope has
ended, the exposure remains recorded, and recovery ends the approved action
without renewing permission or discarding restoration duties.

Admin-selected temperature allowances are explicit temporary preferences. A
reviewed drop greater than 2°C overrides that ordinary occupied guard for this
cycle. Provisional model/reference quality and previous demonstrated durations
add no hidden policy cap. An explicit experiment budget can enable learning
for this cycle even when automatic experiments are disabled or their daily
allowance is exhausted; its accepted exposure is separate from that automatic
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
recovery path. Changing the saved Automatic / Paused choice does not cancel this
independent reviewed cycle; use its cancellation action to end it. Closing the browser does not cancel a cycle or erase restoration
obligations. Restart ends the approval and requires a fresh comparison; the
existing executor still owns any outstanding physical restoration.

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
the server's `previewId`, and `POST /api/heating/explorer/cancel` accepts an empty
object. A client-supplied schedule or model cannot authorize control.

Snapshots expire after five minutes and require a planning input no more than two
minutes old. The service keeps at most eight snapshots and sixteen approval
previews, with eight cached comparisons per snapshot. Computation runs in a
worker with one active request, at most two queued requests and a thirty-second
deadline. These limits bound workload; they do not imply a guaranteed response
time on every host. Simulation writes no database records. Explicit approvals
and real cycle outcomes use the existing state, events, cycle and journal stores.
