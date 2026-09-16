# Indoor temperatures and sensor changes

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

The chart shows one **Average indoor** series on the right axis, using the existing
indoor temperature colour. This is the same fixed average of configured indoor
sensors used by the thermal model: Upstairs, Bedroom and Downstairs each contribute
one third when all three are configured with the default weights. The **Home
temperatures · Recorded** section of the **Left axis** drawer contains one option,
**All home temperatures**, which adds the room and configured garage probes on the left
axis. Both air temperature axes then use the same scale. Garage remains a shared
right-axis series with its existing colour and legend control. Average indoor keeps
its green colour, with terracotta for Upstairs, violet for Bedroom, amber for Downstairs and
blue for Outdoor. The summary above the chart shows Average indoor and Outdoor;
individual rooms are available through the chart and source details.
By default, st-mq expects a genuine report on each dedicated indoor MQTT topic
every 70 minutes, with five minutes allowed for delivery delay. This is an
application policy, not a guarantee about the detector. Set
`mqtt.temperature_report_interval_minutes` and
`mqtt.temperature_report_grace_seconds` to match the publisher. Interval `0`
selects the earlier change-only, last-known-reading policy after the next genuine
report. A configured periodic deadline is applied from its change time forward;
an existing genuine report younger than the new limit can remain valid without
pretending another report arrived. Earlier gaps and explicit sensor-change
exclusions remain intact. Reloading or restarting cannot renew the source timestamp.
After successful MQTT subscriptions, a room reading interrupted only by a
connection failure can resume for the remainder of its original deadline. Its
saved broker/topic signature must match; invalid reports and sensor-change
exclusions still require a genuine new reading. The outage remains a recorded
gap. Records from before route signatures were introduced need one genuine
publication before this restart recovery is available.
These settings apply to the three indoor MQTT topics. Garage has a two-minute
expiry for either its single Shelly or MQTT connection; outdoor limits remain separate.

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
the recorder's normal five-minute maximum spacing does not force repeated values.
Compact coverage spans preserve the report evidence. Consequently a long flat
line means the reports continued with the same value. After the report deadline,
or an explicit disconnection or invalid update, the room line has a gap. A later
report starts a new covered segment even when its value is unchanged. The original
value timestamp remains distinct from the later coverage evidence.

The Average indoor chart follows saved inputs of completed 15-minute learning
windows, preserving gaps when a participating room lacks report coverage. The
report-coverage rule introduced in v8 and retained in v9 rejects an interval containing a
report outage even if a sensor recovers before its endpoint. Fixed weights never
redistribute to the remaining rooms. Missing coverage makes the average
unavailable for optimisation; ordinary heating remains available. Other missing
learning inputs do not hide an otherwise known indoor average. Earlier algorithms
retain their original interpretation, and history is not recalculated from
today's membership or weights.

This requires genuine repeated reports all the way through SmartThings and MQTT.
A timer that republishes a cached value cannot prove a sensor is alive. The
[SmartThings rule and driver notes](smartthings-temperature-rule.md) explain the
forwarding rule, source recovery, installation and physical verification steps.

The Average indoor summary and **Main temperatures** source details identify
affected rooms and their actual observation times. New saved-average chart
tooltips preserve the same warnings and identify windows excluded from learning.
Holding a reading does not change its source timestamp or create new evidence of
measurement. Periodic report coverage is recorded separately for learning and
replay. The archived v7 learner used known readings indefinitely; v8 and v9 do so only
for sources without an enabled periodic report contract.
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
| Periodic indoor MQTT | 70-minute reporting interval plus five-minute grace | At 75 minutes, or on an explicit acquisition failure, control falls back. Learning rejects a whole window containing a report gap. |
| Garage | Two minutes after the last genuine Shelly or MQTT report; direct Shelly is polled every 30 seconds | At expiry the reading becomes unavailable and the chart has a gap. Garage is monitoring/history only. |
| Legacy indoor without a periodic contract | Keep the last genuine valid value until replaced or excluded by a sensor change | Applies only when explicitly disabling the reporting contract, not the three configured room sensors. |
| H66 outdoor and equipment | Five-minute source validity, shared by live selection, recording, chart reconstruction and learning | A stricter live transport/readback gate can reject sooner, and its actual limit is displayed. It cannot extend the source-validity limit. |
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

Replicas apply the same temperature source limits and report policy to evidence
available at the published snapshot boundary. When a compact coverage span proves
availability at that boundary but not the precise most recent report timestamp,
the display preserves that uncertainty. Synchronization age is reported
separately from sensor age. Historical model tooltips evaluate age at the saved
window, not the current time.

These diagnostic changes preserve the current committed learning inputs,
algorithm, seed and replay interpretation, including v9 sensor-change reversals.
They do not reinterpret archived model versions or change the meaning of imported
CSV temperatures.

The committed journal saves each contributing endpoint and weight, observation
lineage, the resolved average and its configuration. This remains one thermal
model, with separate learned comfort references for participating rooms. During
occupied operation, a room below its own reference minus the permitted drop
prevents or ends a heating reduction even if the average is comfortable. These
are observed room limits, not separate room-temperature forecasts or guarantees
that the shared heating system can regulate every room independently.

Historical CSV indoor readings retain their original upstairs meaning. The new
rooms have no invented history before installation. Imported model learning
continues using only the historical upstairs measurement.

## Replacing, moving or adjusting a sensor

Open **Learning models → Home → Model inputs → Average indoor → Sensor
changes** for indoor sensors, or **Outdoor temperature → Sensor changes** for
the outdoor sensor, after completing a replacement, move or calibration. Select
**Sensor** and **Reason**, then choose **Record change now…**. Review the
confirmation, which explains the effect on learning, before accepting. The reason choices are
**Replacement**, **New location**, **Calibration** and **Other**. Reason is saved
as descriptive history; all four choices have the same learning effect for the
selected sensor. Each temperature section keeps its own form and change history.
Choose **Show older changes** to reach entries beyond the first ten.

The action records the current server time, including for changes that keep the
same device identifier. It does not edit device configuration or backdate a change.

For a participating indoor sensor or the outdoor temperature, the action:

- Preserves raw readings and the old measurement history.
- Clears affected model validation, accumulated fitting samples, temperature
  state, aggregate and room comfort references. House coefficients remain
  provisional starting estimates until new evidence validates them.
- Discards pending optimisation and marks an active cycle incomplete, preserving
  its original forecast and observations. Normal heating remains available.
- Excludes the transition and a 30-minute settling period, then requires fresh
  measurements from the new period before learning resumes.
- Records one immutable event. Retrying after a lost response uses the same
  request identity and cannot duplicate it.

Garage and zero-weight indoor sensor changes are recorded without resetting the
house model. A change to indoor averaging membership or weights automatically
establishes the corresponding model boundary. The event list also appears on a
read-only replica; changes must be managed on the controlling instance.

To undo a mistaken entry, choose **Revert and relearn** beside it and confirm.
The original event remains in history with its reversal time. Relearning uses
recorded observations as if that reset had not happened, including measurements
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

The panel shows queued, running, completed or failed relearning. If saving was not
confirmed after a connection failure, **Retry saving** reuses the original request
and cannot duplicate the entry or reversal, including after a page reload. If the
background work fails, **Retry relearning** restarts it while the previous model
remains active. Garage and nonparticipating indoor entries use **Revert change**
because they did not reset house learning. Entries from an archived learning
version remain visible with an explanation that reversal is unavailable; they
are not silently reinterpreted by a newer learner.

No offset is inferred from the jump at a change. Comparing replacement sensors
side by side can establish relative agreement, but matching their readings does
not prove absolute accuracy. A different position or response time may change
thermal behaviour beyond a constant offset.

## Changes to floor circulation thermostats

The learned comfort reference can move both colder and warmer without a change
to the heat pump's ROOM register. Initial establishment still requires sustained
normal occupied heating. Once established, repeated stable normal fragments of
at least eight hours, with stable final six hours, contribute evidence across
days. At least 24 hours of qualifying evidence spanning 48 hours is required;
updates are limited to 0.2°C per 24 hours of newly evidenced time. Repeated polls
or replay of the same window cannot move the reference again.

Preheating, reduction and recovery hold the reference fixed. Missing or bad
observations, away periods and fireplace effects clear pending adaptation.
Each room uses the same rules for its own reference, allowing the bedroom to
settle at a different normal temperature from Downstairs. This observes the
temperature achieved with the household controls; it cannot independently tell
whether every persistent lower plateau reflects a preference or reduced heating.
