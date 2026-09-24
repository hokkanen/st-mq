# Charger 1 native Easee control

The cloud scheduling path below applies when native OCPP is inactive. Activating
native OCPP transfers charging authorization and scheduling to the local server;
it cannot be treated as a telemetry-only change. See the local connection section
below for setup and activation requirements.

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
is off or no vehicle is connected. A foreign active schedule with unknown
ownership is preserved on first observation. A simple daily/weekly window lasts
through its **current or next concrete end**, even beyond ready-by. Multiple
periods and unknown/ambiguous ends require explicit resumption. Unplugging,
restarting, OFF/ON and editing ready-by do not erase or move a window end.
Own confirmed/recovered writes, inactive
schedule caches and normal one-off expiry are excluded from manual detection.

The resume action acknowledges the currently observed manual fingerprint. A
newer edit discovered during its fresh read wins again. Expiry also requires a
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
Zero power, Equalizer pauses and ordinary operating-mode changes do
not create manual priority. A disabled charger, authorization request or fault
remains unavailable; no enable, authorization, start/stop or current command is
issued. Final release remains open even after its estimated completion/deadline.

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
see [household history](charging.md#planning-and-equalizer). With no usable supply-budget
evidence it uses live net allowance without subtracting demand twice. Missing
voltage never becomes an invented 230 V value; valid property voltage can serve
both household chargers.

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
backend at a time. It finishes and verifies release of its current cloud-owned
instruction before activating native OCPP. An active foreign cloud schedule
blocks that transition; ST-MQ preserves it. Missing native control readiness or
an unfinished handover stays visibly pending. Falling back to cloud readings
does not switch the charging controller back to cloud schedules.

**Stopping ST-MQ does not guarantee automatic cloud fallback.** A normal Ctrl+C
or service stop requests `OcppOff` through Easee cloud before closing charging
control. That request needs working cloud access; failures retain the restoration
obligation and report a shutdown error. Paired handover deliberately keeps OCPP
active so the charger reconnects to the shared address on the next controller.
Startup can re-enable the installation's matching, previously disabled setup.

A crash, forced termination, suspension or power loss cannot send that handback
after the process is gone. The charger can remain in native OCPP mode, and a new
charge or Easee app Start can wait for ST-MQ approval. Restart ST-MQ, or disable
Direct OCPP through Easee configuration to return authority to cloud control.
There is no seamless cloud-control backup. An existing pause expiring on the
charger only removes that restriction; it does not restore cloud authorization
for a new charging session.

The local receiver supports charger power, phase currents and explicitly
identified phase-neutral voltages. Property/Equalizer readings and finalized
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
  transaction and physical state must follow. This opt-in grants start
  permission; the separate Automatic charging switch governs economic pauses.

Without an explicit password, standalone ST-MQ creates a private
`easee-ocpp-credentials.json` file in its data directory; paired computers derive
the same purpose-specific password from their shared pairing token and charger
identity. Generated passwords have 20 characters. An explicit
`local_ocpp.password` must have 16–20 characters; the live setup API rejects
longer values. `local_ocpp.charge_point_id` is needed only for a custom identity.
Cloud credentials remain configured for setup, fallback readings and cloud
control while native OCPP is inactive.

### Native charging pauses

The native controller installs an absolute, transaction-scoped `TxProfile` with
only a **0 A restriction**. The profile identifies the current confirmed native
transaction and expires at the planned release time using both `validTo` and
schedule duration. ST-MQ verifies the effective zero-current interval with
`GetCompositeSchedule`; an accepted write alone is not confirmation of the
pause. Only its own profile ID is cleared for an earlier release. Cleanup still
requires the current authorized connection, but can remove that exact profile
when the old transaction is no longer confirmed. A missing profile ID is rejected;
ST-MQ never turns an incomplete cleanup instruction into a clear-all request.

At expiry, the restriction disappears on the charger without a new resume
command. Charging then follows the charger, vehicle and Equalizer's existing
limits. ST-MQ does not repeatedly command a positive current, invent a 6 A
release level or use a returned composite limit as the actual available current.
Intermediate pauses still require a running controller to install the next
restriction. A process or network outage can therefore miss a future pause and
increase cost, while an already installed restriction retains its own expiry.
This expiry does not authorize a new transaction or return the charger to cloud
control after an abrupt controller loss.

A bounded live experiment verified a private virtual-tag start, physical
charging, a transaction-scoped zero-current pause, and resumed charging after
the pause expired with the test controller suspended. Positive-current profile
behavior was not sufficiently clear to support rate-setting control; the
implementation uses only the verified zero-current restriction. This does not
establish behavior for every firmware, vehicle, phase arrangement or paired
hardware takeover. A separate user-assisted test suspended the server for about
four minutes: after unplug/replug, Easee app Start waited for approval and did
not charge while OCPP still owned authorization. Resuming the server allowed a
remote-start request to be accepted again. See the
[setup validation record](audit/OCPP-SETUP.md).

While ST-MQ was connected, the owner also used Easee app Pause and Resume;
native status changed between `Charging` and `SuspendedEVSE`. App controls are
therefore not assumed to be universally blocked in native mode. The separate
offline experiment establishes a fresh-session authorization failure, not the
behavior of every app action. ST-MQ does not automatically restart an existing
session merely because it reports `SuspendedEVSE`.

The owner declined a separate Equalizer load test. The app reported Equalizer
available, so continued local balancing is assumed for this installation; that
availability report does not verify behavior under competing household loads.

### Endpoint and pairing

In standalone operation, set `easee.local_ocpp.server_url` to a base WebSocket
address that the charger can reach on the installation network, for example
`ws://192.0.2.10:9001/ocpp` (an invented documentation address). ST-MQ cannot infer
that address from a listener bound to `0.0.0.0` or from a browser URL. The default listener port is
9001 and the base path is `/ocpp`; the charger appends its charge-point identity.
For standalone `wss`, configure a TLS proxy plus `ca_certificate` and
`ca_certificate_domain`; the native listener accepts ordinary WebSocket traffic.
For paired operation, ST-MQ derives the base address from the configured pairing
virtual IP and local OCPP port, so the charger reconnects to the same address
after handover. A paired `server_url` must be empty or exactly that shared
`ws://` address; a node-specific address or separate TLS proxy cannot replace it.
Both computers need a working listener and matching charger configuration.
Pairing copies the compact setup ownership and transaction state with the
database. Passwords remain outside history; each computer’s cloud credentials
and network configuration remain local. See [paired operation](pairing.md) for
readiness checks and handover limits.
An outstanding OCPP restoration obligation still requires compatible peer
settings and listener readiness even when local OCPP is configured as disabled.

Open **Data and settings → Electricity consumption** to see **Charger 1 local
connection**. **Charger setup** reports missing prerequisites, cloud setup
progress or retry, native control readiness and an existing cloud schedule
waiting to hand over; **Local readings** separately reports the socket and fresh
measurement readiness. Working cloud readings retain their own availability.
Correct missing configuration and use **Apply configuration** to reconnect.
Addresses, authentication secrets and authorization tags are not shown in this
public status.

An existing connection owned by another OCPP server is preserved. **Set up local
connection** appears only when ST-MQ has inspected that configuration and this
computer has authority to change it. The confirmation explains that the existing
OCPP server connection will be replaced and that native OCPP takes over charging
authorization and schedules. The server rereads the inspected revision before replacement. A newer
external edit requires another review and confirmation; it does not grant
permission for recurring automatic overwrites.

To turn off a local connection managed by this installation, set
`easee.local_ocpp.enabled` to `false` and use **Apply configuration**. ST-MQ checks
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
retries and restarts do not replenish it. A new boot message on the same socket
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
