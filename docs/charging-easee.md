# Charger 1 native Easee control

The controller installs native one-off starts. For a split plan, it installs the
next delayed start at each intermediate period's end, pausing until that start.
No final stop is installed at the target or deadline. New prices may replace an
active period with a cheaper feasible plan as described below. These transitions
require a running application and working Easee
connection. A missed pause may cost more, but cannot leave an automatic final
stop waiting on the charger. The Easee app shows the current native instruction;
the dashboard shows the complete proposed periods and their confirmation state.

The planner avoids pauses and intermediate periods shorter than 15 minutes and
prefers fewer periods unless the extra period improves estimated cost by more
than 1 cent. Intermediate periods normally retain their confirmed end while
updated remaining energy and power forecasts can revise later periods. New or
revised remaining price intervals can also replace an active period, including
final release, while the target is unmet and the original ready-by time is still
ahead. The replacement must meet that deadline and save more than 1 cent on the
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
see [household history](charging.md#household-history). With no usable supply-budget
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
