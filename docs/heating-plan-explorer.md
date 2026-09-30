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

Configured policy limits, learning evidence, forecast coverage and equipment
readiness have different effects. For example, raising the configured four-hour
reduction ceiling cannot manufacture evidence for eight-hour reductions. The
planner retains its existing validated-duration and bounded-trial checks.

A limit being reached does not establish that it prevents a better choice.
An opportunity to review is supported by a tested alternative, with its estimated
benefit and tradeoffs. This is advice about the captured conditions, not a finding
that the household's chosen limit is wrong. Repeated simulations add no learning
evidence and do not justify a permanent recommendation.

## Explore limits

Change a hypothetical limit and calculate a comparison. The available controls
cover reduction and preheat duration, permitted room-temperature drop and rise,
savings strategy and the native ROOM increase used for preheat. The ceiling is
the maximum permitted duration; it does not force the planner to choose that
duration. Several limits can be changed together.

| Explorer control | Permanent configuration field | Supported range |
| --- | --- | --- |
| Maximum reduction | `controller.max_reduction_hours` | 0.25–12 hours |
| Maximum reduction while away | `controller.max_away_reduction_hours` | 0.25–24 hours |
| Allowed room-temperature drop | `controller.max_drop_c` | 0–2 °C |
| Allowed room-temperature rise | `controller.max_rise_c` | 0.25–2 °C |
| Maximum preheat | `controller.max_preheat_hours` | 0.25–6 hours |
| Preheat ROOM increase | `controller.preheat_room_boost_c` | Whole degrees, 1–5 °C |
| Savings strategy | `controller.savings_strategy` | Gentle, Balanced, More savings |

The current plan and alternatives share one captured set of temperatures, stored
heat, model, weather, prices, occupancy and equipment evidence. Polling does not
silently replace the baseline or discard edits. Refresh the comparison when it
becomes stale. A retained current schedule remains distinct from a fresh planner
choice under unchanged settings.

Compare the additional estimated saving against the current plan first. The
comparison with normal heating is also available. Cost and energy cover modeled
space heating over the evaluated horizon, including recovery. Cost also includes
a priced allowance for remaining thermal deficit; electricity totals exclude
that unobserved tail and show its estimate separately. Hot-water demand and
recovery are not counterfactually modeled;
the figures are not measured whole-house or bill savings.

Room-temperature checks preserve each participating room's current offset and
recent trend. They are conservative proxies, not separately identified room
models. Temperature allowances and adverse physical scenarios are engineering
uncertainty estimates, not statistical confidence levels. A prediction outside
demonstrated operating coverage does not become an executable plan merely because
its nominal temperature looks acceptable.

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
with a visible expiry. Home must already permit Automatic heating. Approval does
not enable it, override a manual action or grant control to a history viewer or
standby instance. The server enforces this independently of the buttons.
The approved opportunity must start within six hours; it has a five-minute
latest-start grace period. The outer scope expires after the planned reduction
and the configured recovery timeout, or earlier when the cycle ends. History and
standby views show recorded-plan context; live simulation is unavailable there.

The approval uses server-held comparison data. It is bound to the current
equipment and configuration, expires, and is checked again before the cycle
starts. Changed or missing evidence can reject it. During execution the existing
comfort, forecast, equipment and economic checks can shorten the cycle.

Admin-selected temperature allowances are explicit temporary preferences within
the supported settings ranges. Absolute comfort protection, native protections,
readiness, learning evidence and trial cost bounds are not adjustable execution
bypasses. The action never writes configuration defaults. A permanent change
uses the existing configuration source and **Apply configuration**.

An unused approval cannot silently transfer to another opportunity. Cancellation
ends the authorized scope; an active cycle follows the normal restoration and
recovery path. Closing the browser does not cancel a cycle or erase restoration
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
