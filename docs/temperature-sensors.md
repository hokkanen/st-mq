# Indoor temperatures and sensor changes

The governing foundations are [F1: current-format compatibility](../AGENTS.md#f1),
[F2: model reconstruction](../AGENTS.md#f2) and
[F4: evidence and provenance](../AGENTS.md#f4). Follow the
[conflicting-request process](../AGENTS.md#conflicting-requests) before changing
those commitments; this document specifies their sensor behavior.

Indoor sensors publish through the existing local MQTT broker. Smoke channel 1
is Upstairs (`indoor_temperature`), channel 2 is Bedroom (`bedroom_temperature`)
and channel 3 is Downstairs (`downstairs_temperature`). Configure each exact topic
using one `connection` line per room in public `config.json` under
`options.equipment.devices`. Broker credentials stay private; topic defaults are
public. [Recording configuration](recording.md)
describes the supported payloads and optional averaging weights.

The dashboard labels these sensors **MQTT** and native devices **Shelly**.
H66 has no indoor sensor in this installation; its indoor register is not acquired,
recorded or used as an Upstairs fallback.

The smoke publisher uses `stmq/home/smoke1/status/temperature`, `stmq/home/smoke2/status/temperature`
and `stmq/home/smoke3/status/temperature`. Assign each exact topic to its corresponding room;
the subscription fields require exact topics, not a wildcard such as
`stmq/home/+/status/temperature`.

The **Home temperatures & comfort** view compares Upstairs, Bedroom, Downstairs,
**Average indoor** and the saved reference. **Property temperatures** keeps all
three rooms and both garage probes together. Temperatures share one right-hand
scale; views with no other quantitative subject hide the left scale. The average
is the fixed configured indoor average used by the thermal model: Bedroom contributes 50%, Downstairs 25% and Upstairs 25% with default weights.
The optional `controller.indoor_sensor_weights` map changes these fixed weights. Historical inputs retain their
original membership instead of applying today's sensor configuration backwards.

Average indoor is green, Upstairs terracotta, Bedroom violet, Downstairs amber and
Outdoor blue. Garage front and rear use related but distinct warm colours. Dashed
temperature curves use monotone cubic interpolation; forecast curves use
dash-dot strokes. Every plotted temperature in °C follows the same rule,
including references, settings, targets and temperature differences. This changes
only the drawing: exact recorded setting changes, commands and learning inputs
retain their original meanings. Unknown or unavailable intervals still break
the curves. Each view remembers its own legend choices; price visibility is
shared. **Garage temperatures & compressor**
also offers the pump's interpreted indoor temperature as a diagnostic, separately
from the two protection probes. Its saved Normal/Away choice, native pump power
and compressor activity distinguish requested mode, reported power and observed
operation. Garage has no economic or timed-off pause. The chart's top-right
selection button opens a centered explorer with **Views** and **All series** modes.
Individual signals remain searchable in **All series**; selecting a result closes
the explorer and updates the button to show the chosen series. The summary above
the chart shows Average indoor and Outdoor.

By default, st-mq expects a genuine report on each dedicated indoor MQTT topic
every 70 minutes, with five minutes allowed for delivery delay. This is an
application policy, not a guarantee about the detector. Set
`mqtt.temperature_report_interval_minutes` and
`mqtt.temperature_report_grace_seconds` to match the publisher. Interval `0`
selects the change-only, last-known-reading policy after the next genuine
report. A configured periodic deadline is applied from its change time forward;
an existing genuine report younger than the new limit can remain valid without
pretending another report arrived. Earlier gaps and explicit sensor-change
exclusions remain intact. Reloading or restarting cannot renew the source timestamp.
After successful MQTT subscriptions, a room reading interrupted only by a
connection failure can resume for the remainder of its original deadline. Its
saved broker/topic signature must match; invalid reports and sensor-change
exclusions still require a genuine new reading. The outage remains a recorded
gap. This recovery applies only within the current supported database and input
contract. Incompatible development formats are rejected before mutation and
require a deliberate fresh database; an older record format is not a supported
restart-recovery path.
These settings apply to the three indoor MQTT topics. Garage has a two-minute
expiry for either its single Shelly or MQTT connection; outdoor limits remain separate.

Garage's MQTT temperature history and device-local heating have separate evidence
paths. Losing the application's probe feed ends its recorded coverage; a retained
value cannot fill that gap or prove protection is ready. The heat-pump controller
receives the rear temperature directly through native BTHome components and keeps
its saved room target. Healthy local Bluetooth regulation can continue while the
application or MQTT is unavailable. There are no application-renewed temperature
permissions or managed OFF leases.

After 180 seconds without valid local sensor reports, the heat-pump controller
clears external sensing and selects native 16°C in HEAT, preserving power.
Independent frost protection can require HEAT/ON. These local decisions require
their own fresh evidence; the dashboard's last probe value cannot confirm them.
See [local regulation](garage-adapter.md#bluetooth-and-local-regulation) and
[Garage protection](garage.md#independent-freeze-protection).

The installed room sensors have a 70-minute maximum delay for unchanged values.
ST-MQ's five-minute grace makes the expiry exactly 75 minutes after the last
genuine report. Age alone produces no earlier warning. At expiry the room is
outdated and stops contributing to learning. The driver selector does not change
ST-MQ configuration.
See the [installation reasons and timing instructions](smartthings-temperature-rule.md#matching-the-st-mq-report-deadline).

Installing a sensor driver does not create a forwarding Rule, MQTT subscription
or model input. Configure each intended source and its membership separately.

An unchanged report confirms coverage without inserting another temperature
observation. Every actual value change is saved, along with availability changes;
there is no maximum recording interval that forces repeated values.
Compact coverage spans preserve the report evidence. Consequently a long flat
line means the reports continued with the same value. After the report deadline,
or an explicit disconnection or invalid update, the room line has a gap. A later
report starts a new covered segment even when its value is unchanged. The original
value timestamp remains distinct from the later coverage evidence.

The Average indoor chart follows saved inputs of completed 15-minute learning
windows, preserving gaps when a participating room lacks report coverage. The
current report-coverage rule rejects an interval containing a
report outage even if a sensor recovers before its endpoint. Fixed weights never
redistribute to the remaining rooms. Missing coverage makes the measured average unavailable. A separate, explicitly
identified control estimate may bridge one unavailable room as described below;
ordinary heating remains available. Other missing
learning inputs do not hide an otherwise known indoor average. Supported journal
history retains its recorded membership and weights instead of being recalculated
from today's configuration. Unsupported earlier learning algorithms are rejected;
this historical fidelity does not require retaining old interpreters.

This requires genuine repeated reports all the way through SmartThings and MQTT.
A timer that republishes a cached value cannot prove a sensor is alive. The
[SmartThings rule and driver notes](smartthings-temperature-rule.md) explain the
forwarding rule, source recovery, installation and physical verification steps.

The Average indoor summary and **Main temperatures** source details identify
affected rooms and their actual observation times. New saved-average chart
tooltips preserve the same warnings and identify windows excluded from learning.
Holding a reading does not change its source timestamp or create new evidence of
measurement. Periodic report coverage is recorded separately for learning and
replay. Only sources without an enabled periodic report contract can hold a
known value without periodic source-report renewal.
A sensor that has never supplied a usable reading still makes its
configured average unavailable; sensor-change boundaries also require a genuine
reading from the new measurement period.

### Availability messages and clocks

The indoor-average summary shows only a small issue indicator. Detailed room
reasons and timestamps are inside **Home → Sensors & Equipment** and source details.
An expired reading shows its elapsed age and
the applicable limit. A missed periodic report shows the last genuine report time
when known, interval plus grace, deadline and overdue duration. This is separate
from the timestamp of an unchanged saved temperature. An unavailable indoor
average names the rooms preventing its use. Invalid publications, missing times,
retained packets, disconnections and sensor-change boundaries have specific
reasons; an older record without diagnostic evidence says that the reason was
not recorded instead of guessing.

| Input | Availability rule | Warning or learning effect |
| --- | --- | --- |
| Periodic indoor MQTT | 70-minute reporting interval plus five-minute grace | At 75 minutes, or on an explicit acquisition failure, the measured average is unavailable. A bounded one-room estimate may support control. Learning rejects a whole window containing a report gap. |
| Garage probe history | Two minutes after the last genuine Shelly or MQTT report; direct Shelly is polled every 30 seconds | At expiry the reading becomes unavailable and the chart has a gap. The pump's local BTHome regulation has its own evidence path and timeout; see [Garage control](garage.md). |
| Indoor without a periodic contract | Keep the last genuine valid value until replaced or excluded by a sensor change | Applies only when explicitly disabling the reporting contract, not the three configured room sensors. |
| H66 equipment (outdoor register excluded from weather selection/history) | Five-minute source validity for equipment diagnostics | A stricter live transport/readback gate can reject sooner, and its actual limit is displayed. It cannot extend the source-validity limit. |
| FMI / Open-Meteo outdoor | Thirty-minute source validity | Expiry removes the reading from current outdoor selection and leaves unavailable learning coverage. |

H66 ordinarily supplies no sensor measurement timestamp. Messages explicitly
label when their age uses MQTT receipt time. A broker connection, successful HTTP
download or unrelated MQTT message never renews a measurement's age. H66 readback
details distinguish an actual broker disconnection from quiet telemetry and from
waiting for a new live publication after reconnecting.

Provider download diagnostics are a separate operational view: current-source
warnings start at 30 minutes, and temperature-source warnings at two hours.
Those thresholds are labelled as attention thresholds, not control or learning
permission. Idle Charger 1 age alone remains informational. Tesla diagnostics
identify the expired vehicle-health or charging-evidence clock and configured
limit. Recording details distinguish current source/report validity from the
last acquisition outcome and from completed historical energy intervals.

Slaves apply the same temperature source limits and report policy to evidence
available at the published snapshot boundary. When a compact coverage span proves
availability at that boundary but not the precise most recent report timestamp,
the display preserves that uncertainty. Synchronization age is reported
separately from sensor age. Historical model tooltips evaluate age at the saved
window, not the current time.

Source timestamps, seeds and current committed inputs retain deterministic replay.
The current continuous-reference algorithm and source-evidence semantics require
a deliberate fresh development start for older algorithm checkpoints. Incompatible development algorithms
are rejected; permitted v0.7.5 CSV imports retain their timestamp/quality meaning.

The committed journal saves each contributing endpoint and weight, observation
lineage, the resolved average and its configuration. This remains one thermal model and one learned normal-temperature reference.
Occupied comfort limits, forecasts, discomfort costs and recovery checks use the
same configured indoor average. Individual rooms have no separate reference or
automatic veto; a room can depart further from its normal temperature than the
average allowance. The shared heating system cannot regulate rooms independently.

Historical CSV indoor readings retain their original upstairs meaning. The new
rooms have no invented history before installation. Imported model learning
continues using only the historical upstairs measurement.

## Replacing, moving or adjusting a sensor

Open **Home → Home heat model → Model inputs → Average indoor → Sensor
changes** for indoor sensors, or **Outdoor temperature → Sensor changes** for
the outdoor sensor, after completing a replacement, move or calibration. Select
**Sensor** and **Reason**, then choose **Record change now**. Review the
confirmation, which explains the effect on learning, before accepting. The reason choices are
**Replacement**, **New location**, **Calibration** and **Other**. Reason is saved
as descriptive history; all four choices have the same learning effect for the
selected sensor. Each temperature section keeps its own form and change history.
Choose **Show older changes** to reach entries beyond the first ten.

The action records the current server time, including for changes that keep the
same device identifier. It does not edit device configuration or backdate a change.

For a participating indoor sensor or the outdoor temperature, the action:

- Preserves raw readings and the old measurement history.
- Retains model validation, fitting samples, completed episodes, fitted coefficients
  and the aggregate comfort reference. New clean observations recalibrate
  them gradually through the existing adaptation rules; no offset is guessed.
- Resets only the current temperature propagation state. Fitting and prediction
  never cross a sensor-change boundary, including a change between sparse samples.
- Masks only the changed sensor during settling. An outdoor change does not erase
  indoor observations, and one room change keeps the other rooms' readings.
- Discards pending optimisation and marks an active cycle incomplete, preserving
  its original forecast and observations. Normal heating remains available.
- Excludes the transition and a 30-minute settling period, then requires fresh
  measurements from the new period before learning resumes.
- Records one immutable event. Retrying after a lost response uses the same
  request identity and cannot duplicate it.

Garage and zero-weight indoor sensor changes are recorded without resetting the
house model. A change to indoor averaging membership or weights automatically
establishes the corresponding model boundary. The event list also appears on a
read-only slave; changes must be managed on the controlling instance.

To undo a mistaken entry, choose **Revert and relearn** beside it and confirm.
The original event remains in history with its reversal time. Relearning uses
recorded observations as if that measurement boundary had not been recorded, including measurements
collected during its settling period. Other active sensor changes still apply.
The corrected model is built in the background while heating control remains
available; the complete, caught-up result replaces the previous model together.
Original readings, actual heating operation and frozen forecasts stay intact.
The **Average indoor** and **Model inputs** charts retain the inputs originally
supplied to learning, including the original settling gaps. Those chart gaps do
not mean the underlying readings were lost: the corrected learner can use them,
and **Model coefficients** shows the resulting corrected reconstruction.
Reverting a genuine change that introduced a measurement bias could combine
incompatible observations, so use reversal for an incorrectly recorded change.

The panel shows queued, running, completed or failed relearning when live progress
is available. A saved reconstruction request on a read-only view is labelled as
recorded; it cannot establish whether a worker is running now. Action receipts
remain visible for 24 hours, while an unresolved save remains available to retry.
If saving was not
confirmed after a connection failure, **Retry saving** reuses the original request
and cannot duplicate the entry or reversal, including after a page reload. If the
background work fails, **Retry relearning** restarts it while the previous model
remains active. Garage and nonparticipating indoor entries use **Revert change**
because they did not change house learning eligibility. Reversal applies only to the current
algorithm and source-event contract; unsupported development payloads are rejected.

No offset is inferred from the jump at a change. Comparing replacement sensors
side by side can establish relative agreement, but matching their readings does
not prove absolute accuracy. A different position or response time may change
thermal behaviour beyond a constant offset.

## Normal-temperature reference

One supported hour of occupied Normal heating initializes an approximate reference
from the configured indoor average. It remains provisional until 24
hours are supported by verified heating. Weather-inferred hours do not satisfy
that qualification. Ordinary valid Normal observations then refine it continuously
with a 48-hour smoothing timescale and a 1°C bound on each temperature innovation.
There is no plateau test, uninterrupted-day requirement or learned time-of-day
schedule. Initial and later learning use the same evidence rules.

Verified space-heating activity supports demand, including ordinary off cycles
for up to six hours after heating. DHW activity alone does not count. When current
native evidence is unavailable, outdoor temperature at most 12°C and an
indoor–outdoor difference of at least 8°C provide a labelled provisional demand
inference. Weather inference cannot replace known evidence of no space heating.

Preheat, reduction, recovery, Away and material logged fireplace influence pause
reference updates. Two hours of Normal settling after the controller's heating
interventions keep their residual effects out of the reference. Small observation
outages pause updates without clearing the reference or earned progress; missing
time and cached readings earn no evidence. Genuine unchanged reports do count
as source support. Reference support time refreshes even when the numerical
reference does not move.

Persistent changes to local floor thermostats gradually move the overall
reference in either direction according to each room's configured weight. This
observes achieved temperature, not the person's intent: a faulty valve or open
window can resemble a changed preference. A native ROOM setting edit also retains
the previous reference while new Normal evidence refines it. Provisional references
limit automatic reduction to at most 0.5°C below the reference; equipment readiness,
thermal-model evidence and all other comfort checks remain independent.

## One missing room

One unavailable participating room can be estimated only when two other
participating rooms have fresh valid evidence and a complete common baseline is
available from the preceding 72 hours. Keep the original weights and use:

`missing room estimate = last baseline reading + remaining rooms' weighted average change`

This retains the missing room's usual offset while following observed whole-house
movement. Estimates never support another estimate. A sensor-change boundary,
changed membership or weight, or insufficient supporting evidence prevents
this fallback. Invalid readings cannot supply its baseline or fresh supporting
measurements. Actual readings replace the estimate immediately when the sensor
returns. A local thermostat change or open window in the missing room is invisible;
the surviving sensors temporarily have more influence over estimated movement.

The extra allowance on the overall average is the missing room's normalized
weight multiplied by `0.3°C + 0.02°C × elapsed hours + surviving-room disagreement`.
Disagreement is the absolute difference between the two surviving rooms' changes
since the baseline. It grows with the forecast horizon too. The 72-hour baseline
expiry remains fixed across repeated use and restart. These are engineering
allowances, not statistically calibrated confidence bounds. Planning, live limits
and recovery account for the allowance; new learning trials require a measured
average. If the available
comfort margin cannot absorb it, ordinary native heating remains available.
There is no guarantee of indefinite optimization with a failed sensor. A separate
runtime thermal state can continue the heat-reserve forecast from the last
measured state only with continuously covered actual equipment/weather inputs.
Missing thermal-input coverage selects Normal; inferred room temperatures never
become fitted state or learning observations.

The measured indoor average remains unavailable during the gap. The estimate is
identified as **Partly estimated** with the missing room and baseline time. It
cannot train thermal coefficients or the comfort reference, score observed
prediction validation, or fill recorded temperature history. Individual room
readings retain their original timestamps and unavailable status. Restart does not
renew the baseline or source evidence. An already active cycle can complete its
control recovery using the bounded estimate, but an indoor-observation gap marks
its assessment `unassessed-indoor-observation-gap`. Such a cycle earns no learning
or validation evidence and no claimed observed saving.

### Current acquisition boundary

Configured `timestamp_path` is mandatory. Missing, null, malformed or excessively
future clocks make the reading unavailable; they never fall back to receipt time.
A source clock at most one second ahead follows the shared
[time-evidence contract](time-evidence.md): hold it until that time arrives,
preserve the original source and receipt clocks, and record the actual admission
time. Waiting creates no new evidence or control permission and cannot extend
the original lifetime. Connection changes discard pending reports.
Deliberately untimestamped numeric publishers remain supported as receipt-time
sources, explicitly identified by `raw.timeBasis = mqtt-received`. A DUP-only
untimestamped delivery cannot establish a new sample. A first-seen timestamped
MQTT DUP is evaluated once using receiver-local bounded delivery memory. Subsequent
retransmissions and cached timestamps cannot extend source-report coverage.

For native Shelly notifications, a rejected malformed or excessively future `ts` supplies no
new evidence. Previously accepted measurements keep only their original remaining
lifetime while a bounded pending report waits; rejected packets cannot renew them or device availability. A clock
rejection alone does not manufacture an outage for either Garage probe. Explicit
invalid temperatures or component errors still revoke the affected measurement,
even when the notification's clock is rejected.

Canonical equipment temperature mappings honor the selected primary JSON path.
Fahrenheit converts to Celsius first, then `scale` and `offset` apply; recorded,
held and source-health values share that normalization. Both Garage probes carry
the same two-minute expiry metadata. Garage's independent protection age gate
continues to apply.

Weather current/forecast caches and job cadence bind to a digest of normalized
coordinates and current query definitions on both hot reload and cold restart.
Different/missing identities cannot supply current inputs, and a changed location
is reacquired while provider-host rate limits remain in force. Historical snapshots
retain their provenance. `requestStartedAt` describes request planning;
`fetchedAt`/`receivedAt` describe response completion. Provider source/issue clocks
remain separate, including each source in supplemented solar forecasts.
