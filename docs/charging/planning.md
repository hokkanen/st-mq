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
charger-current restriction. Actual draw and confirmed execution continue to
govern immediate electrical allocation; a forecast never establishes that an
unavailable charger has paused or accepted a lower current.

Regression coverage must include a feasible delayed Charger 1 plan followed by
Charger 2 connecting with unknown current and unavailable control. With usable
prices, property headroom and sufficient modeled opportunity, both requests
remain represented and Charger 1 keeps a feasible price schedule instead of
being released solely because Charger 2 is unready. Also cover max-available
delivery estimates, a later known lower limit, joint per-phase allocation and
the unchanged command-readiness gates.

### Joint allocation and execution

The expensive joint search runs in one local worker, with one active calculation
and only the latest pending request. Repeated equivalent inputs reuse a bounded
cache for at most 30 seconds and never across a schedule, allocation or deadline
boundary. Results retain their calculation time. Changed requests, connections,
native instructions, authority, source selection or expired results are checked
before publication; stale work cannot replace the current plan. Accepted session
evidence and progress are saved independently while planning runs. Device
readback and command fencing remain authoritative.

The implementation is a bounded search over a declared slot/current model, **not a globally exact continuous-time optimizer**. Results expose the search kind, relaxed cost lower bound, feasible candidate cost and upper bound on the cost gap where available. Search pruning can miss a better joint candidate; reported feasibility is conditional on the recorded assumptions. Synthetic exhaustive small-horizon comparisons validate representative cases. There is no one-cent pause penalty or mandatory one-cent saving hurdle. Practical minimum economic runs/gaps remain 15 minutes; equal-cost choices prefer stability.

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

Live property and charger currents still govern actual draw, immediate phase
headroom and the commissioned limiter. Live voltage remains appropriate for
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
