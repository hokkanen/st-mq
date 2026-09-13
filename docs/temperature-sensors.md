# Indoor temperatures and sensor changes

Indoor sensors publish through the existing local MQTT broker. Smoke channel 1
is Upstairs (`indoor_temperature`), channel 2 is Bedroom (`bedroom_temperature`)
and channel 3 is Downstairs (`downstairs_temperature`). Configure each exact topic
using `mqtt.indoor_temperature_topic`, `mqtt.bedroom_temperature_topic` and
`mqtt.downstairs_temperature_topic`. Keep the actual broker details and device
topics in private configuration. [Recording configuration](recording.md)
describes the supported payloads and optional averaging weights.

The dashboard labels these sensors **Smartthings** in **Main temperatures** and
lists the selected outdoor source beside them. Readings arrive through local
MQTT; st-mq does not connect to the SmartThings cloud API.

The smoke publisher uses `stmq/smoke/1/temperature`, `stmq/smoke/2/temperature`
and `stmq/smoke/3/temperature`. Assign each exact topic to its corresponding room;
the subscription fields do not use the wildcard `stmq/smoke/+/temperature`.

The chart shows one **Average indoor** series on the right axis, using the existing
indoor temperature colour. This is the same fixed average of configured indoor
sensors used by the thermal model: Upstairs, Bedroom and Downstairs each contribute
one third when all three are configured with the default weights. The **Home
temperatures · Recorded** section of the **Left axis** drawer contains one option,
**All home temperatures**, which adds Upstairs, Bedroom and Downstairs on the left
axis. Both air temperature axes then use the same scale. Garage remains a shared
right-axis series with its existing colour and legend control. Average indoor keeps
its green colour, with terracotta for Upstairs, violet for Bedroom, amber for Downstairs and
blue for Outdoor. The summary above the chart shows Average indoor and Outdoor;
individual rooms are available through the chart and source details.
Dedicated indoor MQTT topics expect a genuine sensor report every 15 minutes,
with two minutes allowed for delivery delay. Set
`mqtt.temperature_report_interval_minutes` and
`mqtt.temperature_report_grace_seconds` to match the publisher. Interval `0`
selects the earlier change-only, last-known-reading policy after the next genuine
report. Enabling or changing a periodic deadline records one availability boundary
and requires a genuine report under the new policy; reloading settings or
restarting cannot refresh a cached reading. These
settings apply to the three indoor MQTT topics; Garage and the H66 indoor sensor
retain their existing policy, and outdoor freshness limits remain separate.

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
`committed-house-v8-report-coverage` learner rejects an interval containing a
report outage even if a sensor recovers before its endpoint. Fixed weights never
redistribute to the remaining rooms. Missing coverage makes the average
unavailable for optimisation; ordinary heating remains available. Other missing
learning inputs do not hide an otherwise known indoor average. Earlier algorithms
retain their original interpretation, and history is not recalculated from
today's membership or weights.

This requires genuine repeated reports all the way through SmartThings and MQTT.
A timer that republishes a cached value cannot prove a sensor is alive. The
[SmartThings rule and driver notes](smartthings-temperature-rule.md) document the
installed forwarding rules, restoration procedure and remaining hardware checks.

The Average indoor summary and **Main temperatures** source details identify
affected rooms and their actual observation times. New saved-average chart
tooltips preserve the same warnings and identify windows excluded from learning.
Holding a reading does not change its source timestamp or create new evidence of
measurement. Periodic report coverage is recorded separately for learning and
replay. The archived v7 learner used known readings indefinitely; v8 does so only
for sources without an enabled periodic report contract.
A sensor that has never supplied a usable reading still makes its
configured average unavailable; sensor-change boundaries also require a genuine
reading from the new measurement period.

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

Open **House model → Explore learning → Model inputs → Average indoor → Sensor
changes** after completing a replacement, move or calibration. Select **Sensor**
and **Reason**, then choose **Record change now**. The reason choices are
**Replacement**, **New location**, **Calibration** and **Other**. Reason is saved
as descriptive history; all four choices have the same learning effect for the
selected sensor. The rarely used form and recent change history stay inside this
closed maintenance section, leaving **Home & heating** for everyday controls.

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
read-only replica; changes must be recorded on the controlling instance.

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
