# Live current allocation

[Charging overview](../charging.md) · [Code map](architecture.md)

Charger 1 retains native Equalizer current control. This contract owns Charger 2 current entitlement, source admission, fallback and recovery; its [Shelly integration](integrations/shelly.md) owns protocol capability and command confirmation.

## Charger 2 current allocation

Current adjustment defaults on (`limiterEnabled:true`) and follows property load
and the shared charger priority independently of Automatic scheduling, including
Charge now. An explicit `limiterEnabled:false` selects basic start/stop, leaving
native current settings and native load balancing in charge. The bounded
[identification current test](identification.md#minimum-current-comparison-and-joint-assignment) is a separate scoped action and can operate
with the limiter disabled when its own capability checks pass. In basic mode,
planning uses the known applicable native current setting, or the
[maximum-available-current assumption](planning.md#maximum-available-current-assumption)
when it is unknown; scheduling sends Boolean start/stop only. The allocation
below applies with `limiterEnabled:true`;
missing current-control capabilities block that mode rather than bypass it.

The adjustable Shelly current setting follows the current physical session's
instruction precedence. With the limiter enabled, a setting carried into a new
confirmed connection is the initial device readback, not an enduring current
ceiling. The controller may adjust it using the allocation below even with
Automatic scheduling off. A genuine external current choice observed during
that connection remains a ceiling until unplugging or explicit **Use automatic**.
Restart and MQTT reconnection within the same connection retain that choice;
confirmed controller writes do not create it. The Automatic switch and Charge
now do not clear a later external choice. This policy does not change native
hardware, electrical or vehicle limits, or provide permission to start charging.

Configure the installation's per-phase fuse ratings, calibration margins and
charger ceiling. The effective phase budget is `mainFuseA - marginA`: a positive
margin leaves headroom and a negative margin intentionally increases the budget.
Margins may be finite values from -200 to 200 A, including decimals, provided
each effective budget remains positive. The shared default is 0 A per phase. Calibration
does not rewrite the declared physical fuse rating or the equipment's protection.
Property and Easee currents use the same Easee phase basis. Shelly does
not need a phase correspondence for this limiter: its contribution is the
minimum of its three admitted measured phase currents, subtracted equally from
each property phase. This remains conservative when the phase currents differ.
The configured `phaseMap` still owns recorded phase-energy association; this
calculation does not change or verify that recording map.

## Electrical headroom

For each property phase, household demand is
`B = property − Easee − min(Shelly phase currents)` and headroom is
`H = fuse − margin − max(0, B)`. A residual below −0.25 A makes the additive
interpretation unusable rather than granting extra current. Shelly's absolute
load ceiling is the tightest `H`, within its configured maximum, then the
applicable shared priority. Native and vehicle limits also constrain the final
allowance. Including Shelly's present draw avoids confusing incremental spare
room with an absolute current setting.

## Source health and held readings

The property and Charger 1 current feeds must be online and synchronized in their
current connection epochs, with complete valid phase values and original source
times. A field's older last-change timestamp alone does not invalidate held state
on such a connection. Reconnects, disconnected providers, incomplete
synchronization and contradictory values do not pass by rereading a cache.

Shelly's correlated `GetStatus` response can confirm unchanged `phase_info`
values and their matching `last_update_ts` without rewriting that clock. That old
last-update clock alone does not expire the measurement after 15 seconds.
Availability, native component health and current readback remain required.
Retained MQTT messages and repeated application-cache reads cannot renew that
health. Source clocks remain unchanged; held state is not another observation
or identification/learning sample.

Equalizer supplies the property current. Its reported charging allowance and
independently acquired native budget are not inputs or prerequisites for
Shelly's live limiter. There is no allowance agreement test, below-minimum
allowance inference, held comparison reference or comparison-settling state.
The configured electrical budget remains the source of the phase limits.
Property and charger measurements must still support their additive
interpretation; deleting the Equalizer comparison does not turn invalid or
missing phase measurements into usable headroom.

## Latest healthy measurements

Use the latest valid property, Charger 1 and Shelly currents from their healthy
current source connections. A charger measurement may precede or follow the
property reading. OCPP and cloud sources follow the same ordering policy; a
changed charger current also needs no later property confirmation. There is no
measurement-pairing queue, previous-triplet hold, or awaiting-measurements mode.
Each new usable observation can immediately revise the calculated allowance.
Command dispatch retains the independent increase dwell and native readback gates.
OCPP allowance acquisition retains the last phase readings while its current
transport remains healthy; those held readings do not renew command or physical
identification freshness. Reconnection or an actual feed-health gap needs new
current evidence before the previous values can be used again.

This owner-approved amendment of 2026-10-06 accepts temporary overestimation or
underestimation of household demand when contributions and totals arrive at
different times. For example, a property total that already includes a Charger 1
reduction combined with its older, larger charger reading understates household
load. The reverse arrival order can overstate it. Feed health does not prove
simultaneous sampling; source and receipt clocks remain unchanged and distinct.

Health, complete phase values, current source epochs and additive-value validation
still apply. Missing, invalid or contradictory evidence selects configured
fallback under known tighter limits. Cached application reads and retained MQTT
cannot establish source health. Ordering differences alone never select fallback.
There is no elapsed-time rule that transfers Equalizer's control to Shelly.

## Allowances without a connected vehicle

Continue calculating, displaying and recording allowances with no car plugged in.
Charger 1 records its actual healthy Equalizer-reported allowance, including zero,
within the known equipment ceiling. An unplugged status neither nulls that
observation nor replaces it with an invented potential Equalizer allowance.

Charger 2 reports capacity available now from the latest healthy load measurements
and configured limits. Preserve a connected peer's allocation commitment, including
when Charger 2 priority is selected, but do not fabricate an energy request,
vehicle restriction or deadline for an unplugged vehicle. With no connected peer
commitment, available capacity is the household headroom within the configured
maximum. Actual session allocation is reassessed when a car connects.

The capacity observation itself sends no Start, Stop or current-setting command
to the unplugged charger. Independently owned restoration duties still apply.
Its application status is inactive, separately from numeric available capacity.
Unknown feed evidence remains unknown or explicit fallback;
unplugging is not proof of zero current. Disabled integration/current adjustment
remains inactive. Old historical gaps are not backfilled.

## Shared priority and Equalizer coordination

Shelly applies the shared planner's allocation policy to admitted live household
headroom, using priority, remaining energy requests and ready-by times. Balanced
therefore need not mean 50/50. Forecast household demand is not a second live
reservation: current headroom is divided once using the same allocation policy.
The same allocation policy applies during Automatic scheduling, Charge now and
ordinary unscheduled charging. Charger 1's confirmed permission and applicable
request determine participation; its momentary draw or an apparent stop caused
by Equalizer does not release its entitlement to Shelly. Accepted progress,
changed requests, deadlines, priority, native restrictions and session changes
can legitimately revise the plan.

Charger 1 measured current is needed to subtract its contribution from the
property meter. It must not redistribute the planned allocation, either directly
or through replanning. There is no live peer-draw sharing or opportunistic
redistribution merely because Charger 1 draws less than its entitlement. Below
the capacity for two 6 A pilots, Balanced retains the selected allocation turn
for up to 15 minutes, bounded by a nearer request deadline. Progress and polling
do not renew that deadline. Changed priority, session, request, native
instructions or eligibility clear the turn; measured draw does not select it.

Shelly reduces for property protection only when household demand plus Shelly
alone exceeds the effective phase budget. If reducing Charger 1 could remove
an excess, Equalizer owns that adjustment. The size, duration or trajectory of
an excess that Charger 1 could remove must not reduce Shelly's entitlement.
There is no response deadline or inference that Equalizer failed to act which
hands balancing over to Shelly. This is about Equalizer's calculated ability to
remove the excess, not proof that it has already responded.

With Charger 2 priority, Shelly can take its full household headroom within its
own limits. A conservative forecast allocation or secondary deadline reservation
must not lower that live entitlement. Economic scheduling still chooses
permitted periods; native/vehicle restrictions and genuine source outages remain
independent of this coordination rule. Forecast delivery remains an estimate,
and the model does not prove Equalizer response or physical fuse protection.

The core regression invariant is: hold household demand, planned entitlement
and applicable limits fixed, vary Charger 1's draw and delay Equalizer's
response, and Shelly's entitlement stays fixed. Include removable temporary
property overload with consistent latest measurements. Separately arriving
changes use the latest healthy values immediately and may temporarily change the
calculated entitlement.

## Current steps, dwell and dispatch

A common current is rounded down to the supported profile's 1 A step. The native
range must report a 6 A minimum and a sufficient maximum. Shelly's optional
`meta.ui.step` describes UI presentation: an absent value does not disable
supported integer current writes, while contradictory reported metadata blocks
them. Values below 6 A cause an EVSE pause, not an invalid current RPC. Decreases
do not wait for the increase dwell; increases ramp by the configured step budget
after dwell, and resumption also requires dwell and permission. Native lower
current choices made during the connection retain their session precedence;
start/stop, energy/time caps, faults and schedules retain their authority.
Enabled native schedules conservatively own start/stop until
disabled/removed; ST-MQ does not guess their cron window or rewrite them.
Current limiting remains separate.

When fresh native permission is off and healthy physical readback confirms an
idle connected vehicle, hold `fallbackCurrentA` as a stable standby setting,
respecting configured maximum and known native/vehicle ceilings. Set it once,
then keep calculating and recording available capacity without chasing each
headroom change at the device. The standby pilot is separate from available
capacity: for example, a stopped charger can retain 12 A while only 8 A is
currently available. Before an authorized Start, reconcile and confirm a setting
within the current allocation; the normal increase dwell and ramp still apply.
Zero allocation retains the owned balancing Stop and never becomes permission
to resume. An enabled charger drawing zero remains under ordinary live current
adjustment, since the vehicle may start drawing without a new Start command.
Momentary low draw alone never selects standby. Unplugged capacity observations
still send no commands. Identification and restoration keep their separately
scoped current duties. This idle policy was approved by the owner on 2026-10-09.

The existing five-second Shelly poll and incoming native changes reconcile
current against the latest admitted phase observations. They do not add a second
timer, poll the other charger's cloud or repeatedly run the economic search when
the session, authority and bounded plan remain applicable. Original source clocks
and the separate identification deadlines remain authoritative. Command and
readback delays can extend response time; this is not independent fuse protection.

## Fallback and controller outages

With usable feeds, the load allowance ranges from **0 or 6–16 A** at the normal
16 A configured maximum. Zero requests a pause; 1–5 A are never sent as pilot
settings. **12 A is a configurable fallback cap, not a floor**. Unavailable,
unsynchronized or inconsistent load feeds select `fallbackCurrentA`, initially
12 A. Independently usable property evidence that establishes a lower ceiling,
applicable priority allocations and known native or vehicle restrictions remain
binding even during fallback. Valid evidence of insufficient room therefore
cannot cause a jump to 12 A. Fallback does not start a stopped vehicle or bypass
its native timer, and is not independent fuse protection.

Shelly command preflight and current native readback retain the `maxAgeMs`
health bound, initially 15 seconds. Unchanged current measurements confirmed by
that live readback keep their original source clocks without expiring solely
because the value has not changed. Separate identification freshness and
command-confirmation requirements remain intact. Increases ramp by 2 A after a
30-second dwell. The retired `agreementToleranceA`, `additiveCurrentVerified`
and `maxSkewMs` configuration fields are rejected; there are no aliases or
configuration translations.

A temporary live fallback does not impose a permanent 12 A delivery ceiling in
the economic forecast. Unknown future supply uses the documented
[maximum-available-current assumption](planning.md#maximum-available-current-assumption)
within forecast property headroom and applicable native, vehicle and electrical
limits. The live controller independently retains fallback until its evidence
is usable; an optimistic forecast never grants current-control permission.

If the process, broker or charger is unavailable, ST-MQ cannot apply a new fallback. **Autonomous controller-loss behavior is unverified.** There is no invented watchdog, command TTL or broker-will guarantee. Actual last-setpoint, reboot and outage behavior must be established with the arrived hardware before unattended deployment. The status reports this separately from a successfully requested telemetry-loss fallback.

## Load-balancing status and history

Both charger cards show a small current allowance beside their footer status:
for example **16 A Available**, **0 A Available** or **12 A Fallback**. Full
allowance is green, a reduced positive allowance blue, ordinary zero red and
fallback purple, including **0 A Fallback**. Unknown and inactive are neutral.
Action feedback has its own reserved line, keeping the allowance visible while
saving and after success or failure. Receipts retain their normal lifetime and
accessible explanation without covering the status or report action.

Charger 1 shows the minimum native Equalizer phase allowance capped at its known
fixed equipment ceiling. Its raw Equalizer value and source evidence remain in
details, independently of OCPP control. Charger 2 shows the load allowance after
property headroom, shared priority and configured maximum. These are two
load-balancing ceilings, not additive shares of a single reported property budget.

The load allowance is separate from measured charging current, permission to
start and native-setting confirmation. A tighter native or vehicle restriction
can reduce the effective allowance; details retain the distinction and confirmed
setting. A pause instruction confirmation is not physical zero-power evidence.
Scheduled or manual stops do not become load-balancing pauses merely because
power is zero. Fallback remains explicit when a tighter restriction lowers it.
Unplugged chargers retain numeric allowances when source evidence is usable;
current-setting application and vehicle connection are shown separately.
Current readings use compact rows: **Load balancing: 12 A · Fallback**,
**Charger setting: 12 A confirmed** and **Charging limit: 16 A per phase**.
The balancing value comes first in every numeric mode. There is no duplicate
selected-current row. A confirmed idle standby setting uses the same compact
charger-setting row; its details explain that charging permission is off, the
fallback setting is held and present capacity is confirmed before starting.
Current values are per phase. Pending and blocked instructions remain explicit.
When no limiter instruction is confirmed, usable native current readback remains
in the single charger-setting row as **12 A reported**; it does not claim a
confirmed controller instruction. Easee's calculated allowance is not relabeled
as a native setting.
Setting confirmation does not claim that the standby pilot equals present
headroom or that charging is permitted.

The **Charging currents** view replaces the dedicated session-check view. It
plots the highest property phase current at each timestamp and both charger
allowances on the ampere axis, retaining temperature context on the right axis.
Property current is derived from existing phase history; its reconstructed
interval-average meaning remains explicit. Allowance lines use steps; Charger 2
includes fallback periods in its single allowance line, including zero. Neither
line reports actual draw: a vehicle drawing 5 A can have a 16 A allowance.
A time-aligned **Charger 2 allowance** bar identifies Full allowance, Priority
constrained, Property load constrained, Fallback, Unknown and Inactive. Fallback
takes precedence; otherwise the binding recorded allocation/headroom constraint
defines the state. A lower native or vehicle setting does not replace the
allowance's reason. A known allowance with an ambiguous recorded reason keeps
its numeric line and an Unknown bar; no historical cause is invented.
Unknown allowance periods remain gaps in the line.

A second time-aligned **Property highest phase** bar identifies L1, L2 or L3
using the same phase colours as Phase loading. It is calculated from the same
original phase group and historical voltage segment as the maximum, before
display reduction. Ties show the lowest numbered tied phase and name all tied
phases in the details. Missing phase evidence leaves a gap. Both bars retain
exact intervals within a bounded detail budget; omitted earlier detail is
identified and can be inspected by zooming in.
Charger 1's native session-check points remain available in **All series**.
There is no Charger 2 session-check calculation or recording.

The two new bars belong to Charging currents. The old Shelly-only bars remain
removed from electrical, phase-loading and individual charger charts.
The [change-only recorder](../recording.md#charger-current-allowances)
retains both chargers' allowance histories independently of charging-session
report expiry. Charger 1 is recorded when its Easee connection is configured;
Charger 2 uses its configured integration enablement. Neither history depends
on the Automatic scheduling choice. Historical maxima, modes and source evidence are recorded at the
time; today's settings cannot reinterpret an earlier allowance.
