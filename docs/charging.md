# Charging

Charger 1 uses Easee Cloud's native delayed-start schedule. Charger 2 is a
read-only load forecast from the existing TeslaMate connection. Heating mode
does not enable charging control: **ST-MQ charging control** has its own switch,
initially OFF, in **Garage → Equipment & temperatures → Charger 1**.

## Preferences and first use

All charging preferences are editable in Garage and saved in the application
database. They survive restarts and configuration reloads; they are not private
configuration-file entries. A new installation shows:

| Preference | Initial value |
| --- | --- |
| ST-MQ charging control | OFF |
| Charger 1 minimum charge | 80% |
| Charger 1 ready-by | 06:00, Europe/Helsinki |
| Charger 1 usable vehicle capacity | 74 kWh |
| Charger 2 usable vehicle capacity | 57 kWh |
| Manual Charger 1 current SoC entry | 40%, then the last entered value |

Check the vehicle capacities and installation assumptions in the expanded
settings. Capacity is battery energy in kWh; charging power is kW; electrical
limits and selected current are A. The standard session uses balanced three-phase
charging. ST-MQ never switches phases or changes installation protections.

The property main-fuse limit starts unset. Enter the actual installation value
before relying on delayed charging. Easee's charging allocation, circuit limits,
cable limit and instantaneous Equalizer availability describe different things;
instantaneous availability is not a household main-fuse rating. ST-MQ reads
supported Easee limits and uses the most restrictive available constraints with
the editable planning allowances. Equalizer continues real-time load balancing.

The controller uses existing Easee credentials and Charger 1 identity. Charger 2
uses the existing TeslaMate car/topic and home-geofence configuration and charger
assignment. An ambiguous automatic assignment reserves possible load rather than
claiming that a vehicle is on Charger 2. The existing charger-identification
perturbation does not run while automatic charging control is enabled.

## Current SoC

The default Charger 1 MQTT subscription is `stmq/garage/charger1/vehicle`, QoS 1.
The topic and expected identities are editable in Garage. A future publisher
should send retained JSON, for example:

```json
{
  "vehicleId": "charger1-vehicle",
  "sourceId": "vehicle-telemetry",
  "readingId": "example-reading-42",
  "soc": 63,
  "measuredAt": "2026-09-15T17:20:00+03:00",
  "sequence": 42
}
```

`measuredAt` is the original measurement time, either an ISO timestamp with an
offset or UTC milliseconds. Use `null` if the source clock is unknown; receipt
time is never substituted. `sequence` is optional, and can disambiguate readings
from the same source when measurement clocks are unknown. It must increase across
publisher restarts if used for ordering. `readingId` identifies a measurement,
not a transmission. The consumer rejects invalid percentages, wrong identities,
duplicate IDs and provably older readings. It independently saves the accepted
reading; disconnects and retained replay cannot renew its original timestamp.

An old valid reading remains usable and its measurement date stays visible.
Changing the topic or identity discards the prior automatic reading. Changing
vehicles also clears that vehicle's manual override. Broker persistence and
publisher cache/sleep behavior belong to the later hardware setup; this change
does not install firmware, configure a broker or query vehicle diagnostics.

The manual SoC action overrides MQTT until the **next concrete ready-by deadline**.
Its entry time and absolute expiration are saved. Changing ready-by later does
not extend it; reapply the entry to select a new expiration. MQTT continues to
update separately, and **Return to MQTT** takes effect immediately. Expiration
changes the planning reference without interrupting charging.

If neither source is available, the displayed measurement remains unknown and
the planner explicitly assumes 0%. It still chooses a cheap feasible future
start. Missing SoC alone is never an instruction to start immediately.

## Planning and manual priority

The minimum percentage is a readiness target, not a vehicle charging limit.
The planner simulates continuous charging after candidate starts, accounting for
actual price intervals, changing household demand, Charger 2 load, per-phase
headroom, minimum current, efficiency and readiness margin. It includes starts
before a cheap but heavily constrained overlap. Estimated minimum completion and
cost end the accounting only: charging remains enabled afterward.

Recorded electricity intervals are intersected before both chargers are removed
from property consumption. The history projection uses recent matching local
hours. Charger 2 historical energy has no phase breakdown, so the residual uses
an explicitly conservative phase allocation. Missing overlapping coverage uses
the editable non-charger load allowance; it does not silently mean zero load.
No temperature-learning algorithm or imported CSV interpretation is changed.

Charger 2 forecast uses requested current (for example 13 A), separately clamped
by its available maximum and installation constraints. Zero measured power while
waiting does not remove the forecast. Each TeslaMate field retains its own
receipt metadata; the topics do not supply a shared measurement timestamp. Old
scheduled starts are not rolled forward into invented schedules. Missing
connection, current, schedule, SoC or target information produces visible
conservative reservations. The forecast is not a command or guaranteed booking.

When insufficient time or other essential planning inputs make delay unreliable,
automatic control relinquishes its own delay and explains the fallback. OFF and
manual Easee instructions still take priority. Once released, charging is not
delayed again for that plugged-in session; a brief Equalizer pause does not reset
this rule. A concrete plan deadline never silently moves to tomorrow when overdue.

Easee schedules are read before replacement and confirmed afterward. A manual
app window temporarily yields control until its current/next concrete end, then
requires another read before hand-back. Ambiguous schedules and unbounded manual
stop/disable instructions remain yielded until explicit resumption. **Resume
automatic control** is separate from the manual SoC action. Turning OFF clears
only a positively identified ST-MQ restriction; failed handover stays visibly
unconfirmed. No estimated finish becomes a stop command.

## Protocol verification and remaining equipment checks

The adapter follows the current [Easee schedules API](https://developer.easee.com/reference/getchargersschedules)
and [TeslaMate MQTT contract](https://docs.teslamate.org/docs/integrations/mqtt).
Easee delayed start is a local clock time, not an absolute timestamp. ST-MQ keeps
the concrete deadline and validates representability before writing; ambiguous
daylight-saving times yield instead of installing a different start.

Automated tests use invented provider responses and simulated time. They do not
certify the installed charger's firmware, app visibility or the vehicle's actual
schedule reporting. Check native delayed-start visibility, manual Charge now,
stop and hand-back on the installed Easee before relying on unattended operation.
Charge now has no verified dedicated observation in the public contract; early
charging or changed restriction evidence makes ST-MQ yield conservatively. See
[Easee adapter notes](charging-easee.md) for the exact protocol boundary.

WiCAN configuration and hardware tests will be done when the device is available.

## API

Authenticated dashboard mutations use the same primary-controller authority gate
as the rest of ST-MQ. `/api/status` includes `charging`.

| POST endpoint | JSON body |
| --- | --- |
| `/api/charging/settings` | Partial validated preferences; nested `installation` patches are merged |
| `/api/charging/soc` | `{ "soc": 40 }` or `{ "action": "automatic" }` |
| `/api/charging/resume` | `{}` |

Mutations return the full application status. Unknown fields and invalid values
are rejected. No endpoint controls Charger 2.

Read-only replicas show the primary's saved preferences, SoC source, plan and
ownership at the original snapshot time. They do not replan, issue commands or
present missing live Charger 2/MQTT telemetry as a current measurement.
