# Charging

Both chargers use the same model, planner and dashboard card. Charger 1 uses
Easee's native delayed-start schedule; Charger 2 observes TeslaMate and currently
has no command adapter. Its scheduling controls are visible but disabled.
Heating mode and charging permission are independent.

## Dashboard and saved preferences

The first equipment cards in **Garage → Equipment & temperatures** show
connection, charge level, minimum and grid energy to the minimum. One event
summarizes the relevant state: a confirmed/proposed start, an app window, or
measured charging power and estimated progress. Times use short local labels.
An active manual instruction replaces the automatic-plan summary. Settings and
brief source/forecast notes live under **Settings & details**.

Preferences persist independently for each charger in the application database:

| First-use preference | Charger 1 | Charger 2 |
| --- | --- | --- |
| ST-MQ scheduling | OFF | Unavailable |
| Manual minimum fallback | 80% | 80% |
| Ready by | 06:00 | 06:00, scheduling disabled |
| Manual usable-capacity fallback | 74 kWh | 57 kWh |
| Manual SoC fallback | 40% | 40% |

Ready-by is an ST-MQ preference, using the same timezone as the rest of ST-MQ
(`TIME_ZONE`, currently Europe/Helsinki). The chosen time is the deadline;
there is no additional readiness margin.

Valid automatic capacity, SoC and vehicle charge target each take precedence
over their saved manual fallback. Automatic SoC has no temporary manual override.
The fallback number remains saved while automatic readings are in use and is
shown again if they become unavailable. Source labels identify fallback values.
Neither current provider supplies usable capacity; it is never guessed from
range or charging-session energy. See the [provider matrix](charging-provider-capabilities.md).

Grid energy includes charging losses:
`capacity × max(0, minimum − SoC) / 100 / efficiency`.
Reaching the minimum or deadline never sends a stop command.

Connection, current, voltage and native schedules are automatic only. A vehicle
away from Home is not assigned to a household charger. Existing explicit
TeslaMate charger assignment takes precedence over inferred attribution.
Uncertain attribution never attaches another vehicle's SoC or target. Active
identification probes are suppressed while ST-MQ scheduling or pending handover
needs the charger.

## Deployment configuration and vehicle MQTT

MQTT topics and charging efficiency are deployment configuration, outside the
charger settings UI. In the existing configuration file:

```json
{
  "charging": {
    "chargers": {
      "charger1": {
        "mqttTopic": "stmq/garage/charger1/vehicle",
        "efficiency": 0.9
      },
      "charger2": {
        "mqttTopic": null,
        "efficiency": 0.9
      }
    }
  }
}
```

These are also the defaults when omitted. Each configured topic must be distinct
and concrete, without MQTT wildcards. Set it to `null` to disable the extra feed.
Configuration reload recreates the acquisition/runtime; changing a topic
invalidates the stored automatic reading associated with the previous topic.
Saved UI preferences are independent of deployment configuration.

The dedicated topic identifies its charger; no vehicle/source identity fields
are required. A future publisher should send retained JSON at QoS 1:

```json
{
  "readingId": "example-reading-42",
  "soc": 63,
  "usableCapacityKwh": 74,
  "chargeLimitSoc": 80,
  "measuredAt": "2026-09-15T17:20:00+03:00",
  "sequence": 42
}
```

Capacity and charge limit are optional. `measuredAt` is the original measurement
clock: an offset ISO timestamp, UTC milliseconds, or `null` if unknown. Optional
`sequence` must increase across publisher restarts when used. `readingId`
identifies a measurement, not a transmission. Invalid values, duplicate IDs and
provably older readings are rejected; retained replay cannot refresh an original
timestamp. Sparse updates preserve optional fields with their original clocks.
Old valid MQTT readings remain usable with their source timestamps preserved.
TeslaMate scalar topics preserve receipt clocks separately because they carry no
measurement timestamps. WiCAN firmware and hardware setup remain for later.

## Planning and Equalizer

ST-MQ assumes **three-phase charging** for both chargers, including while
unplugged. Easee current limits do not depend on an active output-phase reading.
Voltage comes from Equalizer/property readings for Easee and vehicle telemetry
for TeslaMate; no nominal-voltage fallback is invented.

The planner uses native current limits and Equalizer's reported per-phase
charging allowance. With recent property currents and the charger's actual
currents, it replaces present non-charger demand with forecast household demand
and scheduled competing charging. This is an effective power estimate, not a
physical fuse rating. If those meter currents are unavailable it uses the live
net Equalizer allowance without subtracting household demand again. Equalizer's
configured allocation caps its own charger, not a separate Tesla charger.
Equalizer continues to manage actual current and protect the installation.
There are no manual fuse/allocation fields or planning reserves.

Household history uses intersected electricity intervals with recorded charger
consumption removed. Matching local hours inform each phase's forecast; without
usable history the forecast household load is zero. Only evidence of a scheduled
Charger 2 event reserves future competing load. An unknown connection or missing
unscheduled Charger 2 readings cannot block Charger 1. Current property
consumption is already reflected in live Equalizer readings. Missing electrical
information for a scheduled peer produces a short unavailable-estimate note,
not a global planning block.

ST-MQ searches continuous start-only scenarios across actual price intervals.
Earlier ready-by times and remaining energy guide joint planning. Charging is
not repeatedly paused to chase prices. Once released, the connected session is
not delayed again for a new SoC reading, zero-power pause or passed deadline.
An overdue connected deadline does not silently advance to tomorrow.

Future command adapters can declare scheduling and current-control capabilities.
The planner can propose simultaneous current allocations by remaining energy and
time. At most one charger uses an external limiter; it gets the remaining power
and never receives a current-limit proposal. These proposals need a future
executor; today's integrations issue only confirmed native Easee schedules.

## Manual priority

When enabled, ST-MQ takes over pre-existing schedules. A schedule change or
start/stop/on-off action **observed after the current plug-in** takes temporary
priority. The session baseline is observed even while ST-MQ is OFF, persists
across restart, and resets on disconnect. OFF/ON does not erase an observed
manual instruction. Native expiry, inactive saved schedules, Equalizer pauses
and ST-MQ's own writes do not count as app actions.

A simple daily/weekly manual window yields until its persisted absolute end,
then requires a fresh read before automatic handback. The UI shows this window
once. Recurrence is temporary for one occurrence while ST-MQ is enabled; turn
ST-MQ OFF for ongoing app control. Complex/unbounded instructions require
explicit resumption. An actual disabled or unauthorized charger must first be
enabled/authorized in Easee; ST-MQ does not issue those commands.

Turning OFF removes only a confirmed ST-MQ restriction. Failed communication
keeps handover visibly unconfirmed. The card distinguishes unavailable readings,
command acceptance and readback confirmation failures. See
[Easee adapter notes](charging-easee.md) for ownership and polling limits.

## Internal model and API

`charging.settings.chargers` contains durable UI preferences; `charging.timezone`
is read-only. `charging.chargers` is an array of common capability-driven objects
with values/source metadata, energy requirements, plan, forecast and control
state. Adding an adapter does not require another dashboard implementation.

Authenticated POST endpoints retain the primary-controller authority gate:

| Endpoint | Body |
| --- | --- |
| `/api/charging/settings` | Partial `{ "chargers": { ... } }` patch |
| `/api/charging/chargers/:id/settings` | Partial `enabled`, `readyBy`, `capacityKwh`, `minimumSoc`, `manualSoc` preferences |
| `/api/charging/chargers/:id/resume` | `{}` |

Unknown IDs/fields and invalid values are rejected. Unsupported scheduling is
both disabled in the UI and rejected by the server. Read-only replicas render
the saved primary state at its publication time, without replanning or commands.
