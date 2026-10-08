# Charging planning

[Charging overview](../charging.md) · [Code map](architecture.md)

This contract owns forecast delivery, joint period selection and economic feasibility. Proposed periods are separate from [confirmed execution](execution-and-recovery.md) and [live current allocation](current-allocation.md).

## Planning and Equalizer

The global priority setting is **balanced**, **Charger 1**, or **Charger 2**. It belongs to the physical charging point and immediately revises allocation when changed. The revision invalidates queued intentions without resetting session requests, manual instructions, metered energy or cost.

A request edit, Automatic change or Charge now action can also revise the other
charger's schedule. Both affected controllers discard outdated pending commands
and reconcile the new joint result. Confirmed native execution remains separate
from a proposed replacement until readback establishes the change. An arriving
price forecast can establish the first automatic program after connection.

Change priority in either charger's details. Both entries edit the same saved
choice, which survives restart and new vehicle connections for the same physical
chargers. Automatic charging is also a persistent dashboard choice; the four
ready-by and battery defaults remain configuration-owned.

The planner first respects known applicable device/vehicle limits, manual permission, native start times and credible capacity. It protects both deadlines where the modeled opportunities allow that. Actual all-in electricity cost then governs period selection. Priority must not buy more expensive energy merely to favor a charger. In infeasible cases, charger priority favors its remaining request; balanced mode shares normalized shortfall. Eligible charging time and grid-energy need determine pressure. Shared budgets below two minimum currents use bounded time slices rather than invalid sub-minimum simultaneous commands.

### Maximum-available-current assumption

When a connected charger's future charging current is unknown, assume the
maximum it can deliver within its configured/verified charger ceiling and the
forecast property headroom on each phase after household and peer load. Apply
the same rule to either charger, including a newly connected charger whose
current readback or control readiness is unavailable. Use the assumed current
for delivered-energy estimates, charging duration, completion and selection of
cheap periods. The joint allocation shares the available property capacity;
it does not give each charger the same spare capacity independently.

This is an optimistic delivery forecast. It is not a permanent worst-case
reservation of the peer's maximum draw. Do not invent hidden vehicle timers,
unknown low current settings or speculative restrictions and then release
economic pauses to compensate. Missing vehicle identification or battery inputs
continue to use the applicable configured request defaults and existing session
anchors. Known applicable native/manual, vehicle, cable, installation and
electrical limits still constrain the forecast, including a confirmed 6 A
setting or a known vehicle not-before time. Observed low draw by itself does
not establish a lasting current restriction.
For Shelly with current adjustment enabled, an adjustable current choice is
applicable according to its [session precedence](execution-and-recovery.md#automatic-takeover-and-native-instructions).
A setting carried into a new connection is not a permanent forecast cap; a later
external choice remains binding until unplugging or explicit **Use automatic**.

Expose the maximum-available-current assumption with the proposed plan, keep
estimated delivery and completion distinct from measured progress, and recompute
when usable limit, household-load, peer or vehicle evidence changes. A missing
charger-current input must not alone mark a price plan infeasible or select an
immediate release. Control readiness is separate: an unavailable charger can
have an assumption-based forecast without an accepted schedule, and that
forecast supplies no authority to send commands or proof of physical response.

A real modeled deadline shortfall, a known restrictive timer, or absence of
usable shared prices/property-capacity evidence still needs its specific
feasibility or fallback result. Do not collapse those reasons into an unknown
charger-current restriction. Confirmed execution and applicable requests govern
participation in immediate allocation. Measured draw establishes household
demand after subtracting the chargers, not the peer's entitlement. A forecast
never establishes that an unavailable charger has paused or accepted a lower
current; Equalizer's delayed response does not redistribute Shelly's entitlement.

Regression coverage must include a feasible delayed Charger 1 plan followed by
Charger 2 connecting with unknown current and unavailable control. With usable
prices, property headroom and sufficient modeled opportunity, both requests
remain represented and Charger 1 keeps a feasible price schedule instead of
being released solely because Charger 2 is unready. Also cover max-available
delivery estimates, a later known lower limit, joint per-phase allocation and
the unchanged command-readiness gates.

### Joint allocation and execution

The expensive joint search runs in one local worker, with one active calculation,
the latest pending control calculation and at most one pending cost comparison.
Control calculations take queue priority. Repeated equivalent inputs reuse a bounded
cache for at most 30 seconds and never across a schedule, allocation or deadline
boundary. Results retain their calculation time. Changed requests, connections,
native instructions, authority, source selection or expired results are checked
before publication; stale work cannot replace the current plan. Accepted session
evidence and progress are saved independently while planning runs. Device
readback and command fencing remain authoritative.

The implementation is a bounded search over a declared slot/current model, **not a globally exact continuous-time optimizer**. Results expose the search kind, relaxed cost lower bound, feasible candidate cost and upper bound on the cost gap where available. Search pruning can miss a better joint candidate; reported feasibility is conditional on the recorded assumptions. Synthetic exhaustive small-horizon comparisons validate representative cases. There is no one-cent pause penalty or mandatory one-cent saving hurdle. Practical minimum economic runs/gaps remain 15 minutes; equal-cost choices prefer stability.

Alongside continuous starts and individual period improvements, freely scheduled
requests receive one shared-period candidate. It selects cheaper windows using
their combined modeled capacity so both chargers can move together when an
incumbent peer allocation would block an individual improvement. The same
chronological joint simulator and bounded individual refinement validate service,
priority, per-phase/scenario limits and cost. Native timers and period-count
limits constrain this candidate; fixed permissions are never moved. The existing
best candidate remains available, and pooled capacity is not proof that every
individual deadline can be met. Positive and negative prices use the same cash
objective; this additional seed does not establish global optimality.

If the ordinary search finds no feasible schedule, one additional candidate uses
the separate windows in which a fixed native current fits every forecast phase
and scenario. This recovers earlier charging opportunities that a later household
peak would exclude from a continuous period. The joint simulator still checks
peer allocation, native restrictions, fixed periods and schedule limits; the same
service, priority and cost comparison selects the result. This bounded fallback
does not add search work to already-feasible plans or promise exhaustive recovery.

Running-session readiness and price-driven interruption decisions reassess both
adopted executions together with the selected priority. A cheaper replacement
must preserve modeled feasibility and reduce combined cost. A final open release
retains its charging permission while remaining part of shared current allocation;
it does not reserve the charger's entire current ceiling against its peer.
Independently observed native/manual activity is likewise accounted for without
granting the economic scheduler new permission to change that activity.
Charger 2's prospective current command uses Charger 1's confirmed permission,
so an unconfirmed replacement cannot manufacture spare capacity.
Below the capacity needed to run both cars, balanced sharing retains an existing
allocation for at most its current 15-minute slice. Accepted session progress
keeps repeated replanning from continually favoring the same car; changed limits,
native permission or a deadline that can still be met override that hold. A car
that has met its requested minimum receives residual adjustable capacity after
outstanding requests, while its final charging permission remains open.
Shelly records the program currently accepted by its controller, including
intermediate pauses. Its future transitions still require the application;
this execution record does not represent a device-local timer.

Planned charging power and duration use the latest published smoothed voltage
estimate for each physical phase. The same estimates convert future household
power into current. These are six-hour-half-life estimates, established after one
hour of valid elapsed acquisition coverage and recorded adaptively with a 0.5 V
minimum change floor. The planner reads recorded values, not small internal
smoothing updates. Each phase prefers Charger 1 OCPP, Charger 1 Easee Cloud, then
Equalizer Easee Cloud. Charger 2 cannot supply shared estimates or provisional
startup voltage because its phase order is not verified against these sources.
Shared smoothing retains compact
contributing-source provenance across feed changes, with stable source recovery.
Valid live local voltage may serve provisionally before an
estimate exists; remote vehicle voltage and nominal defaults cannot supply
missing household evidence. A saved estimate after restart is historical context,
not proof of a fresh live electrical measurement. See
[voltage recording and historical interpretation](../recording.md#smoothed-phase-voltage).

Household energy history retains per-phase power for forecast scenarios and
converts it with the present planning voltage. Historical chart conversions still
use the voltage estimates applicable at the original time. Original imported
current readings keep their measured-current meaning. When an
imported calculation needs voltage before estimate history begins, it uses the
first fully established per-phase database estimates as labelled retrospective
assumptions. Later voltage changes cannot rewrite that early-CSV basis. Measured
energy, charging progress and billed interval energy never depend on those
retrospective voltage assumptions.

For unchanged charging intent, a proposed adjustment of up to two minutes to
future waiting-period boundaries may retain the existing periods. The planner
rechecks both chargers together under the new forecasts: every deadline must
remain feasible, and neither the combined estimate nor either charger's cost may
exceed the new candidate by more than 0.1 cent. The period count must agree.
Changed prices, priorities, requests, connection, observed battery charge,
capacity, targets or current limits bypass this retention. Delivered-energy
progress is rechecked in the joint simulation without treating every small meter
increment as new intent. Running periods and starts within the next two minutes
are not retained by this rule. The retained schedule is the actual plan, so session
diagnostics do not log discarded candidate movements as schedule changes.

Live property and charger currents establish actual draw and household phase
demand. Shelly applies the same priority, energy and deadline allocation policy
to admitted present household headroom; absolute forecast shares do not become
extra reservations against that headroom. It reduces for property
protection only when household demand plus Shelly alone exceeds the effective
configured phase limit. A change in Charger 1's draw, Equalizer allowance or
response delay cannot by itself redistribute that entitlement. Live voltage
remains appropriate for
current electrical readings and integration paths that genuinely require it.
Neither smoothing nor schedule stability can relax native limits, telemetry
freshness, control authority, changed session requests or a missed deadline.

Easee's Equalizer, charger and vehicle determine the available charging current. Native OCPP economic pauses impose an expiring 0 A restriction; identification probes briefly release the owned pause at normal current before returning to that economic pause or normal charging. This never raises native limits or changes circuit protection or fuse settings. Current already drawn by an automatic-OFF, manually running or post-target peer remains a load until physical evidence says otherwise. Forecast household load, gross configured capacity and current net allowance are distinct. A clipped zero Equalizer allowance does not establish an exact gross budget. Missing shared rates or usable property capacity produce provisional decisions, not free electricity or invented assured readiness; unknown charging-current restrictions use the maximum-available-current planning assumption.

Capacity estimates count contributing source observations, not polling frequency.
When Easee reports an idle cloud mode or OCPP connector status and less than
0.1 A on every phase, new charger
meter timestamps or small idle-current fluctuations cannot count the same held
allowance and property observations again. Their original source clocks determine
sample identity and age; the accepted sample retains the measured subtraction.
Fresh allowance or property observations still contribute, and charger currents
and their clocks remain contributors during actual draw or an unconfirmed idle
state. Restart preserves the bounded evidence history without making it fresh.
Temporarily missing native allocation or circuit metadata cannot erase that
history as if the installation had changed. The estimate remains unavailable
until the current metadata is confirmed; a confirmed configuration change still
invalidates the old evidence. Expiry retains the original source clocks.
These forecast estimates never replace live headroom or native electrical limits.

The final period is an open release. Reaching the planning minimum or ready-by deadline does not issue a final stop. Extra actual energy remains metered and priced. Unknown future post-target consumption cannot have a guaranteed optimized bill. Later economic pauses require ST-MQ and the provider to be available; the UI distinguishes the proposed plan, dispatched request, readback and observed physical response.

## Schedules inside the vehicle

[TeslaMate MQTT](https://docs.teslamate.org/docs/integrations/mqtt/) exposes
`scheduled_charging_start_time`. ST-MQ uses that next start when selecting the
cheapest feasible charging periods. Unchanged settings keep their original
receipt/provenance while live TeslaMate health establishes feed availability.
This is not a complete weekly schedule: the standard MQTT feed does not expose
all recurrence rules and end times. An absent start does not prove that every
vehicle-side restriction is disabled. For planning, an unknown restriction does
not create an assumed timer or reduced current; the
[maximum-available-current assumption](#maximum-available-current-assumption)
applies until usable evidence establishes a restriction.

BMW CarData offers charging-profile/window information subject to vehicle
capabilities, but the current [BMW bridge](integrations/bmw.md) forwards battery and
identity facts only. It does **not** currently supply BMW charging windows to
the planner. A window-selection flag without actual times, timezone and mode
cannot safely identify available charging periods. BMW schedule-aware readiness
therefore remains unsupported until the applicable profile is mapped; do not
interpret the forecast as confirmation that a BMW timer allows it.

If a known vehicle start is after ready-by, ST-MQ reports the shortfall and
releases its economic hold so the vehicle can start when it allows. The other
charger keeps its own plan. If published prices do not cover any eligible time,
the provisional fallback also permits charging. ST-MQ cannot override a vehicle
timer, target or user stop. The final period always remains an open release.

## Explicit one-day flexibility

With the optional [electricity forecast](../electricity-forecast.md) enabled, a
connected unfinished automatic session may compare its current ready-by deadline
with one additional Helsinki calendar day. Opening the comparison is read-only;
only the separate **Allow one more day** action grants the later deadline. The
request is bound to the existing equipment association, physical connection and
request revision, with a bounded idempotent action receipt. Ordinary defaults,
charge progress and delivered energy retain their original owners.

There is at most one unconsumed allowance. Until the earlier ready-by checkpoint,
the later effective deadline is highlighted with **+1 day**. At that checkpoint,
the authorized later instant becomes the normal binding deadline and the highlight
disappears. A durable transition consumes the permission exactly once; status can
project that already-authorized transition without writing on a page refresh.
Restart or handover across the checkpoint promotes only the previously authorized
day, even if recovery is after both deadlines. An overdue baseline stays overdue.
One further day requires a new affirmative action after the previous checkpoint.

Cancel before the checkpoint restores the earlier baseline; insufficient remaining
time produces the existing safe best-effort charging result. After consumption
there is no old allowance to cancel. An explicit session Ready by edit clears the
allowance and establishes the edited absolute deadline. Unplugging ends its scope.
Charge now, external/native instructions, disabled automation, physical readiness
and existing restoration duties remain authoritative; a deadline grant never
supplies native command permission. Forecast loss neither revokes an approved
deadline nor creates another day.

Calendar arithmetic preserves local wall-clock time: ordinary Finnish DST days
can add 23 or 25 elapsed hours. An ambiguous autumn time chooses its earlier
occurrence; a missing spring time shifts forward by the clock-change gap, matching
the existing ready-by parser. The resulting absolute instant is persisted.

Comparisons run two joint plans from one current snapshot for both connected
chargers, changing only the selected charger's deadline and holding remaining
energy and already-delivered energy constant. The peer keeps its own deadline;
shared capacity can change its charging periods and remaining cost. The primary
saving belongs to the selected charger. A separate household saving is the total
cost effect of that same one-charger choice, never a grant for both chargers. Native
constraints, electrical limits, shared priority and committed short running periods
remain part of that snapshot. The displayed remaining cash cost and household
saving exclude sunk cost. The main estimated session total may combine accrued
published-price cost with the selected forecast plan's remaining cash estimate;
this display projection does not update accrual, its fallback unit price or the
published-price ledger.

Predicted slots receive a bounded **2 c/kWh uncertainty premium** in the decision
objective; their actual estimated cash price remains separate. Published prices
win overlaps and receive no premium. An ordinary session cannot move its economic
schedule into predicted slots without an approved flexible deadline. A promoted
baseline retains that permission only within its now-binding deadline. Independently
confirmed native periods remain real competing loads without gaining new scheduling
authority. A positive individual saving is recommended only when combined remaining
cash cost also improves and the household risk-adjusted improvement is at least
5 cents. Running speculative replans require more than 5 cents of risk-adjusted
joint improvement and retain the existing minimum-run/pause and period-stability
checks; published-only replans retain the existing cash-cost policy.

Missing coverage through the proposed later deadline or unequal/infeasible modeled
service makes the comparison unavailable. It never supplies a free future rate.
The permission can still be granted without a savings estimate, with the UI stating
that limitation; ordinary fallback then charges conservatively toward the hard
deadline. New published prices replace predictions on the next assessment.

Local OCPP and Shelly scheduling can use the full forecast horizon. Easee cloud
delayed schedules encode a local clock time without a date. Every proposed cloud
start, including a restart after a planned pause, must therefore be the next
unambiguous occurrence of that time from the point where the pause begins. The
planner applies the existing native date/DST guard while evaluating candidates;
it may choose an earlier supported period and report less saving. A later approved
deadline remains binding, but it never authorizes an unrepresentable native timer.

All comparisons share the existing CPU worker. One active calculation, one latest
queued control calculation and one latest low-priority preview keep load bounded;
control work has queue priority. Cards request background comparisons at most once
per minute per eligible charger, including an active allowance, when numerical
planning inputs, forecast coverage or a relevant period boundary changes.
Unchanged polling and renewed source receipt clocks do not start another search.
An active proposed period also refreshes as its displayed minute advances; a
temporary calculation failure remains retryable within the same bound. A successful
comparison retains its original snapshot time while currents, voltages, progress,
native command bookkeeping or market inputs change. Recalculation replaces it
atomically; an unavailable replacement retains the last successful estimate and
reports the refresh limitation without pretending its source time is new. Equipment,
physical-session, vehicle, request, shared-priority and peer-deadline changes fence
incompatible comparisons. Allowing or canceling the selected charger's day keeps
the same normal/deferred comparison until its earlier checkpoint.
Temporary loss of live session presentation does not erase the dated estimate:
its comparison scope uses the retained physical request and vehicle association.
This scope is display identity only and grants no current command permission.

Opening the dialog requests a comparison, retaining the last successful same-scope
estimate while it loads or fails, including across closing and reopening. Once open,
the dialog adopts completed background comparisons only when their displayed
costs, finish times, charging durations or other comparison values change. Timestamp
churn, elapsed age and changes below displayed precision do not refresh it or cause
another calculation. The original estimate time remains visible; explicit refresh
is also available. A server-created estimate is not rejected because its calculation
completed after the preceding status tick or ahead of the browser clock.
Each alternative includes expandable proposed charging periods from its own joint
calculation. These are counterfactual permissions, not confirmed native schedules.
An open final period remains labelled "onward", separately from estimated finish;
it never implies that the charger is commanded to stop at the estimated finish.
Showing an estimate grants no authority: every deadline action separately checks
the current equipment, physical session, request revision and control eligibility.
An old display cannot authorize a new connection or bypass native instructions.
Forecast rows, decision-price caches and previews stay in RAM.
Durable state retains deadlines, accepted periods, compact estimated totals and
approval/consumption evidence; ordinary diagnostics retain published prices only.
