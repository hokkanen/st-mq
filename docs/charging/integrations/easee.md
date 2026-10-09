# Easee charger integration

[Charging overview](../../charging.md) · [Execution contract](../execution-and-recovery.md)

The cloud scheduling path below applies when native OCPP is inactive. Activating
native OCPP transfers charging authorization and scheduling to the local server;
it cannot be treated as a telemetry-only change. See the local connection section
below for setup and activation requirements.

| Task | Section |
| --- | --- |
| Understand the cloud scheduler | [Cloud execution](#cloud-execution), [API contract](#api-contract-checked-on-2026-09-15) |
| Understand native instruction precedence | [Ownership and manual controls](#ownership-and-manual-controls) |
| Set up local authorization and telemetry | [Native OCPP](#direct-local-ocpp-telemetry-firmware-344-or-later), [endpoint and pairing](#endpoint-and-pairing) |
| Assess what was physically verified | [Qualification scope](#qualification-scope) |

Reported model and firmware in the dashboard come from OCPP BootNotification
when available. They retain their receipt time and become unavailable after a
connection loss until a new admissible boot report. Cloud mode does not invent
those local observations. Firmware 344 is the documented native OCPP minimum;
actual qualification remains scoped to the evidence below.

## Cloud execution

The controller installs native one-off starts. For a split plan, it installs the
next delayed start at each intermediate period's end, pausing until that start.
No final stop is installed at the target or deadline. New prices may replace an
active period with a cheaper feasible plan as described below. These transitions
require a running application and working Easee
connection. A missed pause may cost more, but cannot leave an automatic final
stop waiting on the charger. The Easee app shows the current native instruction;
the dashboard shows the complete proposed periods and their confirmation state.

The planner avoids pauses and intermediate periods shorter than 15 minutes and
prefers fewer periods when their actual modeled electricity costs are equal. Intermediate periods normally retain their confirmed end while
updated remaining energy and power forecasts can revise later periods. New or
revised remaining price intervals can also replace an active period, including
final release, while the target is unmet and the original ready-by time is still
ahead. The replacement must meet that deadline and lower actual modeled cost on the
remaining charge, crediting energy already delivered. An immediate pause requires
at least 15 minutes of the current charging period and a gap of at least 15
minutes. It uses the same native delayed start and pause confirmation as other
period transitions; manual instructions retain priority.

Repeated price data, including after restart, and metadata-only updates do not
trigger reconsideration. Ordinary telemetry and setting changes do not themselves
interrupt final release. Completion and readiness are recalculated against the
periods actually retained for execution. An immediate allowance caused by missing
inputs or insufficient predicted time remains provisional: it can be rescheduled
when the forecast improves.

New vehicle planning waits for a confirmed connection. Disconnect relinquishes
an owned future delay, while readiness-cycle manual priority survives. Replanning
uses fresh connection state before any write. The existing Easee authentication,
token persistence, rate budget and controller authority checks protect requests.
The HTTP transport separately opts in to narrowly validated scheduling writes.

Routine charger and Equalizer observation reads share the acquisition SignalR
cache, with REST backup when required readings are unavailable. One connection
serves the configured Charger 1 and Equalizer; this does not add multiple Easee
chargers. Streaming and REST share the same token refresh and persistence.
Schedules, hourly Equalizer configuration and all commands remain on REST.
Before native schedule mutations and during their readback, the adapter forces
fresh REST observation reads rather than relying on the stream cache. Original
measurement timestamps and the existing freshness guards still apply.

Small source-clock leads wait for admission in receive order within each device;
ready observations from the other device continue independently. Held current
evidence is withheld for pending requested fields or that device's online state.
An unrelated pending power report does not invalidate already admitted current
fields. Timer admission preserves the original source and receipt clocks.

Live changes in Charger 1's mode (109) and pilot state (100) are saved as
transition evidence before waking the controller. This preserves short
connection changes even when the latest cached state has already changed back.
Enabled state (31), no-current reason (96) and online state (250) also trigger
prompt reconciliation, with closely spaced updates coalesced into one wakeup.
Equalizer and current updates do not trigger these control wakeups; periodic
reconciliation and REST fallback remain available for recovery.

A transition requires a known previous value, a strictly newer changed source
observation after the current subscriptions became ready, and a source age no
older than fifteen minutes. Initial snapshots, reconnect replay, unchanged
values, conflicting clocks and REST cache reconciliation cannot manufacture
live transition evidence. The stream callback carries only parsed observation
values and source/receipt clocks; command authority, fresh REST preflight and
readback remain unchanged.

## API contract checked on 2026-09-15

The official public OpenAPI definitions were read for these endpoints:

- [Scheduling state](https://developer.easee.com/reference/getchargersschedules):
  `GET /api/chargers/{chargerId}/schedules` returns `enabled` (the active schedule
  type or `none`) and stored `delayed`, `daily`, `weekly`, `offPeak` and `tariff`
  schedules. Only the active instruction determines session/manual ownership;
  the complete state is compared immediately before a write to detect races.
- [Create delayed schedule](https://developer.easee.com/reference/postchargersschedulesdelayed):
  `POST .../schedules/delayed` takes `enabled`, IANA `timezone`, `startTime` and
  integer `maximumAmps`. **`startTime` is a local clock time, not an absolute
  date-time.** ST-MQ stores the absolute planned start and verifies that the next
  local occurrence represents it. Starts beyond that occurrence and ambiguous
  autumn clock times are rejected with their specific cause. Plans use whole
  seconds; a start that arrives during an API read triggers a fresh immediate
  decision instead of attempting to represent 'now' as tomorrow's local time.
- [Disable delayed schedule](https://developer.easee.com/reference/postchargersschedulesdelayeddisable),
  [disable daily schedule](https://developer.easee.com/reference/postchargersschedulesdailydisable),
  [disable weekly schedule](https://developer.easee.com/reference/postchargersschedulesweeklydisable):
  `POST .../schedules/{kind}/disable` has no request body. Disabling the effective
  schedule preserves its stored definition. The adapter does not use legacy
  basic-charge-plan endpoints, stop/start/authorization commands or current blocks.
- [Schedule behavior](https://support.easee.com/hc/en-gb/articles/4413246412561-Schedule-Smart-Charge):
  Easee documents one active schedule type and a one-off delayed start that
  continues charging until the vehicle is finished.

The [daily](https://developer.easee.com/reference/postchargersschedulesdaily) and
[weekly](https://developer.easee.com/reference/postchargersschedulesweekly) APIs
support bounded repeating periods. Nullable request fields do not establish a
documented open-ended final period. The implementation therefore chains delayed
starts instead of installing a recurrence with a final stop that would need
later removal. This application/cloud dependency is intentional and disclosed.

An accepted schedule readback does not itself confirm that an already charging
vehicle paused. A planned pause is confirmed only when the charger reports a
noncharging state and no-current reason **54**, pending scheduled charging. Until
then the card says the pause is unconfirmed. Other zero-power causes, such as
Equalizer limiting, do not establish that the requested schedule took effect.

## Ownership and manual controls

The REST preflight and schedule operations in this section describe the cloud
backend. Direct OCPP keeps the same instruction precedence through the separate
[native app priority](#native-app-priority) and
[cloud outage](#easee-cloud-outages) rules below.

Before each mutation the adapter rereads the schedule and control observations over REST,
then compares them with the expected state. It persists the write intent before
dispatch and confirms the result by reading back. A successful HTTP response
alone is not presented as an installed plan. A failed or interrupted write is
reconciled on the next poll or restart.

Turning control off invalidates pending automatic work immediately. Cleanup
rereads Easee and disables only an exact match for ST-MQ's confirmed restriction.
An in-flight write is reconciled before cleanup. Newer manual schedules are
preserved. Failed communication leaves an explicit unconfirmed-handover status.
Process shutdown revokes new writes and drains outstanding work before storage
can close; it does not invent a charger handover during authority transfer.

The observed instruction baseline persists and is refreshed even while control
is off or no vehicle is connected. With Automatic enabled, a new confirmed
physical connection supersedes earlier charger instructions and native schedules,
including daily and weekly recurrence. A genuinely missing saved session follows
the same policy after fresh connection evidence. Restart or network reconnection
preserves known ownership; unreadable or invalid state cannot grant takeover.

External instructions observed later in that connection take priority. A simple
daily/weekly window lasts through its **current or next concrete end**, even
beyond ready-by, unless the vehicle is unplugged or Use automatic is selected.
Multiple periods and unknown/ambiguous ends require explicit resumption or a new
physical connection. Restarting, OFF/ON and editing ready-by do not move a window
end. Own confirmed/recovered writes, inactive
schedule caches and normal one-off expiry are excluded from manual detection.

The explicit Use automatic action acknowledges the displayed native instruction.
A newer edit discovered during its fresh read wins again. Expiry also requires a
fresh read before handback; loss of communication keeps handover visibly pending.
The controller records why handback occurred so the runtime can advance to the
next readiness cycle when the manual window ends after ready-by.
Ongoing automatic charging is not itself evidence of
a manual action or of final release: intermediate periods remain schedulable.

[Override Charging Schedule](https://developer.easee.com/reference/charger_overrideschedule)
is a documented current-session release, but the public schedule response has
no dedicated manual-override flag. The controller observes
[mode, enabled state and no-current reason](https://developer.easee.com/docs/enumerations)
alongside schedules. An observed schedule removal or enable action has priority
for the connected session. A fresh charging-mode observation after a verified
scheduled wait (reason 54), before the owned future release time, also identifies
Charge now when `/schedules` remains unchanged. ST-MQ then relinquishes only its
own delay and yields until confirmed unplug or explicit resumption.
Initial charging before any verified pause is separate and remains schedulable.
An enabled charger with a zero dynamic charger ceiling and no-current reason 52
also reports a stop restriction. Observation 48 supplies that ceiling and its
source clock; missing or older evidence cannot authorize a resume. Zero power,
Equalizer pauses and ordinary operating-mode changes do not create manual
priority. Ordinary scheduling preserves a disabled charger,
authorization request or fault. Final release remains open even after its
estimated completion/deadline.

New-connection automatic takeover and the separate **Use automatic** action
supersede earlier observed manual instructions and disable supported
delayed/daily/weekly charging schedules.
It may use the documented [enabled setting](https://developer.easee.com/reference/charger_setchargersetting)
and [resume command](https://developer.easee.com/reference/charger_resumesession).
It never uses the authorizing start command. Resume resets Easee's dynamic
charger ceiling: a distinct positive restrictive ceiling blocks this command;
an explicit stopped zero ceiling can be cleared only with known hard electrical
limits. No charger/circuit/cable setting is increased. A future economic pause
is installed and confirmed before enabling or resuming the charger. Cloud mode
uses a delayed schedule; local OCPP uses a bounded zero-current profile on a
confirmed transaction, never a second cloud economic schedule. An unconfirmed
transaction therefore cannot perform a takeover requiring a future pause.
Source-clocked preflight and readback fence newer changes. Superseded native
schedules are not restored, while subsequent external instructions regain
priority. State observations cannot guarantee who or which app issued them.

The policy covers native charger schedules, but the public Easee API documents
disable operations only for delayed, daily and weekly schedules. Its read model
also includes off-peak and tariff schedules without corresponding documented
disable operations. Those types remain visibly blocked rather than being
reported as replaced; unrelated site settings are not changed. See the
[official schedule API](https://developer.easee.com/reference/getchargersschedules).

Streamed events preserve reported changes between routine polls. App taps that
leave the same state and transitions Easee does not report remain invisible;
even a one-second unplug requires the provider to emit both connection changes.
Charger transitions alone do not identify BMW without its corroborating vehicle
evidence. A charge-now override that leaves
scheduling state unchanged and never produces a charging observation (for example,
while continuously Equalizer-limited) can remain unidentifiable. Easee documentation
does not explicitly guarantee mid-session pause behavior for every overridden
session; failed pause confirmation stays visible instead of being inferred.

Transport/readback failures retain durable intent and distinguish the prior
confirmed instruction from the latest unconfirmed command. Invalid proposed
starts expose the actual limit/time/DST cause and next action. A pre-write race
gets one bounded fresh-read retry; clock time is refreshed after asynchronous
reads and planning. Persisted execution periods survive loss of native one-off
state, so intermediate release is not mistaken for the final period.
A confirmed-pause watermark prevents false missed-pause notices after restart.
The most recent entirely unconfirmed gap is retained as a compact session notice;
no late stop is issued to make up for it, and disconnect clears the notice.

The REST API does not document conditional writes or a server-side compare and
swap. Rereading narrows the race with concurrent app edits, but an app write
between the final read and POST cannot be excluded. Readback detects mismatches
and yields. App visibility, device acknowledgement latency, and Charge now while
Equalizer-limited still need to be observed on the installed charger. No live
commands or hardware verification were performed for this implementation.

## Forecast limits

The adapter projects documented [charger observations](https://developer.easee.com/docs/charger-observation-ids):
circuit maxima 22–24, charger maximum 47, cable rating 104, dynamic charger and
circuit caps 48/111–113, and instantaneous Equalizer availability 230–232. These
quantities remain separate: a mixed minimum or a schedule-related zero must not
be displayed as Equalizer allowance. Original
timestamps remain available. It reads the Equalizer
[configuration](https://developer.easee.com/reference/equalizer_geequalizerconfig)
at most hourly to obtain `maxAllocatedCurrent`, an overall charging allocation.
That allocation caps only the Equalizer-controlled charger. There is no
main-fuse prerequisite or UI limit/reserve. Equalizer remains responsible for
actual load balancing; no installer limits are changed.

Three-phase charging is assumed, independent of active output-phase observation.
The adapter also reads [Equalizer observations](https://developer.easee.com/docs/equalizer-observations)
31–33 for property currents and 34–36 for phase-to-neutral voltage. Charger
observations 183–185 provide its phase currents. A coherent observation estimates
the supply budget as Equalizer allowance plus property draw minus Charger 1
draw. Positive allowance reports and source readings within 20 minutes are
required to establish new evidence; original event clocks remain distinct from
stream receipt or a successful REST read. Confirmed idle current can remain unchanged.

Up to 12 independent samples from the preceding 24 hours survive restart.
Uncapped observations provide a robust central estimate; observations clipped
by allocation only establish a lower bound. Configuration changes reset this
evidence, and an offline charger cannot make it available. This prevents a
single busy-evening allowance or sparse current update from defining every
overnight slot, without claiming to have retrieved the physical fuse rating.

The planner replaces present demand with comparable household-history patterns
and known scheduled charging, applies per-phase limits and the 6 A minimum, then
averages the resulting charging power. The household reference includes original
0.7.5 current/temperature imports and keeps older cold-weather conditions useful;
see [household history](../planning.md#planning-and-equalizer). With no usable supply-budget
evidence it uses live net allowance without subtracting demand twice. Missing
voltage never becomes an invented nominal value. Both household chargers use the
published smoothed per-phase voltage estimates for planned power and duration.
Only the Easee charger and Equalizer supply these estimates, in priority order
Charger 1 OCPP, Charger 1 Easee Cloud, then Equalizer Easee Cloud. Charger 2
voltage is excluded because its phase order is not verified against those sources.
Valid live Easee voltage is provisional startup evidence until the estimates are
established. Present-time measurements and native current limits retain their
separate authority. See [smoothed phase voltage](../../recording.md#smoothed-phase-voltage).

`test/charging-easee-control.test.js` covers the documented wire format,
normalization, delayed release, replanning, restarts, in-flight OFF races,
readiness-cycle expiry and acknowledgement races, disconnected observation,
mid-session pauses, final release, latency, Charge now, stops, uncertain
handovers, and the transport's restricted write allowlist. Fixtures use invented device names and
synthetic tokens; these checks require no Easee account or hardware.
`test/charging-easee-stream.test.js` verifies routine shared-cache reads and
forced REST observation preflight/readback without weakening schedule ownership
or device freshness checks. `test/easee-stream.test.js` also verifies individual
short mode/pilot transitions, startup and reconnect suppression, REST isolation,
source-clock bounds and callback failure handling.

## Direct local OCPP telemetry (firmware 344 or later)

ST-MQ prefers the charger's native OCPP electrical measurements when they are
complete and fresh, then falls back to the existing Easee cloud stream/REST
acquisition. **Data and settings** identifies **Easee local OCPP** or **Easee
cloud** for the affected fields. This is a direct OCPP 1.6J central-system endpoint,
not the cloud-emulated OCPP service and not an HTTP API on the charger.

Native OCPP activation transfers control as well as telemetry. An
[Easee maintainer confirmed on 22 September 2026](https://github.com/easee/connect/discussions/2)
that the connected native OCPP server takes over charging authorization, RFID
handling and charge schedules. The cloud scheduler described above cannot be
assumed to remain effective after activation. ST-MQ selects one charging control
backend at a time. Initial activation checks for an active cloud schedule before
suspending the cloud controller. An active schedule defers commissioning,
preserving both the restriction and any pending automatic takeover in the cloud
controller. Once that schedule clears or expires, setup drains the old controller
and checks again before applying native configuration. Missing native control readiness or
an unfinished handover stays visibly pending. Falling back to cloud readings
does not switch the charging controller back to cloud schedules.

**Stopping ST-MQ leaves native OCPP enabled.** Normal Ctrl+C, service stop and
restart close the connection while retaining the setup journal, charging control
intent and outstanding profile obligations. They do not apply `OcppOff`, clear
owned pauses or switch the charger to cloud operation. Paired handover preserves
the same state so the charger reconnects to the shared address on the next
controller. Startup verifies matching installed configuration without immediately
rewriting or applying charger configuration. Fresh authenticated local readings can establish a matching
installation when its setup journal is genuinely absent; an unconnected initial
installation still requires confirmed commissioning.

An ordinary stop, crash, suspension or power loss is a local connection outage.
A new charge or Easee app Start can wait for ST-MQ approval while the controller
is unavailable. Restart ST-MQ to restore local control. Returning to cloud
control requires explicitly disabling the integration or Direct OCPP through
Easee configuration. There is no seamless cloud-control backup. An existing
pause expiring on the charger only removes that restriction; it does not restore
cloud authorization for a new charging session.

The local receiver supports charger power, phase currents and explicitly
identified phase-neutral voltages. Its voltage-only feed remains usable without
a complete power/current snapshot, while electrical integration and control retain
their independent readiness requirements. Saved estimate provenance identifies
all contributing feeds and the latest contributing feed at that historical time.
Property/Equalizer readings and finalized
cloud session checks remain cloud data; connector 0 is never guessed to mean
an Equalizer meter. A working local socket or complete electrical readings do
not prove that charging authorization or scheduling is functioning.

When activation prerequisites are met, ST-MQ performs charger-side setup through
the existing authenticated Easee cloud connection. On startup and after **Apply
configuration**, it checks the stored charger connection, saves the required
`DualProtocol` settings when needed, applies the returned version and waits for
the charger to connect. The owner does not need a separate commissioning script
to make these API calls. Setup retries are bounded; a cloud setup request
succeeding does not establish that the local socket or its measurements are ready.

The charger must have firmware 344 or later, working Wi-Fi and Easee selected as
the site operator. `easee.local_ocpp.authorization_mode` selects authorization:

- `rfid` is the default. Configure explicitly permitted tags in
  `authorization_tags`; unlisted tags are rejected. An empty list keeps this
  mode pending.
- `plug-and-charge` authorizes a connected vehicle without an RFID tap. ST-MQ
  derives a private virtual tag from the installation credentials and uses it
  for `RemoteStartTransaction`. No physical tag list is required in this mode.
  A remote-start acknowledgement alone does not prove charging: the native
  transaction and physical state must follow. The controller grants a short-lived
  start permission only when the current plan or an allowed session action calls
  for charging. A scheduled wait, saved stop, missing fresh local readiness or
  incomplete takeover cannot authorize startup. This gate covers outgoing remote
  starts and incoming authorization/start requests for the private virtual tag.
  Virtual-tag authorization replies expire immediately from the charger cache;
  accepted transaction retries keep their original durable reply. Configured RFID
  tags retain their independent authorization rules.

  While this local plug-and-charge controller owns authorization, Easee's
  **Awaiting Authentication** mode (7) and **Pending authorization** reason (55)
  describe approval the controller must supply. They do not independently block
  an otherwise permitted start. The current plan, physical connection and fresh
  local readiness, together with known applicable instructions, determine
  permission; a future charging period keeps
  waiting. De-authenticating mode (8), faults, external stops and RFID restrictions
  retain their existing meaning. Cloud scheduling cannot grant this local
  authorization. These values follow the documented
  [Easee enumerations](https://developer.easee.com/docs/enumerations).

Without an explicit password, standalone ST-MQ creates a private
`easee-ocpp-credentials.json` file in its data directory; paired computers derive
the same purpose-specific password from their shared pairing token and charger
identity. Generated passwords have 20 characters. An explicit
`local_ocpp.password` must have 16–20 characters; the live setup API rejects
longer values. `local_ocpp.charge_point_id` is needed only for a custom identity.
Cloud credentials remain configured for setup, fallback readings and cloud
control while native OCPP is inactive.

### Native app priority

Local OCPP follows the same session ownership and instruction precedence as the
cloud controller. Local connection state, transaction reports and measurements
provide local readiness and physical evidence. Source-timed cloud/stream enable,
stop and schedule observations supplement that evidence when available; their
absence is not a charging restriction. Ordinary scheduling within an established
session does not mutate cloud schedules and never installs a cloud economic
schedule while OCPP owns control.

New-connection automatic takeover and explicit **Use automatic** supersede earlier
instructions using the supported operation for the observed restriction. Local
operations use OCPP; exceptional removal of a positively identified native
dynamic-current zero Pause can still need cloud Resume. Required economic pauses
must be confirmed before releasing an observed restriction. Unsupported removal
remains visible instead of being claimed as successful. Observed later native
Stop prevents ordinary automatic resumption. Observed later enable or schedule
removal yields the current physical connection to external control; only the
application's exact OCPP profile is released. Native current limits remain in
the charger.
A fresh Charging observation before an owned, physically confirmed pause expires
also establishes an app release. `SuspendedEVSE` or zero power alone does not
identify a manual action.

An actual OCPP `StopTransaction` with reason `Remote`, `Local` or `DeAuthorized`
is definite local stop evidence. It blocks replacement Start for the same
physical connection and survives restart until the applicable instruction is
superseded. ST-MQ's own charging-profile pauses do not create that transaction
stop. A missing reason or generic suspended status does not establish a manual
instruction, and the reported stop reason does not identify a particular person
or application.

The receiver tolerates a source clock lead of at most one second. Transaction
messages wait once until their source time arrives, then recheck authorization,
connection and storage. Original source and first-receipt times stay distinct;
retries and buffered messages cannot renew evidence. Larger clock leads remain
invalid. Meter-based transaction recovery uses the same bounded tolerance.

Known schedule windows retain their original end across restart, Automatic
OFF/ON and ready-by edits; ambiguous ends require explicit resumption. Handback
requires fresh schedule evidence, and a newer app change wins over a queued
resume or profile write. Manual session priority lasts until physical unplug or
explicit resumption; transaction rollover alone is not an unplug.

The integration cannot identify app taps that produce no observable change.
OCPP status alone cannot identify who issued an instruction or distinguish every
native pause from other causes of suspension. A controller outage still has the
authorization and pause-expiry limitations described above.

### Easee cloud outages

Once Direct OCPP is commissioned, normal local approval, scheduled starts and
pauses, Charge now, permitted identification and valid session recovery operate
without a successful Easee cloud read. A confirmed new plug-in follows Automatic
takeover locally. A same-session restart preserves its durable authority and
known later external instructions. Local commands do not wait for cloud polling
or renew permission from a cached cloud response. Background setup checks remain
distinct from an already authenticated, working local installation.

If the commissioned charger has no local connection for five minutes while the
listener is ready, a separate recovery attempt can reapply its unchanged, verified
connection configuration through Easee cloud. It requires matching owned settings,
supported firmware, online/Wi-Fi readback and unchanged configuration/version
immediately before Apply. It never stores replacement settings, applies `OcppOff`,
hands control to cloud scheduling, clears charging instructions or closes the local
listener. A cloud error leaves the existing local installation available for
reconnection; ordinary local operation still needs no cloud reply.

Recovery reserves at most three attempts per outage in the setup journal, before
dispatch, including attempts whose result is uncertain. Further attempts wait at
least 15 minutes after the first and 60 minutes after the second. Provider failure
and rate-limit backoff can lengthen those waits. Restart/handover retains the used
budget and adds a fresh five-minute observation period. An authenticated open
socket suppresses recovery even before electricity readings are complete; actual
OCPP traffic clears the used budget independently of cloud access. A reconnect
during verification, storage or token refresh cancels the pending Apply. After the
budget is exhausted, the connection panel requests charger/network attention and
the listener keeps accepting connections. Reapplication is an attempted recovery,
not proof of receipt or restored physical charging; installed hardware recovery
still needs validation.

Missing, stale or unknown cloud data supplies no new contrary instruction. It
does not become synthetic fresh `enabled`, `none` or zero-current evidence and
does not erase a known Stop or manual schedule. A returning observation keeps its
original source time and session scope; a later receipt alone cannot turn an
old instruction into a later external choice. New admissible contrary evidence
still fences queued commands. Local disconnection, device refusal, faults,
authorization restrictions and unresolved restoration remain independent of the
cloud service's availability.

Property and supplementary limit readings retain their actual source and
availability. Charger 2 uses its configured current fallback when the cloud
Equalizer feed is unavailable; the local charger retains native protection.
Unknown cloud current data is not invented headroom or proof of electrical
readiness. This contract covers Easee cloud loss, not the loss of the local
controller, LAN, price source or vehicle feeds.

Initial commissioning still uses Easee's API. A positively identified native
Pause that sets the dynamic charger ceiling to 0 A also has a separate cloud
Resume recovery path. It is distinct from an ST-MQ-owned 0 A OCPP profile, which
can be cleared locally by its exact ID or expire on the device. An unexplained
zero-power or suspended state never authorizes Resume or raising current.

### Native charging pauses and identification current

For an economic pause, the native controller installs an absolute,
transaction-scoped `TxProfile` with a **0 A restriction**. The profile identifies the current confirmed native
transaction and expires at the planned release time using both `validTo` and
schedule duration. ST-MQ verifies the effective zero-current interval with
`GetCompositeSchedule`; an accepted write alone is not confirmation of the
pause. Only its own profile ID is cleared for an earlier release. Cleanup still
requires the current authorized connection, but can remove that exact profile
when the old transaction is no longer confirmed. A missing profile ID is rejected;
ST-MQ never turns an incomplete cleanup instruction into a clear-all request.

An ordinary schedule query rejected by a transient admission gate, timeout or
unavailable transport does not erase an already confirmed profile. The controller
first rereads the native connection, transaction and instructions; only unchanged
scope can retain the original confirmation. Original power freshness and profile
expiry still apply, and contrary measurements or instructions withdraw it. A
later successful query verifies the existing profile without rewriting it.

At expiry, the restriction disappears on the charger without a new resume
command. Charging then follows the charger, vehicle and Equalizer's existing
limits. Normal release does not impose an artificial current setpoint or use a
returned composite limit as the actual available current.
Intermediate pauses still require a running controller to install the next
restriction. A process or network outage can therefore miss a future pause and
increase cost, while an already installed restriction retains its own expiry.
This expiry does not authorize a new transaction or return the charger to cloud
control after an abrupt controller loss.

Extra identification charging during an economic delay briefly releases the
owned pause at the charger's normal current, retaining all native charger,
vehicle and Equalizer limits. The controller monitors the 0.15 kWh allowance and
saved safety deadline, then reinstates the applicable economic pause. This uses
the established zero-current pause and release commands; no positive-current
profile is installed. The energy/time guards need the application and working
communication, so an outage can extend extra charging. The software deadline
uses the hardware current ceiling, at least 253 V across three phases and a
ten-second stopping reserve, normally ending much earlier than the five-minute
maximum. The resulting zero-current restriction can last until the scheduled
economic release; the ordinary 90-second correlation-pause expiry does not end
that economic hold. See the
[identification lifecycle](../identification.md#vehicle-assignment) and the
[qualification scope](#qualification-scope) for the physical validation scope.

During a bounded identification probe or correlation pause, existing controller
updates may request `TriggerMessage` with `MeterValues` for connector 1, using the
same native request as telemetry setup. At most one sample request is in flight,
no more often than once per two seconds, within the original attempt deadline.
Only actual meter reports provide evidence; the acknowledgement cannot renew
measurement clocks. The next controller action cancels the read-only request so
its missing reply cannot delay a pause or restoration. Known rejected or
unsupported sampling is suppressed until the next native connection. Ordinary
economic operation does not use this sampling loop.

### Qualification scope

Temporary candidate-component tests on 6 October 2026 blocked all candidate
Easee HTTP requests and disabled its cloud stream while using the real charger.
They confirmed an accepted local transaction and about 11 kW measured charging,
an OCPP economic pause with composite readback and fresh zero power, recovery of
that pause after restarting the receiver and controller from serialized state,
and local profile release with measured charging resumed. An external Stop was
received directly as `StopTransaction(reason: Remote)`, survived controller
restart and Charge now, and was superseded only by explicit Use automatic.
Local `ChangeAvailability(Operative)` also recovered an externally disabled
charger and restored measured charging without candidate cloud access.
The tested source also handles the observed subsecond charger clock lead without
inventing timestamps. These tests exercise the actual candidate control and
acquisition components, not a complete HA reboot or physical unplug/replug.
The installed application files and pair roles were unchanged.

Bounded physical command tests on 6 October 2026 confirmed local Start and
measured charging, local `ChangeAvailability(Operative)` recovery
after a cloud-issued Disable, local Start after a cloud-issued Stop, and a local
0 A OCPP pause followed by exact-profile release and resumed charging. Delayed
and daily schedule activation requests were rejected with HTTP 409 while the
reported scheduling provider remained `ocpp.direct`. These observations do not
establish that every schedule type or firmware behaves identically.

The same tests could not clear a cloud-issued dynamic-current 0 A Pause through
local Start, `ChangeAvailability`, or a stop/start cycle. The charger reported
`DynamicChargerCurrent` as an unknown OCPP configuration key. Cloud Resume
restored the original setting. These were supervised command-path tests; they
did not themselves qualify the complete application under a cloud network
outage, an application restart or a physical unplug/replug during that outage.

A bounded live experiment verified a private virtual-tag start, physical
charging, a transaction-scoped zero-current pause, and resumed charging after
the pause expired with the test controller suspended. That original experiment
did not establish positive-current limiting, which is outside the current
implementation. These observations do not
establish behavior for every firmware, vehicle, phase arrangement or paired
hardware takeover. A separate user-assisted test suspended the server for about
four minutes: after unplug/replug, Easee app Start waited for approval and did
not charge while OCPP still owned authorization. Resuming the server allowed a
remote-start request to be accepted again.

While ST-MQ was connected, the owner also used Easee app Pause and Resume;
native status changed between `Charging` and `SuspendedEVSE`. App controls are
therefore not assumed to be universally blocked in native mode. The separate
offline experiment establishes a fresh-session authorization failure, not the
behavior of every app action. ST-MQ does not automatically restart an existing
session merely because it reports `SuspendedEVSE`.

The owner declined a separate Equalizer load test. The app reported Equalizer
available, so continued local balancing is assumed for this installation; that
availability report does not verify behavior under competing household loads.

Additional bounded application checks confirmed normal-current charging,
vehicle identification and native pause readback. They did not validate an exact
0.15 kWh physical cutoff or positive-current limiting. The current software can
recover an observed transaction from distinct fresh meter reports, but hardware
acceptance of a pause profile for a recovered transaction identifier remains
unverified. Recovery does not invent a missing StartTransaction event, meter
baseline or authorization history.

These results cover particular installed equipment and supervised conditions.
They do not verify paired-hardware takeover, all firmware/vehicle combinations,
radio or network fault behavior, or future economic pauses while the application
is unavailable. Earlier experiments that disabled OCPP during shutdown do not
describe current behavior: ordinary stop, restart and handover preserve OCPP.
Only explicit native-control deactivation or connection reconfiguration owns
cloud handback.

### Endpoint and pairing

In standalone operation, omit `easee.local_ocpp.server_url` or leave it empty
to detect the computer's LAN IPv4 address. ST-MQ builds
`ws://<detected address>:<local_ocpp.port>/ocpp`; the default listener port is
9001. For example, a detected documentation address of `192.0.2.10` produces
`ws://192.0.2.10:9001/ocpp`. The charger appends its charge-point identity.

Detection uses the computer's local interfaces and IPv4 default routes without
contacting the charger or an external service. It prefers the usable LAN default
route with the lowest metric and excludes loopback and link-local addresses and
known VPN and container interfaces. A specific usable local IPv4 address in
`local_ocpp.host` takes precedence over route selection. When routing information
is unavailable, detection accepts a single usable LAN IPv4 candidate. If the
route table is available but has no suitable default route, or selection is
ambiguous, setup stays pending and asks for `server_url`. A detected address is a
candidate for the connection; it does not establish that the charger can reach it.

Set `easee.local_ocpp.server_url` explicitly when detection chooses an unsuitable
address, or when using a proxy. An explicit standalone value takes precedence
over detection and must be a base WebSocket address reachable from the charger.
Detection sees the process's network interfaces; a container without host
networking may need the host address and forwarded port supplied explicitly.
Include the listener or proxy port: `ws://` without a port uses port 80. For
standalone `wss`, configure a TLS proxy plus `ca_certificate` and
`ca_certificate_domain`; the native listener accepts ordinary WebSocket traffic.
Detection runs at provider startup and after **Apply reviewed configuration**, rather than
changing the charger endpoint on each setup retry. After a network change,
restart or use **Apply reviewed configuration** to detect again. A DHCP reservation helps
keep the selected address stable.

For paired operation, ST-MQ derives the base address from the configured pairing
virtual IP and local OCPP port, so the charger reconnects to the same address
after handover. A paired `server_url` must be empty or exactly that shared
`ws://` address; a node-specific address or separate TLS proxy cannot replace it.
Both computers need a working listener and matching charger configuration.
Pairing copies the compact setup ownership and transaction state with the
database. Passwords remain outside history; each computer’s cloud credentials
and network configuration remain local. See [paired operation](../../pairing.md) for
readiness checks and handover limits.
An outstanding OCPP restoration obligation still requires compatible peer
settings and listener readiness even when local OCPP is configured as disabled.

Open **Data & settings → Connections & configuration → Charging** and expand
**Charger 1 · Connection & capabilities** to inspect **Local OCPP connection**. **Charger setup** reports missing prerequisites, cloud setup
progress or retry, native control readiness and an existing cloud schedule
waiting to hand over; **Local readings** separately reports the socket and fresh
measurement readiness. Working cloud readings retain their own availability.
Temporary listener readiness warnings clear when the listener recovers, without
waiting for the next cloud check or reapplying charger configuration. Outstanding
cloud failures and retry deadlines remain in effect. Storage and authorization
readiness failures are reported separately from listener network failures.
Correct missing configuration and use **Apply reviewed configuration** to reconnect.
The live setup status shows the effective base server URL and whether it was
detected, explicitly configured or derived from the pairing virtual IP. It hides
authentication secrets, authorization tags and the appended charge-point identity.
The displayed endpoint comes from the current runtime; its URL is excluded from
persisted setup status and provider history.

An existing connection owned by another OCPP server is preserved. **Set up local
connection** appears only when ST-MQ has inspected that configuration and this
computer has authority to change it. The confirmation explains that the existing
OCPP server connection will be replaced and that native OCPP takes over charging
authorization and schedules. The server rereads the inspected revision before replacement. A newer
external edit requires another review and confirmation; it does not grant
permission for recurring automatic overwrites.
Ordinary shutdown and unrelated configuration reloads preserve the installed
connection. An explicit change to the charger identity or local OCPP settings
first releases the old integration through its existing connection. Setup keeps
the exact inactive connection it applied, allowing its own settings to be
updated without another adoption; changed remote settings still require review.
A newly detected endpoint can update the installation's owned configuration.

To turn off a local connection managed by this installation, set
`easee.local_ocpp.enabled` to `false` and use **Apply reviewed configuration**. ST-MQ checks
that the charger still has its owned configuration, stores `OcppOff` while
preserving the existing address, authentication and certificate settings, then
applies that version. A failed cloud operation remains pending and retries;
changing the setting alone does not confirm charger-side shutdown. A different
server's connection is preserved and cannot be adopted while local OCPP is
disabled. After local OCPP is disabled, verify that the charger has resumed its
intended cloud control before relying on scheduled charging.
In the bounded live test, follow-up about one minute after applying `OcppOff`
reported no active cloud schedule and external authorization disabled. This
control readback does not establish immediate physical handback or a charging start.

Easee's [commissioning guide](https://developer.easee.com/docs/ocpp-commissioning-easee-users)
describes the prerequisites and Save/Apply protocol that ST-MQ performs. The
[GET connection reference](https://developer.easee.com/reference/getuserchargerconnectiondetailsendpoint)
contains the current versioned response example: `version`, `connectivityMode`,
`websocketConnectionArgs` and `basicAuth` containing username/password. Its example
matches the `ConnectionDetailsDto` used by the operator API, while its schema
reference incorrectly points to the version-only POST response. The POST request
uses `chargePointId` and `basicAuthPassword`; these request names are not accepted
as alternative GET response fields. The live API accepts a store request with
HTTP 201 and returns the version to apply. Its GET URL includes the appended
charge-point identity, while POST uses the base URL; ST-MQ verifies and separates
that exact identity rather than appending it twice. Unknown response shapes stop
setup safely.

On boot ST-MQ requests periodic and clock-aligned measurements, including power,
current and voltage. Both the socket and the measured fields must remain current;
heartbeats do not renew an old power/current sample. Missing or unsupported phases
stay missing, and a local/cloud transition breaks energy integration rather than
joining unrelated sample heads. Native Easee measurements marked `Inlet` are
accepted alongside `Outlet` for charger connector 1; they remain charger readings,
not property or Equalizer measurements. Reconnection, malformed values, units, timestamps,
authority revocation and authentication are exercised with a synthetic charger.
These synthetic checks complement the bounded native-control experiment above;
they do not establish all installed charger or paired-hardware behavior.

References checked for this implementation: Easee's
[native OCPP overview](https://developer.easee.com/docs/ocpp-intro),
[user commissioning](https://developer.easee.com/docs/ocpp-commissioning-easee-users),
and [firmware 344 configuration keys](https://developer.easee.com/docs/supported-config-keys).

Transaction acknowledgements are committed to the current SQLite state before
authorization is returned. The compact current ledger uses strict version 4,
binds to the configured charger and charge-point identity, stores hashes instead
of plaintext tags, and keeps up to 128 transaction records plus a start-time
watermark. Retries after a socket
reconnect, message-cache eviction or process restart receive the original
transaction ID. Conflicting starts/stops, unknown stops and starts older than the
retained watermark are rejected. A changed charger association or malformed
ledger blocks the endpoint before mutation. Earlier development ledgers are not
migrated or decoded as version 4; inspect the installation and use a deliberate
fresh setup rather than allowing another charger to inherit it.
Storage failure blocks new Authorize and StartTransaction replies. This compact
ledger is protocol identity state, not a duplicate session-energy series. A reset
meter counter can still end its known transaction; the raw nonnegative start and
stop values are retained without treating their difference as energy.

Socket frames and transaction changes wait asynchronously for the shared database
writer in bounded receipt order. Replies that grant authorization leave only
after COMMIT; rollback closes the affected connection without accepting the
transaction. Queued frames retain their original receipt clocks and authenticated
socket, so waiting cannot renew stale permission or transfer a message to a new
connection. Native command guards run after admission. Setup also awaits its
durable intent, then rechecks authority and remote configuration before any
charger-side mutation.

Some existing transactions reconnect without a `StartTransaction` exchange.
The ledger can retain these separately as observed transactions after two
distinct, advancing, fresh power `MeterValues` reports, at least one second apart,
name the same positive transaction ID on the current authenticated connection.
An active connector status is also required. Conflicting IDs, already ended
transactions, stale/out-of-order readings and socket or boot boundaries cannot
create this authority. Reconnection requires fresh confirmation again. The
snapshot identifies `meter-values` provenance and confirmation time while
leaving the original start time and authorization empty. These observations
authorize targeting the confirmed current transaction with a restriction; they
do not fabricate a start acknowledgement, tag, meter baseline or charging
history. Recovery and guarded profile installation are covered by synthetic
protocol and production-adapter tests; acceptance by the installed charger still
needs a separately authorized hardware check.

Power samples from aligned and periodic reporting can disagree at one source
timestamp. That power value remains unknown, and the conflicting observation
cannot confirm a transaction. Later advancing, clean reports for the same
transaction restore confirmation without a transport reconnect; neither a replay
at the conflicting timestamp nor unrelated fields from that timestamp do so.
This measurement conflict is separate from reports naming different current
transaction IDs, which retain the connection-scoped identity fence. Original
measurement and receipt clocks remain unchanged.

Each transaction retains its latest transaction-specific evidence time. A fresh,
explicitly timestamped `Available` or `Finishing` status from the
current authenticated connector can establish that no transaction is ongoing,
provided it is strictly newer than that evidence. Up to one second of future
source-clock skew waits until the timestamp is current; a known newer buffered
transaction reading prevents an older status from clearing the active slot.
ST-MQ records this separately as `endedByStatus` with source and receipt times.
The old transaction row remains unresolved: no `StopTransaction`, stop timestamp
or `meterStop` is fabricated, and no session energy is inferred. A later real stop
can complete that row without ending a newer active transaction. A cloud apply
acknowledgement or socket closure alone never ends a transaction.
`Preparing` never establishes an end: the tested Easee firmware reported it one
second after an accepted `StartTransaction` while that transaction was active.
`SuspendedEVSE` likewise does not end a transaction or authorize a restart.

Before applying an owned `OcppOff` request, ST-MQ durably records a
`modeDisableIntent` on the active row with the request time and authenticated
connection identity. This records intent, not physical completion. Following a
later authenticated connection, fresh explicit `Preparing` newer than the request,
with no current transaction-bearing meter evidence, can permit one recovery
remote start in plug-and-charge mode. The attempt is saved before it is sent;
the current controller start permission is still required. Retries and restarts
do not replenish it. Ordinary application restarts never request this mode
change. A new boot message on the same socket
or ordinary paired handover does not create this recovery permission.

The old row stays active until a distinct, authorized `StartTransaction` on that
later connection is newer than both its last transaction evidence and the disable
request. Only then is it superseded with separate `endedByNewStart` provenance.
Its missing stop timestamp and meter counter remain missing. A later real stop
updates only the old row, even if its reported time follows the new start.

The local OCPP status includes pending configuration keys and rejected/unsupported
configuration replies. Check these during commissioning, especially
`MeterValuesSampledData`, `MeterValuesAlignedData`, `MeterValueSampleInterval` and
`ClockAlignedDataInterval`. A configuration request alone does not prove that the
charger supplied the needed measurements.

## Physical connection and source-clock admission

A live local OCPP connection status newer than the last disconnect restores
Charger 1's physical session and readings even while its transaction is
unconfirmed. It also resolves the previous disconnect's waiting flag, including
after restart of an already observed connection. A separately authorized bounded
identification probe or session Charge now can then permit transaction startup;
reconnection alone does not authorize charging before the economic start.
Native Stop, schedules, faults and authorization restrictions still apply.
Native profile writes still wait for transaction evidence newer than that
disconnect. An existing transaction can be recovered from two distinct,
fresh, advancing transaction-bearing meter reports on the authenticated local
connection, with an active connector status. Its original start time and
authorization remain unknown. Transaction confirmation does not restart the
physical session or reset its settings, deadline, progress or cost.

An admitted OCPP status up to one second ahead of the local clock remains
unavailable until its original source time. Reads and command acknowledgements
may wait once for that time before checking the original connection, transaction
and instruction guards again. The wait cannot renew a request deadline, resend
a command or borrow evidence from a replacement connection. A further future
status, timeout, abort or genuine instruction change still fails closed.
