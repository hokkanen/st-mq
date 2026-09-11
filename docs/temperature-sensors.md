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
The Average indoor chart follows saved indoor endpoints of completed 15-minute
learning windows. With `committed-house-v7-held-indoor`, a known indoor average
remains visible even when another input, such as outdoor temperature, prevents
that window from training the model. Missing indoor endpoints and missing windows
remain gaps. Earlier algorithms retain their original chart interpretation. The
chart does not recalculate old averages from today's membership or weights;
imported model history retains its saved original Upstairs input.
Selecting different positive weights is a configuration choice; sensor outages
never redistribute weights. Each contributing sensor keeps its last genuine
usable reading when publications stop or the connection fails, with no age cutoff.
A two-hour-old indoor reading is normal. Older readings, disconnected sensors
and fallback after an invalid publication show **Needs attention** without
removing that room from the average or blocking control. No room temperature is
inferred from another sensor. Current Garage readings follow the same policy,
while outdoor temperature retains its separate freshness limits. Raw sensor
history still preserves the recorded availability gaps.

The Average indoor summary and **Main temperatures** source details identify
affected rooms and their actual observation times. New saved-average chart
tooltips preserve the same warnings and identify windows excluded from learning.
Holding a reading does not change its source timestamp or create new evidence of
measurement. The v7 learner uses this same last-known-reading assumption for
thermal and comfort learning, preserving held flags separately from validity.
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
