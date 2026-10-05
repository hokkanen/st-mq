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

Configure the installation's per-phase fuse ratings, safety margins and charger
ceiling. Property and Easee currents use the same Easee phase basis. Shelly does
not need a phase correspondence for this limiter: its contribution is the
minimum of its three freshly measured phase currents, subtracted equally from
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

The property, Easee-current and Equalizer-allowance feeds must be online and
synchronized in their current connection epochs, with complete valid phase
values and original source times. A field's older last-change timestamp alone
does not invalidate held state on such a connection. Reconnects, disconnected
providers, incomplete synchronization and contradictory values do not pass by
rereading a cache. Source clocks remain unchanged and held state is not counted
as another observation or learning sample.

## Independent native-budget comparison

Equalizer's per-phase allowed-current fields 230–232 provide an independent
consistency check. The ordinary numeric comparison requires
`abs(allowance − max(0, nativeBudget − property + Easee)) <= agreementToleranceA`,
which defaults to 2 A. `nativeBudget` is the independently read and verified
Equalizer current budget for the current equipment and connection. It is not
inferred from the allowance being checked. The native budget may differ from
the configured fuse rating used in `H`; reading it never raises or rewrites
Shelly's configured electrical limits or safety margin.

Budget proof comes from a successful read-only native configuration response,
with the actual receipt time and the existing 24-hour allocation-cache validity.
It belongs to the current equipment and acquisition epoch. Ordinary telemetry
polling does not renew that proof; replacement equipment, a new acquisition
epoch, expiry or an invalid response cannot reuse an unverified budget.

The pilot-current field 114 and the charger's circuit current ceiling are
different quantities and cannot replace the Equalizer allowance. Nor is this
allowance clipped to the circuit ceiling: it can report more current than that
circuit permits. Zero remains the reported numeric value; the comparison does
not invent a rule translating all headroom below 6 A to zero. Easee's documented
minimum charging current describes charging behavior, not that field encoding.
See [Easee's observation definitions](https://developer.easee.com/docs/charger-observation-ids)
and [current limits](https://developer.easee.com/docs/current-limits-and-control).

Missing, stale or unverified native budget evidence selects fallback, still
respecting known tighter limits. The comparison excludes the separate configured
safety margin, which is deducted once in `H`. A zero or delayed Equalizer
allowance does not establish an exact gross capacity budget.
Easee can also keep its allowance low while waiting for capacity recovery; that
delay alone does not prove agreement with current load readings.

## Below-minimum idle inference

One narrowly bounded operational inference can admit a zero allowance outside
the ordinary numeric tolerance. The unrounded, unclipped native-budget headroom
`nativeBudget − property + Easee` must be nonnegative and below the verified
6 A native charging minimum. All three Easee phase currents must independently
report at most 0.1 A through native OCPP, with each original phase measurement
clock and the native feed's latest receipt/activity no older than 120 seconds
on the same healthy connection epochs. Other phases still require their own
valid comparisons. This `below-minimum-idle`
basis means observed idle charging is consistent with less than a usable pilot;
it does not assert an undocumented encoding rule for fields 230–232. Preserve
the reported zero, the calculated nonzero headroom and their original clocks.
It never seeds a positive held comparison reference. Headroom at least 6 A,
negative headroom, positive or stale peer current, a non-native peer reading or
another contradictory phase does not qualify. Otherwise disagreement selects
fallback unless the bounded measurement-settling hold below applies.

## Held comparison reference

Equalizer can hold that allowance through a change in Shelly's own draw. Once
the raw comparison agrees at positive, unclipped headroom and Shelly's measured
phase currents differ by no more than 0.5 A, the controller may
retain a bounded comparison reference for that exact allowance observation and
live connection/session scope. Subsequent comparisons account for the change
in Shelly's **measured** common current since that reference:
`max(0, nativeBudget − property + Easee + Shelly_now − Shelly_reference)`.
This prevents a successful current increase from manufacturing a disagreement
with the unchanged allowance. It does not compensate for household changes or
use the requested pilot as measured current. The final headroom `H` still uses
the current property and charger measurements.

The reference stays fixed while its allowance observation and verified native
budget remain unchanged; later approximate matches cannot slide it to absorb
gradual household changes.
Changed observations require a new raw comparison. Zero/clipped observations
never establish an exact offset; they retain the raw comparison or qualify
separately for the `below-minimum-idle` inference above.
Loss of usable feed or native budget evidence, a changed connection or physical
session, and a controller restart discard this process-local reference.
Original observations and timestamps remain unchanged; the comparison reports
its derived basis.

## Measurement settling

Property and charger measurements can arrive at different times after the
controller changes its own current setting. Once that change is acknowledged
and independently confirmed by native readback, a bounded measurement-settling
hold may apply for at most 60 seconds from the first such command's dispatch.
It may retain the lesser of the freshly confirmed native setting and last validated
current allowance. It cannot authorize a further increase. Repeated polls or
commands do not move that absolute deadline. Applicable native, vehicle and
priority restrictions, and independently confirmed tighter property limits,
still reduce the held ceiling. Contradictory phase readings do not establish
new headroom. Lost feed health, authority, connection or session bypasses this
hold immediately; a disagreement that remains at expiry uses the configured
fallback. Neither the hold nor a command acknowledgement renews source clocks
or claims a valid current load model. The badge and history show **Unknown ·
Waiting for matching load readings**, with the held allowance and actual native
setting readback kept separate from measured draw.

## Shared priority

Shelly priority excludes Easee's present draw from this fuse test. If household
demand excluding both chargers leaves 16 A on every phase, Shelly may take 16 A
within its own limits, and Equalizer must reduce Charger 1. A temporary property
total above the limit caused by Charger 1, a conservative forecast allocation or
a secondary deadline reservation must not lower Shelly's live entitlement in
this priority. Economic scheduling still chooses permitted charging periods;
forecast delivery remains an estimate. Equalizer response and actual installation
protection are not guaranteed by this model.

For unscheduled charging, including Charge now, coherent live headroom follows
the peer's measured draw or its confirmed open charging instruction. Balanced
priority shares this headroom; Charger 1 priority reserves that peer demand
first. Economic forecast ceilings do not cap unscheduled current. Unused peer
capacity remains available to Shelly, including when Charger 1 is stopped. A
controller-owned current pause can resume when that share reaches 6 A; an
external Stop cannot. A connected idle car alone is not evidence of requested
current. If total headroom cannot support two 6 A pilots, retain the existing
charging turn in Balanced priority instead of repeatedly stopping and starting
both cars. Scheduled Automatic charging continues to use the joint planned allocation.

## Current steps, dwell and dispatch

A common current is rounded down to the supported profile's 1 A step. The native
range must report a 6 A minimum and a sufficient maximum. Shelly's optional
`meta.ui.step` describes UI presentation: an absent value does not disable
supported integer current writes, while contradictory reported metadata blocks
them. Values below 6 A cause an EVSE pause, not an invalid current RPC. Decreases
do not wait for the increase dwell; increases ramp by the configured step budget
after dwell, and resumption also requires dwell and permission. Native lower
current choices, start/stop, energy/time caps, faults and schedules retain
authority. Enabled native schedules conservatively own start/stop until
disabled/removed; ST-MQ does not guess their cron window or rewrite them.
Current limiting remains separate.

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

Shelly's measured currents, command preflight and native readback retain the
strict `maxAgeMs` bound, initially 15 seconds. This is separate from admitting
held Easee stream state. The default per-phase margin is 1 A; increases ramp by
2 A after a 30-second dwell. There is no second feed-age setting. The retired
`additiveCurrentVerified` and `maxSkewMs` configuration fields are rejected;
there are no aliases or configuration translations.

A temporary live fallback does not impose a permanent 12 A delivery ceiling in
the economic forecast. Unknown future supply uses the documented
[maximum-available-current assumption](planning.md#maximum-available-current-assumption)
within forecast property headroom and applicable native, vehicle and electrical
limits. The live controller independently retains fallback until its evidence
is usable; an optimistic forecast never grants current-control permission.

If the process, broker or charger is unavailable, ST-MQ cannot apply a new fallback. **Autonomous controller-loss behavior is unverified.** There is no invented watchdog, command TTL or broker-will guarantee. Actual last-setpoint, reboot and outage behavior must be established with the arrived hardware before unattended deployment. The status reports this separately from a successfully requested telemetry-loss fallback.

## Load-balancing status and history

Shelly's card shows a **Load balancing** badge. The Electrical power, Phase
loading and individual Charger 2 power charts show the same meanings in a thin,
time-aligned row below the plot: green **Unrestricted**, blue **Limited**, purple
**Paused by balancing**, amber **Fallback**, grey **Inactive** and hatched
**Unknown**. The row title opens its explanation and complete colour key.

The load allowance is a controller ceiling, not measured charging current.
Unrestricted means load balancing allows the configured maximum; a tighter
native or vehicle limit can still reduce the effective allowance. The detail
shows that effective allowance and confirmed native setting separately. A pause
instruction confirmation is not physical zero-power evidence. A scheduled or
manual stop never becomes a pause attributed to load balancing merely because
the car draws no power. Fallback remains visibly fallback even when another
restriction lowers its effective cap below 12 A.

The bounded wait after a confirmed current-setting change uses the existing hatched
**Unknown** state with **Waiting for matching load readings**. Its details retain
the held allowance and confirmed charger setting, while stating that current
headroom is unconfirmed and no further increase is permitted during the wait.

Hover or drag along the strip, including by touch, to inspect the recorded mode,
integer allowance, reason and application status. Keyboard focus on the strip
supports Left/Right, Home and End. Missing recording coverage stays unknown;
current settings do not rewrite an earlier interval. Dense long selections keep
bounded recent detail and mark omitted older detail unknown, with a prompt to
zoom in. The [change-only recorder](../recording.md#shelly-load-balancing-decisions)
retains this history independently of the 30-day default expiry for unsaved
charging-session reports.
