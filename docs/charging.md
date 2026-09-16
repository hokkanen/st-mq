# Charging

Both chargers use the same model, planner and dashboard card. Charger 1 uses
Easee's native delayed-start schedules; Charger 2 observes TeslaMate and currently
has no command adapter. Its scheduling controls are visible but disabled.
Heating mode and charging permission are independent.

## Dashboard and saved preferences

The two charger cards directly below **Garage**'s heating summary show
connection and, while connected, charge → target, ready-by and the next
proposed/confirmed action. Remaining grid energy is secondary. During charging
or a planned pause, the event shows power, the next pause or resumption, or the
estimated time to the stated target. Readiness and completion use the same
current forecast of the periods actually being executed.
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
| Requested target | 80% | 80% |
| Ready by | 06:00 | 06:00, scheduling disabled |
| Manual usable-capacity fallback | 74 kWh | 57 kWh |
| Starting charge | 20% | 20% |

Ready-by is an ST-MQ preference, using the same timezone as the rest of ST-MQ
(`TIME_ZONE`, currently Europe/Helsinki). The chosen time is the deadline;
there is no additional readiness margin.

Valid automatic capacity, SoC and vehicle charge target each take precedence
over their saved manual fallback. Automatic SoC has no temporary manual override.
The fallback number remains saved while automatic readings are in use and is
shown again if they become unavailable. The card identifies the charge source;
the requested target is a preference, not an uncertain measurement.
Neither current provider supplies usable capacity; it is never guessed from
range or charging-session energy. See the [provider matrix](charging-provider-capabilities.md).

Grid energy includes charging losses:
`capacity × max(0, minimum − SoC) / 100 / efficiency`.
Energy and cost estimates cover reaching this minimum. If the vehicle target is
unavailable, a manual 80% minimum can coexist with the vehicle continuing toward
100%. The final charging period has no automatic end; charging may continue past
the minimum and deadline.

Connection, current, voltage and native schedules are automatic only. The
configured TeslaMate feed belongs to Charger 2; its values do not depend on
identification probes or simultaneous charging observations. Home location
gates household connection and load accounting. The explicit legacy
`charger_assignment: "easee"` option still attaches TeslaMate's vehicle values to
Charger 1 and avoids recording that charging again as Charger 2. With the charger
model enabled, legacy `auto` configuration uses Charger 2 without active probes.

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

The **TeslaMate** connection entry reports MQTT subscription and actual reception
separately from charging or energy-recorder health. A sleeping or idle vehicle
does not imply MQTT disconnection. Live and retained packets are distinguished;
repeated unchanged values can confirm reception without refreshing a vehicle
measurement's displayed age.

## Charge progress

The displayed estimate uses the same recorded grid-energy intervals as the
history charts, including the recorder's durable pending interval. It does not
run a second power integrator or treat a command as delivered energy:

`estimated SoC = starting SoC + delivered grid kWh × efficiency / capacity × 100`.

The vehicle's raw percentage and original timestamp stay unchanged. A genuinely
new charge reading rebases the estimate, counting only energy after that
reference and within the current connection. Unchanged receipt-only messages and
retained replays do not erase progress. Capacity, target and efficiency edits
recalculate the estimate without discarding already delivered energy.

The estimate is marked **≈** and identifies whether it started from vehicle
telemetry or the saved starting charge. Missing energy intervals receive no
invented credit; incomplete coverage is visible. Progress survives a restart and
planned pauses. Confirmed disconnection resets connection progress, without
pretending the remembered starting charge measures the vehicle after driving.
The estimate can rise beyond the requested target, up to 100%, while the final
period continues naturally.

## Planning and Equalizer

ST-MQ assumes **three-phase charging** for both chargers, including while
unplugged. Easee current limits do not depend on an active output-phase reading.
Voltage comes from Equalizer/property readings or vehicle telemetry. Both
chargers share the property supply, so an available provider voltage can serve
either charger; no nominal-voltage fallback is invented.

The dashboard lists measured draw, Equalizer's last reported per-phase allowance,
then the charger ceiling. A 16 A ceiling does not
mean 16 A is available now. Dynamic or schedule-related zero current is not
mislabeled as Equalizer allowance or projected across the whole night.

The planner reconstructs an effective supply budget from coherent Equalizer
allowance, property current and Charger 1 draw, then replaces present demand with
forecast household demand and scheduled competing charging. Recent evidence is
retained through sparse change-only reports, so an evening load does not freeze
its reduced allowance across the night. Allocation-capped observations establish
only a lower bound; the estimate is not a physical fuse rating. If usable budget
evidence is unavailable, the planner uses the live net allowance without
subtracting household demand twice. Equalizer's configured allocation caps its
own charger, not a separate Tesla charger.
Equalizer continues to manage actual current and protect the installation.
There are no manual fuse/allocation fields or planning reserves.

Only evidence of a scheduled Charger 2 event reserves future competing load.
Its automatic charge and target determine remaining energy and expected duration;
an estimated completion is not an enforced stop. An unknown connection or missing
unscheduled Charger 2 reading cannot block Charger 1. Missing electrical
information for a scheduled peer produces an unavailable-estimate note. Actual
consumption is already present in property readings.

### Household history

The reference uses original imported 0.7.5 Easee phase currents, with Charger 1
removed from property current, and the original st-mq outdoor temperatures.
Adjacent current reports support a bounded estimate across gaps of at most
30 minutes. Modern recorded electricity intervals contribute the same kind of
per-phase household reference. Known Charger 2 energy is removed where it
overlaps. Missing older Charger 2 records do not discard an otherwise useful
night: unmeasured charging remains in household demand and its uncertainty is
reported. Invalid or conflicting records cannot become invented zero load.

Each forecast hour selects up to 20 independent nights, matching local time and
outdoor temperature, with the preceding six-hour temperature where available.
Usable coverage is weighted by duration, not poll count; even one or two nights
begin an explicitly limited estimate. Recent examples of similar conditions
gradually replace older ones. Mild calendar decay retains a floor, and storage
keeps separate local-hour/5 °C groups, so summer does not erase the only winter
reference. Poor matches fall back to broader observed history; zero household
load is used only when no usable reference exists.

Short household load patterns remain separate. The planner applies per-phase
limits and the 6 A charging minimum to each pattern before averaging available
power. This captures heating cycles that an hourly average alone would miss.
The card's **How charging works** shows reference count, temperature range and
limited or older-reference context.

The compact index is versioned as `charging-household-v1-comparable-nights` and
rebuildable from original imports and observations. Native intervals replace
overlapping imported references. Source records and thermal-learning journals
are unchanged; this is a separate household-power forecast.

Archive preparation runs in a read-only background worker. Initial preparation
is shown explicitly. An existing confirmed schedule remains in effect; otherwise
charging is allowed provisionally. An unfinished or failed read is not evidence
of zero household consumption. Subsequent refreshes
retain the usable reference while new history is prepared. Preparation failures
remain visible and retry automatically.

### Period selection and execution

The planner compares continuous charging with cheaper split periods across actual
price intervals. Earlier ready-by times and remaining energy guide joint planning.
Pauses and intermediate periods are at least 15 minutes. Joining a short gap
changes the real energy allocation: surplus energy is trimmed from expensive
edges and the candidate is simulated again. Each additional period must justify
a 1 cent cost preference for simplicity; otherwise fewer periods win. A feasible
continuous candidate remains available. The final period is always open-ended.
Once that final release is reached, the connected session is not
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

An active confirmed period keeps its planned end. Future periods can be revised
using delivered energy, prices, household forecast and peer schedules. The
current readiness forecast evaluates retained execution periods, so a new
proposal does not claim a finish that the installed instruction cannot deliver.
A failed update retains the last confirmed periods with its explanation.

When inputs are missing or time is insufficient, immediate charging is a
temporary allowance and planning continues. Improved readings can still produce
economical later periods. This is distinct from the unrestricted final release,
which is never delayed again during the same connection. A confirmed disconnect
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
