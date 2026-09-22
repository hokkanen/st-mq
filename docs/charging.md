# Charging

Both chargers use the same model, planner and dashboard card. Charger 1 is a
generic Easee charging point for any vehicle and uses native delayed-start
schedules. Charger 2 represents Tesla charging and currently has no command
adapter. BMW CarData and TeslaMate are independent vehicle feeds; neither feed
name identifies a physical charger. Unsupported scheduling controls are hidden.
Heating mode and charging permission are independent.

## Dashboard and saved preferences

The two openable charger cards directly below **Garage**'s heating summary keep
their always-visible summaries at a fixed height within each responsive layout.
When the Garage section has at least 540 px of usable width, the cards sit side
by side. Narrower layouts stack Charger 1 above Charger 2. Desktop and paired
cards use a compact 292 px summary; narrow stacked mobile cards keep the 332 px
layout. Each card sizes its contents to its own width, and opening one card does
not stretch the other card or change either summary's height.
Connection and activity stay separate from whether charging is controlled,
observed or under manual priority. Connected summaries show charge → target,
the estimated target time, and the next start, pause or resumption alongside the
automatic ready-by deadline when applicable. Readiness and completion use the
same current forecast of the periods actually being executed.

The summary also shows grid energy added since the current charge reference,
remaining grid energy and estimated total connection cost through the target. Added energy is
not a whole-session total: a new vehicle charge reading rebases the reference.
Cost has a separate persistent connection reference: already delivered electricity
plus the estimated remaining requirement. It remains visible at the target,
continues to include extra charging, and survives new SoC readings and restarts.
Recorded intervals use their actual applicable prices; missing energy or forecast
coverage retains an explicitly estimated contribution until evidence improves.
A reserved notice area shows readiness, manual priority, unavailable readings
or control problems without changing the summary height. Disconnected and
unknown-connection summaries use explanatory states rather than presenting
remembered vehicle percentages or energy as current measurements.

Times use short local labels; charge source details preserve the original
measurement date and time, or an explicitly labeled receipt time when that is
all the provider supplies. Opening a card reveals the schedule, readings and
source notes, settings, and **How charging works**. Explanations follow each
charger's supported features: the observing charger explains its vehicle
schedule and estimates, while the controllable charger also explains automatic
planning, handover and manual priority. Electrical limits and Equalizer details
stay in the expanded area. Unsupported controls are hidden.

Preferences persist independently for each charger in the application database:

| First-use preference | Charger 1 | Charger 2 |
| --- | --- | --- |
| Automatic charging | OFF | Unavailable |
| Requested target | 80% | 80% |
| Ready by | 06:00 | 06:00 saved default, control hidden |
| Manual usable-capacity fallback | 74 kWh | 57 kWh |
| Starting charge | 20% | 20% |

Ready-by is an ST-MQ preference, using the same timezone as the rest of ST-MQ
(`TIME_ZONE`, currently Europe/Helsinki). The chosen time is the deadline;
there is no additional readiness margin.

Charger 1 uses editable manual starting charge, target and usable capacity until
the connected vehicle is identified. Receiving BMW battery values, or finding
that Tesla is charging elsewhere, does not identify the car on Easee. Once BMW
or Tesla is identified in this connection, its available automatic fields each
take precedence over the corresponding saved manual value; missing fields remain
editable. Automatic SoC has no temporary manual override. The generic defaults
remain saved separately and return for an unidentified visitor's car. Ready-by
is the first setting wherever it is shown. The card identifies the charge source;
the requested target is a preference, not an uncertain measurement. If BMW
repeatedly alternates X → 100% → X within fifteen minutes, its planning target
holds the latest value below 100% for that connection, with the raw report and
conflict visible on the card. **Plan for 100% this connection** provides an
explicit planning override; it does not set the car’s charge limit. The choice
and filter reset on unplug. See [target conflict handling](bmw-cardata.md#conflicting-charge-targets).
Vehicle MQTT can supply usable capacity; it is never guessed from range or
charging-session energy. See [BMW CarData through Home Assistant](bmw-cardata.md)
and the [provider matrix](charging-provider-capabilities.md).

Grid energy includes a fixed **7.5% charging loss**, so battery efficiency is
**92.5%** for both chargers:
`capacity × max(0, minimum − SoC) / 100 / 0.925`.
The same 7.5% supplies the garage charging-heat assumption. Metered grid energy
and its electricity cost stay unchanged; losses are applied only when converting
between grid energy and battery energy.
Read-only replicas preserve the primary's published readings, plans and energy
assumption. Their explanations identify a recorded snapshot's original loss;
viewing old records does not recalculate their costs or progress.
Remaining energy covers reaching this minimum; cost includes earlier charging
in the same connection as well. If the vehicle target is
unavailable, a manual 80% minimum can coexist with the vehicle continuing toward
100%. The final charging period has no automatic end; charging may continue past
the minimum and deadline.

Connection, current, voltage and native schedules are automatic only. The
configured TeslaMate feed defaults to Charger 2. With automatic attribution,
the positive Tesla charger-identification result also selects its planning values.
A confirmed Tesla on Easee supplies Charger 1's SoC and target, using the saved
Tesla vehicle capacity from Charger 2; the other vehicle MQTT feed cannot override
that assignment. Charger 2 then says Tesla is connected to Charger 1 and has no
duplicate session or forecast. The result stays with
the connection through planned pauses and restart, and clears on confirmed unplug.
Home location gates household connection and load accounting. The explicit
`charger_assignment: "easee"` option still attaches TeslaMate's vehicle values to
Charger 1 and avoids recording that charging again as Charger 2.
When identification is enabled and Tesla is plugged in at home, a new unrestricted
Easee connection gives the existing bounded comparison up to three minutes of
initial charging before scheduling. Confirmed identification ends that wait early.
The diagnostic cannot replace a native restriction, run under manual priority,
or start after the observation window. Its existing one-minute current reduction
and device-side expiry remain unchanged. Inconclusive evidence leaves Charger 1
unidentified and using manual values; matching power alone never establishes identity.

BMW identification uses the available source-timestamped home-location, plug and
charging-status facts. Its usual match requires a fresh live plug report, a
charging start and a subsequent stop corresponding to the current Easee connection.
Matching live start evidence with valid home and plug context can show
**BMW identification pending** while awaiting stop confirmation, including when
the plug report is unchanged, for up to ten minutes from connection. Manual
battery values remain in use until a match is confirmed.

If BMW keeps reporting `CONNECTED` without a new plug transition, identification
can instead use its home/plug context and a planned pause already controlled by
ST-MQ. Fresh live BMW starts and stops must match Easee within 30 seconds and fall
before and after the recorded pause boundary. This can use saved request-intent
timing captured after control checks pass while Easee was charging; otherwise it uses
the stricter schedule-confirmation time. The schedule must still be confirmed,
and the exact owned delay must remain active with a future start and a fresh
Easee scheduling-stop reason after the boundary;
manual priority and conflicting Tesla evidence prevent this match. Consumed
charging-start evidence cannot identify another connection. This adds no charger
commands or probe; see [the BMW feed contract](bmw-cardata.md#association-with-charger-1)
for the evidence requirements.

Charger 1 preserves live streamed Easee mode and pilot transitions with their
source timestamps, so a reported unplug/replug does not disappear when both
changes occur between routine polls. These connection boundaries survive
restart. Changes to enabled state, no-current reason and online state also wake
reconciliation promptly; closely spaced updates share a wakeup, and periodic
checks remain available for recovery. Initial subscription snapshots, reconnect
replays and repeated unchanged values do not create new transition evidence.
A one-second physical unplug cannot be guaranteed detectable if Easee does not
report both transitions. Streamed charger events still need the BMW evidence
above to establish vehicle identity.

A fresh live unplug event from an already identified BMW also ends that charger
connection when the unplug/replug gap falls between Easee polls. This boundary is
saved separately from the raw Easee readings and survives restart. It resets the
old planning episode and clears only the exact old schedule still owned by ST-MQ;
manual restrictions retain priority. A fresh Easee connection event or subsequent
live BMW plug event allows a new observation window, and the new connection still
needs matching charging-start and stop evidence before vehicle readings apply.

No extra stop is commanded solely for BMW identification. Location alone,
retained replay, periodic republication and old connection reports are insufficient.
Missing BMW power or plug-event-ID descriptors do not block this method. Conflicting
BMW/Tesla evidence leaves the connection unidentified. Matches are scoped to the
plug-in session, survive ordinary charging pauses and restart, and clear on
unplugging. See [the BMW feed contract](bmw-cardata.md).

## Deployment configuration and vehicle MQTT

MQTT topics are deployment configuration, outside the charger settings UI.
Charging loss is fixed and cannot be changed in deployment or dashboard settings.
In the existing configuration file:

```json
{
  "charging": {
    "chargers": {
      "charger1": {},
      "charger2": {}
    },
    "vehicles": {
      "bmw": {
        "label": "BMW",
        "provider": "bmw-cardata",
        "mqttTopic": "stmq/vehicles/bmw"
      }
    }
  }
}
```

These are also the defaults when omitted. Vehicle topics are distinct and
concrete, without MQTT wildcards. Set the BMW topic to an empty string to disable
that feed, including in Home Assistant add-on options. Standalone configuration
also accepts `null`; Home Assistant options require the empty-string spelling.
Configuration reload recreates the acquisition/runtime; changing a topic
invalidates the stored vehicle readings associated with the previous topic.
Saved UI preferences are independent of deployment configuration.

Explicit legacy charger `mqttTopic` options are accepted as source aliases, not
as vehicle identification. New installations use `charging.vehicles`. TeslaMate
keeps its own native `teslamate/.../cars/.../#` subscription; ST-MQ does not rename
or republish another application's topics.

The dedicated BMW topic identifies the vehicle feed. Its publisher sends retained
JSON at QoS 1, with independent fact clocks detailed in the BMW documentation:

```json
{
  "provider": "bmw-cardata",
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

The **BMW** and **Tesla** entries under Data & settings → MQTT show configured
vehicle names even before their first report. They report subscription and reception
separately from charging or energy-recorder health. A sleeping or idle vehicle
does not imply MQTT disconnection. Live and retained packets are distinguished;
repeated unchanged values can confirm reception without refreshing a vehicle
measurement's displayed age. A current charger association is shown separately.
BMW supplies vehicle facts, not consumption, and is excluded from Electricity consumption.

## Charge progress

The displayed estimate uses the same recorded grid-energy intervals as the
history charts, including the recorder's durable pending interval. It does not
run a second power integrator or treat a command as delivered energy:

`estimated SoC = starting SoC + delivered grid kWh × 0.925 / capacity × 100`.

The vehicle's raw percentage and original timestamp stay unchanged. A genuinely
new charge reading rebases the estimate, counting only energy after that
reference and within the current connection. Unchanged receipt-only messages and
retained replays do not erase progress. Capacity and target edits
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
If tomorrow's prices are unpublished, the planner chooses the cheapest feasible
periods in the contiguous published horizon. Unknown rates are not treated as
free. New or revised remaining prices recalculate pending and active automatic
plans, including an already-started final period. If the published period cannot
supply enough energy, ordinary insufficient-time fallback remains provisional.
An overdue connected deadline does not silently advance to tomorrow; an expiring
manual readiness cycle is a separate handback.

Confirmed Easee delays are installed one at a time. At an intermediate period's
end, the next native delay requests a pause until its next start. **These period
transitions need the application and Easee connection online.** An installed
one-off start still works independently; if a later pause is missed, charging may
continue and cost more. An entire pause that passed without confirmation is
reported after reconnection, without assuming that unobserved charging definitely
continued. The notice survives restart for that connection. No final stop is
preinstalled. The full proposed periods
are shown here; the Easee app shows the currently installed instruction.

An active confirmed period normally keeps its planned end. When remaining price
intervals or rates change, a cheaper plan can pause charging if the target remains
unmet, the original ready-by time is still ahead, and the replacement can meet
that deadline while saving more than 1 cent on the remaining charge. Already
delivered energy is credited. Charging runs for at least 15 minutes before an
immediate price-driven pause, and each pause lasts at least 15 minutes.

Repeated price data and publication metadata alone do not trigger this
reconsideration, including after restart. Ordinary telemetry or setting updates
do not themselves interrupt a final release. Future periods can still be revised
using delivered energy, household forecast and peer schedules. The current
readiness forecast evaluates retained execution periods, so a new proposal does
not claim a finish that the installed instruction cannot deliver. A failed update
retains the last confirmed periods with its explanation.

When inputs are missing or time is insufficient, immediate charging is a
temporary allowance and planning continues. Improved readings can still produce
economical later periods. A final release can be delayed again only by the
price-driven reconsideration above; reaching the target or deadline does not
issue a final stop. A confirmed disconnect relinquishes an owned future delay;
new planning waits for connection.

Future command adapters can declare scheduling and current-control capabilities.
The planner can propose simultaneous current allocations by remaining energy and
time. At most one charger uses an external limiter; it gets the remaining power
and never receives a current-limit proposal. These proposals need a future
executor; today's integrations issue only confirmed native Easee schedules.

## Manual priority

Enabling **Automatic charging** takes scheduling control unless a manual
instruction has priority. A pre-existing foreign schedule is preserved when
ownership is unknown. An unrestricted first observation establishes a baseline. Later schedule
changes are observed even while disconnected or automatic charging is off.
Native expiry, inactive saved schedules, Equalizer pauses and the controller's
own writes do not count as manual actions.

One simple repeating daily/weekly manual window keeps priority through its
current or next concrete end, including beyond ready-by. Multiple periods or an
unknown/ambiguous end require explicit resumption. Restart, unplugging, OFF/ON
and later ready-by edits do not extend or erase a recorded window end.
**Resume automatic charging** ends the
observed override early; a newer edit noticed during the confirmation read still
wins. The card shows the effective resumption time and why it was chosen.

Handback requires a fresh charger read. A failed connection shows pending
handover rather than claiming control resumed. If a window ends after ready-by,
subsequent planning uses the next readiness cycle. An actual disabled or unauthorized
charger must first be enabled/authorized in Easee; no such command is issued
automatically. An observed immediate-charge instruction is respected until confirmed
unplug or explicit resumption, including zero-power pauses and passed deadlines.
Price-driven replanning respects these manual instructions too.

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
| `/api/charging/chargers/:id/target` | `{ "connectedAt": <displayed session timestamp>, "mode": "full" }` or `"mode": "automatic"`; identified BMW only, current connection only |

Unknown IDs/fields and invalid values are rejected. Unsupported scheduling is
both disabled in the UI and rejected by the server. Read-only replicas render
the saved primary state at its publication time, without replanning or commands.
