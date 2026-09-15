# Charger 1 native Easee control

ST-MQ installs one native delayed start and leaves charging enabled afterward.
The readiness estimate and deadline never become an automatic stop command.
The native delay can be installed before the vehicle arrives. Replanning uses
the freshly read connection state before any write. A new connection starts a
new readiness episode; an overdue, unoccupied preview can prepare the next day.
An overdue plan while the vehicle stays connected retains its concrete deadline.
The existing Easee authentication, token persistence, rate budget and controller
authority checks also protect these requests. The HTTP transport separately
opts in to narrowly validated scheduling writes.

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
  autumn clock times are rejected visibly instead of being misrepresented.
- [Disable delayed schedule](https://developer.easee.com/reference/postchargersschedulesdelayeddisable),
  [disable daily schedule](https://developer.easee.com/reference/postchargersschedulesdailydisable),
  [disable weekly schedule](https://developer.easee.com/reference/postchargersschedulesweeklydisable):
  `POST .../schedules/{kind}/disable` has no request body. Disabling the effective
  schedule preserves its stored definition. The adapter does not use legacy
  basic-charge-plan endpoints, stop/start/authorization commands or current blocks.
- [Schedule behavior](https://support.easee.com/hc/en-gb/articles/4413246412561-Schedule-Smart-Charge):
  Easee documents one active schedule type and a one-off delayed start that
  continues charging until the vehicle is finished.

An app schedule change observed after plug-in gives the current/next occurrence
of a single daily or weekly window temporary priority while ST-MQ is enabled. Its absolute end is persisted; a restart or poll
does not turn yesterday's end into tomorrow's. Changes replace that occurrence.
Disconnect clears the session override; the schedule already present on the next
plug-in becomes its baseline. Ambiguous
daylight-saving window endpoints require explicit resumption.
Multiple periods and tariff/off-peak instructions changed after plug-in require
explicit resumption; they are not guessed into a bounded handback window. A
pre-existing schedule can be replaced when installing an ST-MQ delayed start.
Releasing a complex tariff/off-peak restriction is unsupported by this adapter
and asks for release in Easee rather than inventing a command. A user who
wants ongoing app scheduling turns ST-MQ charging control off.

## Ownership and manual controls

Before each mutation the adapter rereads the schedule and control observations,
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

The connected-session baseline is persisted and refreshed even while ST-MQ is
OFF. Enabling ST-MQ takes scheduling precedence over an instruction already
present at plug-in. Schedule and start/stop/on-off changes observed afterward
have priority. OFF/ON and process restart preserve that evidence; a genuine
disconnect resets it. Inactive schedule caches, normal delayed expiry and
ST-MQ's own confirmed/recovered writes are not app actions.

[Override Charging Schedule](https://developer.easee.com/reference/charger_overrideschedule)
is a documented current-session release, but the public schedule response has
no dedicated manual-override flag. ST-MQ observes
[mode, enabled state and no-current reason](https://developer.easee.com/docs/enumerations)
alongside schedules. Early charging preserves the start-only release without
claiming it proves an app action. Zero power, Equalizer pauses and normal
operating-mode transitions do not create manual priority or reset release.
A pre-existing disabled charger, authorization request or fault is unavailable,
not an inferred post-plug manual action. ST-MQ sends no enable, authorization,
start/stop or current commands.

Polling detects observed state changes, not app taps that leave the same state
or changes completed between observations. An app action made before ST-MQ has
first observed that connected session cannot reliably be distinguished from an
existing instruction. Transport/readback failures retain durable intent and
show operation-specific status; they do not invent a manual action. A pre-write
state race gets one fresh-read retry before reporting an unavailable check.

The REST API does not document conditional writes or a server-side compare and
swap. Rereading narrows the race with concurrent app edits, but an app write
between the final read and POST cannot be excluded. Readback detects mismatches
and yields. App visibility, device acknowledgement latency, and Charge now while
Equalizer-limited still need to be observed on the installed charger. No live
commands or hardware verification were performed for this implementation.

## Forecast limits

The adapter projects documented [charger observations](https://developer.easee.com/docs/charger-observation-ids):
circuit maxima 22–24, charger maximum 47, cable rating 104, dynamic charger and
circuit caps 48/111–113, and instantaneous Equalizer availability 230–232. Original
timestamps remain available. It reads the Equalizer
[configuration](https://developer.easee.com/reference/equalizer_geequalizerconfig)
at most hourly to obtain `maxAllocatedCurrent`, an overall charging allocation.
That allocation caps only the Equalizer-controlled charger. There is no
main-fuse prerequisite or UI limit/reserve. Equalizer remains responsible for
actual load balancing; no installer limits are changed.

Three-phase charging is assumed, independent of active output-phase observation.
The adapter also reads [Equalizer observations](https://developer.easee.com/docs/equalizer-observations)
31–33 for property currents and 34–36 for phase-to-neutral voltage. Charger
observations 183–185 provide its phase currents. Recent property samples permit
replacement of present household demand with historical/zero forecast demand;
otherwise planning uses live net Equalizer allowance. Charger-current events may
be old because unchanged values need not be republished. All original clocks
are retained separately from the successful read time. Missing voltage never
becomes an invented 230 V value. Missing or conflicting property/current data
cannot inflate recovered headroom.

`test/charging-easee-control.test.js` covers the documented wire format,
normalization, delayed release, replanning, restarts, in-flight OFF races,
manual windows and edits, Charge now, stops, uncertain handovers, and the
transport's restricted write allowlist. Fixtures use invented device names and
synthetic tokens; these checks require no Easee account or hardware.
