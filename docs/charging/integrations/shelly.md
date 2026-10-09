# Shelly EVSE integration

[Charging overview](../../charging.md) · [Architecture](../architecture.md)

This page owns the supported EVSE profile, installation prerequisites, protocol
capabilities and native command evidence. See [live current allocation](../current-allocation.md)
for the electrical calculation and [execution and recovery](../execution-and-recovery.md)
for shared authority rules.

The Charger 2 profile targets the [Top AC Portable EV Charger](https://shelly-api-docs.shelly.cloud/gen2/Devices/ShellyX/XT1/TopACPortableEVCharger/) on Shelly XT1. The integration uses the documented EVSE roles for state, current, start permission and electrical data. This is not a generic Shelly relay adapter. [XT1](https://shelly-api-docs.shelly.cloud/gen2/Devices/ShellyX/XT1/) documents role addressing, service state and access permissions; [Number](https://shelly-api-docs.shelly.cloud/gen2/DynamicComponents/Virtual/Number/) documents numeric limits and `meta.ui.step`.

The device documentation's `phase_info` response supplies `phase_a`, `phase_b` and
`phase_c`, each with `voltage`, `current` and `power`, plus `total_power` and
`total_act_energy`. The public provider status exposes phase currents (A), voltages
(V), native active powers (kW), total active power (kW), the accumulated
total (kWh). `phaseMap`
assigns the native phases to installation L1–L3. Original measurement and receipt
times remain visible; missing, retained, stale or disconnected readings are
unavailable even when charger control is available. Conversely, valid read-only
measurements do not require permission to control charging.
The EVSE `phase_info` profile already uses kW for both phase and total power;
generic Shelly watt conversions do not apply. The adapter uses that one unit
contract for display, vehicle matching and meter-allocation weights, without
guessing a unit from the magnitude. Lifetime energy remains kWh.

The provider list uses four groups: phase currents, phase voltages, active power
and recorded phase energy. The power group includes total and phase readings;
the energy group names the native lifetime-counter input. Electrical acquisition
health remains independent of control readiness. Native `energy_charge` and
`time_charge` roles are unused and are not polled.

The manual documents accumulated energy only as a total. No native phase-energy
counters are advertised or created. Recording allocates each accepted native
meter increment using endpoint phase powers into three estimated phase-energy
intervals; their sum preserves the measured increment. There is no fourth
total-energy series, and raw current phase values stay live-only. Unknown phase
shares leave a gap and retain the measured increment as diagnostic evidence.
Easee keeps its existing measured L1–L3 current/voltage readings, reported total
active power and explicitly estimated phase-energy intervals.

## Reported device information

The dashboard hardware card uses the model and firmware returned by the existing
`Shelly.GetDeviceInfo` discovery, with its original receipt time. It excludes
private device identifiers. After reconnect, discovery must establish current
metadata again. This display evidence neither enables a capability nor overrides
the readiness checks below. Historical physical observations belong in
[qualification](#hardware-verification-still-required).

## Installation and capability readiness

Charger 2 defaults to `enabled:false`. Configure `enabled:true`, a concrete
`deviceId` and `topicPrefix` under `charging.chargers.charger2`. The integration
checks the device identity, service 0, unique typed role ownership, access and
reported enum options. Supported connection-state meanings belong to the Top AC
profile, not user configuration. The profile uses `charger_free` for unplugged,
`charger_charging` for charging, and `charger_insert`, `charger_wait`,
`charger_pause`, `charger_complete` and `charger_end` for connected but not charging.
The [upstream Top AC integration](https://github.com/evcc-io/evcc/blob/master/charger/shelly-topac.go)
recognizes these states except `charger_insert`. That additional state is qualified
by the native enum's Insert label and a verified unplug/replug transition with
Auto charge disabled, false start permission and zero measured power. It establishes
a connection, not charging or permission to start.
After current device discovery, an exact live readback can establish a previously
unrecognized connection using its original source time. It must follow the last
confirmed disconnect; polling and restart do not renew an established session.
Unknown or fault states cannot authorize commands or establish an unplug.

For external scheduling, disable native Auto charge in the charger setup; the
[evcc setup documentation](https://docs.evcc.io/en/chargers/shelly-top-ac-portable-ev-charger/)
also requires `auto_charge:false`. This is an explicit native-device setup choice:
the integration reads it and does not silently rewrite it. A connected charger
may then remain in `charger_insert` until an authorized Start.
Disabling Auto charge does not establish that every later device-generated
permission change is an echo of an application command. The owner-approved
[system permission exception](../execution-and-recovery.md#shelly-system-permission-changes)
classifies fresh supported `sys` permission changes as device transitions at any
time or current, including repeated cycles. False or unknown device permission
blocks replacement Start; fresh Enable clears only that device hold. Existing
identification attempts keep their original deadlines, and interrupted pauses
cannot supply continuous stop evidence. Other instructions retain native priority;
matching native-action ambiguity is explicitly accepted. This exception does
not establish a firmware cause or cure for the
[reported permission changes](https://github.com/hokkanen/st-mq/issues/1).

Basic start/stop requires fresh native state, start permission and current setting, working MQTT,
a running service and no active errors or flags. It preserves native current
settings, energy/time caps, automatic-start settings and `auto_balance`.
An admitted packet awaiting storage withholds mutations and new minimum-current
matches, but does not erase still-fresh committed observations or the existing
identification attempt. Native notification readback keeps its separate command
gate. A failed save, stale observations, offline device or native fault still
withdraws readiness; waiting never renews source clocks or identification limits.
Reported hardware maximum and current-setting observations have separate readiness
from command publication. A packet waiting for storage or bounded source-time
admission blocks commands with an explicit processing reason; it does not withdraw
still-valid committed limits, replace an adopted economic plan or reset an
identification attempt. The command reason clears immediately when admission
finishes, and ordinary reconciliation resumes within its five-second polling
cycle. Unknown or invalidated settings, failed persistence, native restrictions
and actual connection loss retain their own unavailable reasons. These checks
do not extend an observation's lifetime or establish that a requested setting
has taken physical effect.
Automatic charging remains a separate dashboard choice. A later setting change
in the native app takes priority for the connection; turning Automatic charging
on does not clear a native Stop or a current choice made during that connection.
Enabled native schedules own start/stop until
removed; removal gives the app release priority for the current connection.
Shelly schedule windows are not inferred from unverified cron semantics.

`limiterEnabled:true` is the default and enables current adjustment independently
of economic scheduling, including Charge now. It requires the supported Top AC
profile, a writable native range with a 6 A minimum and sufficient maximum, and
disabled native `auto_balance`. The profile uses integer ampere settings.
The [Number API](https://shelly-api-docs.shelly.cloud/gen2/DynamicComponents/Virtual/Number/)
defines `meta` as optional presentation metadata, and the
[Top AC API](https://shelly-api-docs.shelly.cloud/gen2/Devices/ShellyX/XT1/TopACPortableEVCharger/)
documents `Number.Set` for `current_limit`. Missing `meta.ui.step` therefore does
not block these supported writes; a supplied value other than numeric 1 does.
Discovery and command preflight retain the same identity, range, native balancing
and freshness checks. Explicit `limiterEnabled:false` retains basic start/stop.
With the limiter enabled, an adjustable current setting carried into a new
confirmed physical connection is not a permanent ceiling. The limiter can
replace it, independently of Automatic scheduling. A genuine external current
choice observed after connection remains a ceiling until unplugging or explicit
**Use automatic**, including across same-session restart and MQTT reconnection.
Owned current writes cannot become external choices. Hardware range, configured
electrical limits and vehicle restrictions remain separate and binding.
The advertised pilot current and the vehicle's selected draw are separate.
A positive vehicle setting below the 6 A pilot minimum can use a valid 6 A
offer while the vehicle retains its own lower limit. Basic scheduling leaves
the existing native current setting unchanged; the enabled limiter may offer
6 A. A known zero vehicle restriction still blocks charging. Native charger,
electrical and shared-allocation ceilings below 6 A still require a pause and
are never rounded up. Expected delivered energy retains the lower vehicle
current; offering 6 A is not evidence that the vehicle draws 6 A.
The scoped minimum-current identification test has separate readiness,
independently of `limiterEnabled`: it writes exactly the reported 6 A minimum
and restores the previously observed native setting. It requires writable role
mapping, a verified numeric range and disabled native `auto_balance`. Missing
`meta.ui.step` does not prevent those exact-value operations; contradictory
reported step metadata still blocks them. It never changes the economic limiter
preference or permits unrestricted current commands.
Configure the installation's fuse ratings, signed calibration margins and maximum current; charger
RPC cannot establish those electrical limits. The limiter subtracts the minimum
admitted measured Shelly phase current equally from the property phases, so it
needs no Shelly-to-Easee phase correspondence. `phaseMap` still defines recorded
phase association and is not inferred by current control.

The [current-allocation contract](../current-allocation.md) defines healthy held
load evidence, observation pairing, priority entitlement and the configured fallback. Current
status readback can confirm an unchanged phase-current value without renewing
its original `last_update_ts`; an old change timestamp alone does not force
fallback. Command and identification evidence retain their separate clocks.
Equalizer's reported allowance and native budget are not prerequisites for the
limiter, which uses the effective electrical limits configured for this installation.

With the limiter disabled, a known native current setting limits
the delivery estimate and ordinary economic control sends no current-setting RPC
or 12 A fallback. The identification reduction and its saved restoration are
the bounded exception. An unknown current setting uses the charger's configured maximum
within forecast per-phase property headroom, following the
[maximum-available-current assumption](../planning.md#maximum-available-current-assumption).
That estimate grants no command readiness or control authority.
With an enabled but unavailable limiter, control waits for its requirements.

Manual `verified`, model/firmware pins, state lists, `minimumCurrentA` and
`currentStepA` are retired configuration fields and are rejected. Readiness is
computed from actual supported capabilities. An older development database must
be replaced explicitly with a fresh current-schema database; it is never migrated or
reset automatically. This prevents previous commissioning/ownership records from
authorizing the new control contract. Shelly acquisition state version 2 also
rejects the earlier incorrect power interpretation and derived meter weights;
controller ownership and restoration obligations remain a separate contract.

Every refresh reads service configuration/status, numeric current capabilities
and [schedules](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Schedule/).
RPC value readback requires positive native `last_update_ts` values in seconds.
Native value and notification clocks may lead the original receipt by at most
one second, under the shared [time-evidence policy](../../time-evidence.md).
These packets wait in a bounded queue for the source time before admission.
Waiting withholds commands and preserves packet order, so Stop and unplug/replug
edges cannot disappear between polls. The queue belongs to the current MQTT
connection and is cleared on disconnect; it never renews a command lease.
Excessive skew, overflow or expiry closes readiness. A deferred correlated reply
completes its original request without another device command or replacement
receipt timestamp. Persisted evidence retains its source and receipt clocks plus
the separate admission time needed to validate the bounded lead.
Zero/unknown timestamps are unavailable. A correlated read renews setting receipt
evidence without changing its original source clock. An unchanged current-limit,
start-permission or work-state reply can have an older update timestamp than its
matching notification; the adapter preserves both timestamps while confirming
the current value from the new query. This alone cannot establish a new native
instruction or confirm a command whose dispatch is in a later source-clock second.
When a native timestamp has whole-second precision, a matching correlated read
requested after the command acknowledgement can confirm an update in that same
second. It preserves the original timestamp; an older second or an unsolicited
observation cannot supply that confirmation. Same-clock unsolicited notifications
do not renew freshness.
Ordinary numeric current commands have a separate ordered-observation recovery:
an acknowledged write can be reconciled by a matching post-acknowledgement read
whose native value and instruction clocks advance beyond the saved, different
pre-write setting in the same equipment and physical session. This verifies the
current setting when the device clock trails the controller, without a clock
tolerance or rewriting either clock. Missing acknowledgements, unchanged native
clocks, missing prior evidence and uncorrelated reads remain uncertain. A known
later native instruction still takes priority, including a same-value selection.
This recovery does not apply to Start/Stop ownership or identification-current
restoration and proves neither physical draw nor who operated the charger.
Post-write verification first settles any poll already in flight, then starts a
new correlated refresh. A pre-acknowledgement query cannot become confirmation
merely because its reply arrived later; this additional read never repeats the write.
A later correlated work-state query may resolve two different known connected
states reported with the same whole-second timestamp. It preserves that source
timestamp. Conflicting notifications revoke earlier queries; connection-boundary
ties, unknown states, older clocks and fractional-clock contradictions remain
blocked. This exception does not apply to start permission, current settings or
physical measurements.
Replies are fenced by MQTT generation,
the setting revision at request publication and intervening command dispatch;
an older contradictory reply cannot overwrite a newer native setting or grant
control. After a readback failure, command readiness returns only after a full
successful refresh; healthy polling preserves existing readiness. A newer
notification error cannot be cleared by an earlier refresh. Physical current
and power retain their measurement age. Meter reset
or jump warnings are separate from command-readiness errors and clear after a
valid subsequent increment, while recorded gaps remain intact. MQTT electrical
acquisition and lifetime-meter recording remain useful independently of control
availability.

[`NotifyStatus`](https://shelly-api-docs.shelly.cloud/gen2/General/Notifications/)
is a partial overlay, with its own event clock in `params.ts`. Omitted attributes
retain their meaning only within a known live baseline; explicit null removes
that evidence. A notification event clock is not a replacement value-update
clock. Changed deltas fence older reads and obtain fresh native readback without
making unchanged values or electrical measurements fresh. Expected notifications
from an in-flight application command still require that command's acknowledgement
and correlated readback before they can confirm it. If a notification arrives
during that read, await a new correlated read after the notification; do not
replay the device command to obtain confirmation.
Preserve observed permission transitions until the controller consumes them,
including a false-to-true sequence between polls whose final value matches the
earlier value. Unavailable, malformed or overflowing event evidence cannot grant
control, and reconnecting does not lend a new live stream an old overlay baseline.
Qualified work-state notifications preserve a disconnect followed by a new
connection between polls. Such a boundary retains its notification-event
provenance; it does not rewrite the native value clock or remove the need for
fresh readback before a command.

After device discovery, connection-state and electrical reads run independently
of control-setting and schedule reads. A failed or timed-out control read closes
command admission but does not prevent a successful physical-state read from
keeping the connection visible. Missing or stale physical evidence still leaves
the connection unknown; neither vehicle feeds nor polling renew measurement
timestamps or establish a new plug event.

## MQTT and commands

The [MQTT channel](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Mqtt/) and [RPC envelope](https://shelly-api-docs.shelly.cloud/gen2/General/RPCProtocol/) are used on the configured broker. Subscription admission precedes bounded ordered replay. Requests use random correlated IDs and a per-instance reply route. Replies must come from the configured device; retained replies cannot confirm a command. Timestamped first-seen DUP notifications can establish a real source event, whereas replay cannot create another plug epoch. Oversized payloads, unknown roles and buffer overflow cannot grant control.

Ordinary mutations use `Number.Set` for `current_limit` and `Boolean.Set` for
`start_charging`. Automatic takeover on a new confirmed physical connection and
explicit **Use automatic** additionally permit
[`Schedule.Update`](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Schedule/)
with `{id, enable:false}` for verified charging-only jobs. It reads the complete
job list and revision before and after each change, preserves unrelated jobs,
and refuses mixed or opaque jobs that cannot safely be attributed to charging.
When the price plan requires waiting, takeover first confirms native start
permission is off before disabling those jobs. A rejected or unconfirmed stop
leaves the schedules intact; uncertain commands retain their durable record.
Superseded schedules remain disabled until externally changed again. A saved
native permission reference prevents an old Stop from regaining priority after
restart or unplugging; genuinely newer source evidence takes priority again.
Native setting reports retain their command-source evidence. A same-value
`sys` update without an intervening observed permission change is a device refresh
and does not revoke saved command ownership.
Fresh `sys` edges follow the [system permission exception](../execution-and-recovery.md#shelly-system-permission-changes),
which preserves physical stops and unrelated native instructions. It does not
extend the exception to native current changes or uncertain application commands.
A newer external update retains manual priority, including a repeated selection
of the same value when newer native instruction evidence is available. The
[Boolean status API](https://shelly-api-docs.shelly.cloud/gen2/DynamicComponents/Virtual/Boolean/)
reports a value-update timestamp, not a command sequence. A successful external
`Boolean.Set(false)` can leave an existing `false` value, `rpc` source and
`last_update_ts` unchanged without a notification. The status API then cannot
distinguish the repeated Stop from an owned automatic pause; a later scheduled
start cannot be fenced by that unobserved instruction. Polling receipt freshness
must not invent a newer instruction or source timestamp. This detection limit
does not weaken the priority of genuinely observed external Stop instructions
over automatic charging and identification restoration. Unknown provenance is
not attributed to this application.
Status-read timestamps describe the completed read, so querying a snapshot
does not manufacture a future timestamp that rejects fresh evidence.
Known session ownership survives application or MQTT restart. Later manual
instructions retain priority until unplugging or Use automatic; a genuinely
missing saved session can take automatic control after fresh native evidence.
An unreadable or invalid state cannot supply that permission. Takeover follows
the economic plan, which can keep start permission false
during a planned pause. With the limiter enabled, takeover supersedes the
adjustable session current choice and leaves the next confirmed current write
to ordinary allocation; it does not replace hardware or electrical limits.
Relay writes, service configuration writes and vehicle writes remain forbidden.

A reply to an already dispatched command is retained even if replanning revokes
that command's intent while the reply is in flight. Revocation stops further
work; the next reconciliation still requires native readback, preserves newer
external instructions and never replays the old command. An acknowledgement
alone does not confirm the setting or its physical effect.

Commands use QoS 0, `retain:false`, no offline queue and no automatic application
retry. Durable intent records association, session, revision and absolute expiry;
authority and scope are rechecked after awaits immediately before publication.

Status distinguishes proposed, dispatched, accepted, read-back and physical-effect stages. A successful RPC response alone proves no current reduction. A possible dispatch followed by timeout/restart remains uncertain until a compatible fresh native reading reconciles it. Manual changes survive priority changes and current-format restart within their connection scope.

## Identification command support

The [shared identification contract](../identification.md) owns attempt budgets,
positive matching, the scoped 6 A comparison, BMW pause handoff and restoration.
Shelly provides native start-permission/current readback and fresh physical
measurements to that contract. It has no native expiry for the temporary current
setting or identification pause: an application/MQTT outage can prolong either,
and recovery must reconcile the original scoped obligation.

A late Shelly Start or Stop notification may carry a fractional native clock slightly
before the application's dispatch clock in the same native setting second. Its
original clock is preserved. Attribution requires the acknowledged same-session
command and a fresh matching RPC readback requested after both acknowledgement and
notification receipt, while that accepted command is still pending confirmation.
This does not absorb an opposite instruction, different-second events or events
without an RPC source, or permit a second write after an uncertain result.
A matching same-second Stop without sufficient acknowledgement/readback remains
stopped and unresolved; RPC provenance alone does not label its sender external.
An owned identification pause retains the original whole-second permission
timestamp, which can precede dispatch within that second; confirmation still
follows the acknowledged command. Its separate physical stop evidence must follow
the pause request before it can identify a vehicle.

## Hardware verification still required

Automated tests use invented device identities and synthetic traffic. They cover
capability discovery, app priority and command fencing, not installation wiring
or autonomous outage behavior. Confirm configured fuse values and margins
against the installation, and qualify measured current changes and peer-priority
responses on the actual chargers. Verify the recorded phase association
separately: the limiter's common minimum-phase subtraction does not commission
the energy-recording map. Online, synchronized and agreeing feed state supports
the live calculation; it is not physical proof of Equalizer response or fuse
protection.

The bounded 2 October 2026 live setup confirmed the expected roles, working MQTT,
source-clocked three-phase measurements and physical Boolean stop/resume. Firmware
1.7.1 omitted `meta.ui.step`: basic start/stop and the scoped exact-minimum and
original-setting operations do not depend on that UI metadata. General current
allocation also accepts absent UI step metadata for the supported profile while
requiring the native range and all other capability checks.
A stop reported `charger_end`
while plugged in; the profile preserves that connection. Native session-energy
comparisons are not implemented; recording uses lifetime-meter increments.
No new live hardware verification was performed for the automatic readiness,
command-provenance or minimum-current identification changes. Private identities
and raw captures remain outside Git.

No autonomous 12 A controller-loss mechanism has been verified. The implemented 12 A telemetry-loss policy requires ST-MQ and a reachable controllable charger. It is explicitly not a hardware protection guarantee. Automatic readiness does not establish autonomous outage behavior or qualify installation wiring.
