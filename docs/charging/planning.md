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

The planner first respects known applicable device/vehicle limits, manual permission, native start times and credible capacity. It protects both deadlines where the modeled opportunities allow that. All-in electricity cost with the common forecast uncertainty allowance then governs period selection. Priority must not buy more expensive energy merely to favor a charger. In infeasible cases, charger priority favors its remaining request; balanced mode shares normalized shortfall. Eligible charging time and grid-energy need determine pressure. Shared budgets below two minimum currents use bounded time slices rather than invalid sub-minimum simultaneous commands.

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
Control calculations take priority, interrupting an optional comparison already
running when necessary. The interrupted comparison returns no new result; the
same single worker slot starts control work after termination completes. Repeated equivalent inputs reuse a bounded
cache until the next relevant schedule, allocation or deadline boundary. There
is no calculation-age timeout. An accepted economic program remains reusable
while its effective inputs and remaining service remain valid; passing a boundary
requires current-time assessment, not automatically another optimization. Results retain their calculation time. Changed requests, connections,
native instructions, authority, source selection or expired results are checked
before publication; stale work cannot replace the current plan. Equivalent
notifications received during a search do not invalidate its result. Equivalent queued notifications complete through inexpensive reuse. Each caller
waits for its own request to be assessed, so an earlier publication cannot complete
a newer takeover while its plan is still absent. Changed evidence still requires a fresh
calculation. Calculation clocks remain original, and current-time charging-boundary
checks remain in force. Accepted session
evidence and progress are saved independently while planning runs. Device
readback and command fencing remain authoritative. Native control callers resume
after a current joint result commits; later changed measurements may keep
background planning active without holding those callers on the whole queue.
An earlier request or connection cannot satisfy that publication check.
After a native update and its state commit finish, their follow-up economic
refresh runs independently. It cannot hold the next native read, identification
stop or current-restoration deadline while waiting for its first plan result.
A newly due duty in the current connection may interrupt an older native plan
wait through the controller's planning-only hook. This leaves device RPC and
preflight work intact. The existing bounded wakeup remains armed while numerical
work is pending; it does not renew the attempt, deadline or energy allowance.
An attempt that has ended can still owe its captured physical return. That
existing return program does not require a new economic calculation, and remains
subject to its original connection, instruction and return-time boundaries.

The implementation is a bounded search over a declared slot/current model, **not a globally exact continuous-time optimizer**. Results expose the search kind, relaxed cost lower bound, feasible candidate cost and upper bound on the cost gap where available. Search pruning can miss a better joint candidate; reported feasibility is conditional on the recorded assumptions. Synthetic exhaustive small-horizon comparisons validate representative cases. Routine replacement compares complete remaining joint service under the same current inputs and excludes sunk cost. It needs more than 5 cents of decision-cost improvement when a participating accepted charging period is ongoing, or more than 1 cent while waiting. A temporary zero draw does not end an ongoing permitted period. Equality retains the accepted program; successive changes are always compared with that program. Necessary request, service and constraint corrections bypass the monetary hurdle. These are practical replacement thresholds, not a global one-cent optimization-error guarantee. Intermediate planned charging periods last at least 15 minutes; new economic pauses require 10 minutes. The final open release remains separate.

Reassess accepted periods when progress, capacity or another planning input
changes, including when their forecast is already provisional. If the accepted
program now misses ready-by, a replacement that reduces the modeled shortfall
without increasing another participating charger's shortfall bypasses the price
improvement threshold. It may cost more to restore the requested service. When
full recovery remains impossible, only an immediate open release may replace
that infeasible program; it must not introduce another economic pause. Keep the
remaining deficit visible. A proposed correction does not become accepted
execution until the integration confirms it under the existing native guards.
Accepted periods remain visible while their forecast is being reassessed or
reports a target at risk.
Internal simulated completion may have fractional milliseconds. Newly selected
schedule boundaries use integer epoch milliseconds within their available
windows, and the joint simulation checks the rounded candidate before selection.
Fractional forecasts remain estimates; they are not native execution timestamps.

For new Easee cloud programs, an intermediate gap must be strictly longer than
10 minutes. The cloud adapter installs that next delayed start after the preceding
period ends and needs at least 10 minutes still remaining at dispatch. An exact
10-minute gap cannot survive positive read or storage latency. Ordinary alternating
15-minute charging and price-pause slots leave five minutes for that latency.
The existing `localClockSchedule` capability carries this representation limit;
local OCPP and Shelly periods retain their own supported execution paths. Initial
future starts are checked separately and are not excluded by this intermediate-gap
rule. It adds no latency buffer: an arbitrarily longer gap can still become too
short before dispatch, and accepted periods do not prove an observed physical pause.

Within an equal-price capacity block, the bounded selection uses the later edge
when its earlier edge would create an exact cloud minimum gap. If both adjacent
selected periods would create that gap, it centers the required energy within
the block instead. A shared-period seed applies this same placement when either
participating charger uses cloud scheduling. This selects a placement rather than
adding another search loop or forcing a fixed gap; the ordinary joint simulation
still validates every phase, native restriction, peer deadline, energy request and
complete cost. Fixed/adopted executions retain their original periods and clocks.
Their existing price/deadline revision and physical-dispatch guards remain separate.

Alongside continuous starts and individual period improvements, freely scheduled
requests receive one shared-period candidate. It selects cheaper windows using
their combined modeled capacity so both chargers can move together when an
incumbent peer allocation would block an individual improvement. The same
chronological joint simulator and bounded individual refinement validate service,
priority, per-phase/scenario limits and cost. Native timers and period-count
limits constrain this candidate; fixed permissions are never moved. The existing
best candidate remains available, and pooled capacity is not proof that every
individual deadline can be met. Positive and negative prices use the same price
objective, including the common uncertainty allowance for predicted intervals;
this additional seed does not establish global optimality.

If the ordinary search finds no feasible schedule, one additional candidate uses
the separate windows in which a fixed native current fits every forecast phase
and scenario. This recovers earlier charging opportunities that a later household
peak would exclude from a continuous period. The joint simulator still checks
peer allocation, native restrictions, fixed periods and schedule limits; the same
service, priority and cost comparison selects the result. If that still fails,
freely scheduled requests receive one deadline-ordered candidate: fit the earlier
request first, then fit later requests around its modeled draw. This can preserve
an earlier deadline by pausing a later request through a temporary shared shortage.
The same joint simulation, native period limits and cost comparison apply. These
bounded candidates do not add search work to already-feasible plans or promise
exhaustive recovery.

Running-session readiness and price-driven interruption decisions reassess both
adopted executions together with the selected priority. A cheaper replacement
must preserve modeled feasibility and reduce combined cost. A final open release
retains its charging permission while remaining part of shared current allocation;
it does not reserve the charger's entire current ceiling against its peer.
Independently observed native/manual activity is likewise accounted for without
granting the economic scheduler new permission to change that activity.
Charger 2's prospective current command uses Charger 1's confirmed permission,
so an unconfirmed replacement cannot manufacture spare capacity.
An elapsed cloud period is not a confirmed pause: if the next native instruction
was unsent or remains unconfirmed, the started program retains its native current
commitment until the charger confirms waiting. Initial waits and confirmed own
pauses do not acquire that commitment, and native restrictions still apply.
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
Forecast identity reads this retrospective basis only when a completed Easee CSV
is present. Its first per-phase estimates seek an earliest usable receipt, then
refine that early prefix using both original clocks, preserving late-publication
ordering, selected history and original ID ties. Ordinary later voltage history
does not require sorting the archive to identify that fixed early-CSV basis.

The household forecast selects at most 32 independent nights in each local-hour
and 5 °C condition bucket, with at most 24 load patterns per entry. Its compact
index retains 32 stable nights plus a bounded reserve for the current and prior
two local dates. An ordinary current-hour temperature-band change can therefore
recover the previous 32nd candidate without scanning history; advancing time
finalizes and trims only this small reserve. Winter
examples therefore survive summer observations. A read-only worker owns this
derived index and its single private, compressed sidecar beside the configured
database; paired source-file generations share that stable cache location.
Source rows, original CSVs and recorded voltage evidence remain authoritative.
The sidecar contains no control permission and is excluded from the authoritative
database format. Its current algorithm, history selection, import/voltage basis,
source cutoff and verified immutable input prefix must match before reuse. The
parent writer registers the worker's exact read-snapshot proof before a long
build and publishes its file digest afterwards; these tiny derived state records
survive normal transaction-journal pruning. They grant no device authority and
do not copy historical inputs. The previous published proof remains available
during preparation. The sidecar is
discardable on corruption, divergence or unsupported format, with no migration.

Ordinary restart restores the compact reference and processes only subsequent
source IDs, pending energy and newly available source/receipt clocks. Source
changes refresh affected dates. Known overlapping energy invalidates its complete
connected cluster, including crossings of an internal weekly processing boundary;
incremental updates rewind that same cluster. If a destructive correction removes
an older stable example from a previously overflowing bucket, a worker rebuild recovers an older eligible example
which was evicted from the bounded index. Missing or rejected sidecars, changed
history/import selection and such destructive corrections can require a full
source reconstruction, as can catching up more than 32 changed dates after an old
cache. Source changes are streamed, never materialized as an unbounded row array.
Normal control and the event loop do not run that scan. Future deferred-admission
boundaries discovered during reconstruction or new input also wake a truthful
replacement after a historical cutoff or wall-clock rollback; routine refreshes
do not scan archived JSON clocks.
Forecast readiness remains separate from native protection and command authority.
Runtime clock reversal withdraws a future-dated reference and fences older
in-flight requests before admitting a replacement.

The sidecar is replaced atomically with mode 0600, capped at 8 MiB compressed and
32 MiB expanded, and normally written at most hourly after source changes.
Zero charger tails may span months without new source rows. A compact proof is retained only after all three actual zero phases have
passed complete canonical overlap/quality checks. Exact unchanged extensions
refresh the suffix, and exact complete finalization transfers the proof to its
three immutable row IDs. New late evidence, changed quality/identity, incomplete
finalization, rollback and source-selection changes cannot reuse that prefix.
Cold reconstruction also retains exact geometry proofs for recently finalized
cohorts, bound to their three immutable phase IDs and original end. Their actual
canonical values and quality remain unchanged, including unknown values; a
geometry proof never grants numeric validity. Long connected conflict spans
retain their verified unknown geometry separately, including components built
entirely from short cohorts. Forward overlaps extend that unknown span without
rechecking its old prefix; original pending participants must remain present or
finalize as complete admitted cohorts. Participant removal, rollback or a newly
left-extending source requires a fresh assessment. Numeric values never become
valid through a conflict proof. At most 1,000 cohort proofs and 1,000 conflict
spans are retained, only for intervals longer than one day; finalized geometry
expires with the bounded mutable reference dates. Supported original-CSV peer
subtraction uses the same verified native context; its conservative earliest-peer
bound advances with the source watermark instead of rescanning native history on
ordinary imported-reference refreshes. Other adaptive groups, including invalid zero and property groups, close at accepted
acquisition boundaries after 24 hours, so floating-point accumulation never requires approximate prefix equivalence.
Weather-only planning does not rewrite it. Complete reconstruction or a changed
source interpretation publishes immediately. This bounds disk use without
retaining every historical hourly summary or rewriting the index on each
five-minute forecast; an unsaved recent suffix is reconstructed after restart.

For unchanged intent, retain accepted periods unless an assessed replacement
clears the monetary threshold above. The inexpensive joint assessment still checks
service, applicable limits and continuing peer demand. An unchanged selected
program keeps its identity; rejected candidates are not adopted-plan events.
A small internal candidate tie preference may retain nearby equivalent future
boundaries, without replacing the runtime's complete remaining-cost comparison.

Economic admission ignores renewed receipt clocks, unchanged battery values,
idle-current noise, raw live voltage behind an admitted planning-voltage estimate,
and expected native command bookkeeping. New connections, actual battery/request
changes, priority, effective electrical/vehicle restrictions, source quality and
relevant published-price changes receive prompt assessment. No schedulable request
needs a new economic search; independently active peers still affect other requests.
Queued vehicle observations retain their durability fence. Background economic
work waits for their admission outcome instead of searching a temporary fallback
and then the unchanged accepted reading. Settlement requests one assessment;
failed admission remains unavailable evidence. Explicit controls and native stop
deadlines retain their separate priority and evidence requirements.

Ordinary forecast changes settle for ten seconds after the latest meaningful
change, with a sixty-second maximum from the first pending change. Irrelevant
receipts cannot extend it. A transition within two minutes or modeled service
failure bypasses settling. Changes accumulate against the last searched model:
one volt of effective planning voltage, 0.25 A in forecast phase demand, or a
changed numerical price/quality model is material. Expected metered delivery
updates progress without another search; an unexpected completion shift exceeding
two minutes receives reassessment, and a modeled deadline failure is prompt.
These operational tolerances do not relax actual current protection or command
readiness. Households retain the existing five-minute forecast refresh; moved
horizon starts and provenance clocks alone do not create a changed future model.

The exact allocator reuses equivalent two-charger whole-amp sharing patterns and
capped deadline-reservation tiers across household scenarios. Its electrical layout
and allocation classes are exact, with at most 128 layouts and 64 results per layout
in each specialized cache; other layouts use the same scalar allocator. No energy,
weight or deadline is rounded into an allocation cache class. Output vectors cannot
mutate retained calculations. One fractional minimum-cost flow may supply a seed
and optimistic quality assessment; it relaxes native switching and sharing rules
and never supplies command permission. A feasible incumbent remains available.
At most 256 full joint evaluations refine period boundaries and whole periods;
every accepted candidate retains service and passes the native and phase/scenario
checks. Negative prices and forecast uncertainty keep their ordinary meaning.
This improves a bounded heuristic and does not establish a global exact optimizer.

All price periods retain absolute boundaries. A late physical charging start does
not move later pauses or releases, and fifteen minutes describes the planned
permission window rather than a promise of fifteen minutes of measured draw.
Meter missing delivery and reassess service. A newly dispatched cloud pause needs
its exact requested next absolute start represented by the local clock, timezone
and next unambiguous occurrence, followed by accepted schedule readback. A success
reply alone does not prove a physical pause. A retained confirmed pause remains
valid when its remaining duration falls below ten minutes; refused, late or
mismatched installations never silently shift the future program.

Accepted evidence, progress, live current control, identification, restoration and
fresh native preflight continue independently of economic admission. Stored plans
and readback do not become fresh actuator permission after restart.

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

Forecast delivery applies the shared allocation policy separately to each household
load scenario, then weights its delivered energy. A temporary peak that leaves
less than a valid 6 A pilot contributes zero delivery for its own weight; it does
not force every other scenario to zero. Adjustable Charger 2 can reduce or pause
during those peaks and use available capacity in the other scenarios. Conservative
current proposals remain separate from expected delivery and never replace the
live current calculation. A fixed native current still has to fit every included
phase and scenario, and known native or vehicle limits constrain all scenarios.

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
charger keeps its own plan. If neither published nor admitted forecast prices
cover any eligible time, the provisional fallback also permits charging.
ST-MQ cannot override a vehicle
timer, target or user stop. The final period always remains an open release.

## Published and forecast prices

The owner approved normal forecast scheduling and the one-extra-day comparison
policy on 2026-10-09, removing the former restriction of forecasts to approved
flexibility. The approval also covers the comparison's no-increase cash-cost
rule, ordered allowances, actual joint-plan display and shared admin/family access.

Normal automatic planning and both alternatives in **One extra day** use one
price outlook: available published prices plus fresh predictions when the
optional [electricity forecast](../electricity-forecast.md) is enabled. Published
prices win overlaps. Both sources use the same dated all-in calculation for
retailer margin, electricity tax, transfer charges and VAT; valid zero and
negative prices retain their meaning. Forecast access is independent of whether
the session has ever received an extra-day allowance.

Each predicted slot receives a **2 c/kWh uncertainty allowance** in the decision
objective. Both normal and extra-day planning apply this allowance per modeled
grid kWh, including negative-price intervals. Published slots receive none.
The allowance guides period selection; it is neither an invoiced charge nor a
measured forecast error, and it never enters displayed cash prices, estimated
cash savings or recorded bills. Comparisons retain each plan's cash cost and
uncertainty allowance separately so the change in forecast exposure is visible.

Routine replacements require more than 5 cents of joint decision-cost improvement
during an ongoing charging period, or more than 1 cent while waiting, under either
price source. Decision cost includes the separately labelled forecast uncertainty;
minimum-run/pause and service checks remain binding. Native
constraints and existing instructions keep their authority under either price
source. A forecast supplies no command permission, physical delivery evidence
or guarantee of the final cost.

New published prices replace predictions on the next assessment. Expired,
disabled or unavailable forecasts supply no future rate; available published
prices remain usable. The existing feasibility/fallback rules apply when those
prices cannot support the request. Forecast loss does not change a binding
ready-by deadline, and cheaper prices cannot grant an unapproved extra day.

## Explicit one-day flexibility

With the optional [electricity forecast](../electricity-forecast.md) enabled, a
connected unfinished automatic session may compare its current ready-by deadline
with one additional Helsinki calendar day. Opening the comparison is read-only;
only the separate **Allow one more day** action grants the later deadline. The
request is bound to the existing equipment association, physical connection and
request revision, with a bounded idempotent action receipt. Admin and
family-password users may open and refresh the comparison, allow one more day
and cancel an active allowance. The same session and control checks apply to
both roles; read-only replicas grant neither role write authority. Ordinary
defaults, charge progress and delivered energy retain their original owners.

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
energy, already-delivered energy, available prices and uncertainty policy
constant. Forecast prices are available to both alternatives before their
respective deadlines. The peer keeps its own deadline;
shared capacity can change its charging periods and remaining cost. The primary
saving belongs to the selected charger. A separate household saving is the total
cost effect of that same one-charger choice, never a grant for both chargers. Native
constraints, electrical limits, shared priority and committed short running periods
remain part of that snapshot. The displayed remaining cash cost and household
saving exclude sunk cost. The main estimated session total may combine accrued
published-price cost with the selected forecast plan's remaining cash estimate;
this display projection does not update accrual, its fallback unit price or the
published-price ledger.

A newly running period commits its original minimum run, bounded by an earlier
accepted Stop. It does not freeze the rest of the installed schedule. Both
alternatives and planning after approval preserve that uninterrupted prefix while
searching later periods. The commitment's end is a comparison-cache boundary;
starting a period or reaching that boundary triggers a fresh assessment without
renewing the run's original clock.

The [common uncertainty allowance](#published-and-forecast-prices) applies to
both alternatives. Opening more time retains the entire feasible earlier plan
as a candidate, including its earlier allocation target. A later candidate is
selected only when the household cost plus uncertainty allowance improves and
neither the selected charger's cash cost nor the combined cash cost increases.
Ties retain the earlier plan. These are actual simulated plans and costs, never
a zero-clamped saving. Approval uses the same choice as the preview; the binding
deadline extends even when retaining earlier charging is best. Current allocation
and subsequent forecasts retain the selected plan's earlier target, with accepted
execution governing the peer's allocation. At most four ordinary bounded searches
cover two active grants, and all expensive searches remain in the existing worker.
The selected candidate need not use the additional day; this is an opportunity,
not a requirement to postpone charging. The bounded search remains heuristic.
New allowances are considered in approval order. Refreshing an existing allowance
keeps that order in the approved-plan calculation; its earlier-deadline alternative
asks what canceling this allowance would do now, with the peer's allowance intact.
A later peer decision can change how savings are shared, so this marginal
comparison can differ from the original grant. The active display explains such
changes and shows the true remaining costs; it does not reorder approvals to
manufacture a saving. Proposed periods remain separate from installed execution.

A positive individual saving is recommended when combined remaining cash cost
and the household risk-adjusted result also improve. There is no additional
minimum-saving hurdle for granting time; the existing running-period interruption
duration checks remain separate. An explicit allowance also uses positive adjusted
benefit when revising a running plan; the routine five-cent ongoing/one-cent waiting hurdles belong to unsolicited
improvements. The uncertainty comparison subtracts the extra-day plan's
allowance and credits the normal plan's allowance; shared forecast exposure is
not charged twice. Independently confirmed native periods remain
real competing loads without gaining new scheduling authority. When the peer
does not report charging and valid measured power is zero, residual standby
current does not add a battery-delivery obligation to either alternative.
Unavailable power is not zero. A stopped or idle unscheduled peer's unfulfilled
battery request does not block comparison of the selected charger. An
independently running or scheduled peer remains in shared
capacity and equal-service accounting; unavailable electrical demand cannot be
silently treated as zero or excluded to certify a saving. A previously
approved deadline retains its durable approval provenance after the checkpoint;
that provenance owns the deadline and does not grant separate forecast access.

Incomplete price coverage through the proposed later deadline does not block a
comparison when both plans deliver the same required energy using available
priced intervals. The comparison labels partial coverage; later prices may change
the saving. Unknown intervals never supply a free future rate. The planner keeps
its contiguous priced horizon and native-period constraints. Unequal/infeasible
modeled service or missing prices for modeled delivery makes the comparison unavailable.
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

Eligible cards calculate savings automatically on the controlling computer, using
the existing bounded joint search and CPU worker. Control calculations retain
priority and can interrupt a comparison. Only the latest pending inputs for each
charger are retained; the two comparisons run in turn. Concurrent browser requests
join that work or reuse its completed result. Opening a cached comparison starts
no calculation. Explicit refresh remains available after an unavailable result.

Comparison admission uses the normal planner's material-change checks and its
ten-second quiet period with a sixty-second maximum, applied through the extended
deadline. Meaningful tomorrow-only forecast changes therefore refresh savings
even when the ordinary plan needs no search. Subthreshold changes accumulate
against the searched model. Renewed source clocks, unchanged forecasts, expected
metered progress and elapsed estimate age alone start no search. Changes outside
both alternatives' horizons also start no search. Proposed period/deadline
boundaries require a fresh assessment. Equipment, physical session, vehicle,
request values, priority and peer-deadline changes still fence incompatible work;
bare command revisions grant no estimate or action authority.

The existing saved charger-card publication includes completed comparisons and
their original estimate times so the read-only computer can display them without
running searches. Numerical admission models and pending work stay in RAM. An
unavailable result waits for changed inputs, a future boundary or explicit refresh
rather than retrying continuously.

An active allowance's approved alternative is the actual current joint program,
including retained periods and allocation targets. Its earlier alternative asks
what cancelling only that allowance would do now. A cached successful comparison
keeps its original snapshot time through temporary unavailability; a failed refresh
explicitly labels the previous estimate rather than renewing its clocks. Allowing
or cancelling the selected day keeps the same comparison scope until its earlier
checkpoint. Temporarily missing live presentation retains that dated scope but
grants no actuator authority.

The dialog retains the last successful same-scope estimate while it updates or
fails, including across closing and reopening. Once open,
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
