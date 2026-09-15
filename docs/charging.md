# Charging

Both chargers use the same model, planner and dashboard card. Charger 1 uses
Easee's native delayed-start schedules; Charger 2 observes TeslaMate and currently
has no command adapter. Its scheduling controls are visible but disabled.
Heating mode and charging permission are independent.

## Dashboard and saved preferences

The first equipment cards in **Garage → Equipment & temperatures** show
connection and, while connected, current/target charge, grid energy to the
minimum, the next proposed/confirmed start and ready-by time. During charging or
a planned pause, the event changes to the current period or next resumption.
Times use short local labels; automatic SoC keeps its original measurement date
and time visible, or an explicitly labeled receipt time when that is all the
provider supplies. Disconnected cards hide vehicle percentages and energy.
An active manual instruction replaces the automatic-plan summary. Settings,
period details and source notes live under **Settings & details**; the nested
**How charging works** explains the remaining assumptions and control rules.

Preferences persist independently for each charger in the application database:

| First-use preference | Charger 1 | Charger 2 |
| --- | --- | --- |
| Automatic charging | OFF | Unavailable |
| Manual minimum fallback | 80% | 80% |
| Ready by | 06:00 | 06:00, scheduling disabled |
| Manual usable-capacity fallback | 74 kWh | 57 kWh |
| Manual SoC fallback | 20% | 20% |

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
Energy and cost estimates cover reaching this minimum. If the vehicle target is
unavailable, a manual 80% minimum can coexist with the vehicle continuing toward
100%. The final charging period has no automatic end; charging may continue past
the minimum and deadline.

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

The dashboard separates the configured charger ceiling, Equalizer's actual
reported per-phase allowance, and measured current/power. A 16 A ceiling does not
mean 16 A is available now. Dynamic or schedule-related zero current is not
mislabeled as Equalizer allowance or projected across the whole night.

The planner uses the charger ceiling and Equalizer's reported allowance. With recent property currents and the charger's actual
currents, it replaces present non-charger demand with forecast household demand
and scheduled competing charging. This is an effective power estimate, not a
physical fuse rating. If those meter currents are unavailable it uses the live
net Equalizer allowance without subtracting household demand again. Equalizer's
configured allocation caps its own charger, not a separate Tesla charger.
Equalizer continues to manage actual current and protect the installation.
There are no manual fuse/allocation fields or planning reserves.

Household history uses intersected electricity intervals with recorded charger
consumption removed. The duration-weighted mean of matching local
hours over the last seven days informs each phase's forecast; without usable
history the forecast household load is zero. Only evidence of a scheduled
Charger 2 event reserves future competing load. An unknown connection or missing
unscheduled Charger 2 readings cannot block Charger 1. Current property
consumption is already reflected in live Equalizer readings. Missing electrical
information for a scheduled peer produces a short unavailable-estimate note,
not a global planning block.

The planner compares continuous charging with cheaper split periods across actual
price intervals. Earlier ready-by times and remaining energy guide joint planning.
It uses multiple periods only when they improve the feasible energy-to-minimum
cost; equally priced choices prefer fewer periods. The final period is always
open-ended. Once that final release is reached, the connected session is not
automatically delayed again. An overdue connected deadline does not silently
advance to tomorrow; an expiring manual readiness cycle is a separate handback.

Confirmed Easee delays are installed one at a time. At an intermediate period's
end, the next native delay requests a pause until its next start. **These period
transitions need the application and Easee connection online.** An installed
one-off start still works independently; if a later pause is missed, charging may
continue and cost more. An entire pause that passed without confirmation is
reported after reconnection, without assuming that unobserved charging definitely
continued. The notice survives restart for that connection. No final stop is
preinstalled. The full proposed periods
are shown here; the Easee app shows the currently installed instruction.

Fresh, attributable measured-power intervals reduce the remaining grid-energy
estimate between SoC updates. They do not change the displayed SoC or its clocks.
Duplicate measurements, uncertain connections and gaps longer than two minutes
earn no estimated energy; accumulated credit survives restart but integration
does not bridge the outage. A new SoC/capacity/target reference resets this credit.
Active periods finish as planned; future periods can be revised at a gap using
updated remaining energy. A confirmed disconnect resets vehicle progress and
relinquishes an owned future delay; new planning waits for connection.

Future command adapters can declare scheduling and current-control capabilities.
The planner can propose simultaneous current allocations by remaining energy and
time. At most one charger uses an external limiter; it gets the remaining power
and never receives a current-limit proposal. These proposals need a future
executor; today's integrations issue only confirmed native Easee schedules.

## Manual priority

Enabling **Automatic charging** takes scheduling control unless an observed
manual change has priority. The first observation establishes a baseline; a
pre-existing schedule alone is not a newly observed action. Later schedule
changes are observed even while disconnected or automatic charging is off.
Native expiry, inactive saved schedules, Equalizer pauses and the controller's
own writes do not count as manual actions.

Manual priority expires at the earlier of the manual window's final known end
and the next ready-by time recorded when the change was noticed. Multiple manual
periods keep their gaps under manual control. An unknown or ambiguous end uses
the ready-by boundary. Restart, unplugging, OFF/ON and later ready-by edits do
not extend or erase the recorded expiry. **Resume automatic charging** ends the
observed override early; a newer edit noticed during the confirmation read still
wins. The card shows the effective resumption time and why it was chosen.

Handback requires a fresh charger read. A failed connection shows pending
handover rather than claiming control resumed. At a ready-by boundary, subsequent
planning uses the next readiness cycle. An actual disabled or unauthorized
charger must first be enabled/authorized in Easee; no such command is issued
automatically. An observed immediate-charge instruction is respected until its recorded expiry
or explicit resumption. The final automatic release is not stopped by later
price changes.

Turning automatic charging off removes only its confirmed native restriction.
Problems identify the cause, the last confirmed instruction or uncertain command,
and the next retry/action. A rejected proposed update does not erase a previously
confirmed schedule. See [Easee adapter notes](charging-easee.md) for protocol,
pause confirmation and polling limitations.

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
