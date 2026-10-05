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
each effective budget remains positive. The default is 1 A per phase. Calibration
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

## Pairing changing measurements

Property and charger reports arrive independently. The controller keeps one
previous admitted property/peer/Shelly observation set, scoped to the physical
connection and source epochs. When the derived household demand changes, an
observed charger transition needs a property observation covering the first
source clock for that changed current. Later unchanged samples cannot move that
transition clock forward. Matching property and charger changes that leave
household demand unchanged retain the same entitlement directly.

A changed property total needs current Shelly status confirmation. For Charger
1's periodic OCPP metering, a subsequent measurement confirms peer current.
An unchanged peer value from a healthy synchronized cloud stream instead remains
usable under that feed's held-state semantics; it need not advance its original
change clock merely because household demand changes. Repeated application-cache
reads do not create either feed health or new measurement evidence.

While those reports remain incomplete on healthy sources, the controller holds
at most the last validated ceiling and freshly confirmed native current setting.
Applicable allocation, native and vehicle restrictions can lower that hold;
unpaired readings cannot authorize an increase or a new household-load claim.
The badge and history show **Unknown · Waiting for matching load readings**.
There is no deadline that converts this wait into competing property balancing.
Actual feed loss selects fallback, and a changed session, source epoch or
controller restart discards the process-local observation set.

This is bounded observation pairing, not an atomic meter snapshot. Ambiguous
observed transitions can remain pending; unchanged healthy cloud values alone
do not cause that wait. Neither transport proves that independently received
property and charger samples were taken simultaneously or that Equalizer acted.

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
property overload and separate arrival of property and charger measurements.

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

When measurement pairing is pending, **Unknown** retains the bounded held
allowance and native setting separately. It does not claim current verified
headroom or extend an earlier verified interval.

Hover or drag along the strip, including by touch, to inspect the recorded mode,
integer allowance, reason and application status. Keyboard focus on the strip
supports Left/Right, Home and End. Missing recording coverage stays unknown;
current settings do not rewrite an earlier interval. Dense long selections keep
bounded recent detail and mark omitted older detail unknown, with a prompt to
zoom in. The [change-only recorder](../recording.md#shelly-load-balancing-decisions)
retains this history independently of the 30-day default expiry for unsaved
charging-session reports.
