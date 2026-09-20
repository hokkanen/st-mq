# Custom MQTT topics

Custom topics follow `stmq/<area>/<device>/command/<property>` for actions and
`stmq/<area>/<device>/status/<property>` for reports. Native Shelly topic prefixes
and protocols remain as configured. This convention uses Shelly's command/status
vocabulary; custom MQTT devices are still configured with `mqtt:` connections.

| Purpose | Previous topic | New topic | Payload |
| --- | --- | --- | --- |
| DHWR command | `from_stmq/dhwr/set` | `stmq/home/dhwr/command/switch` | `ON` / `OFF` |
| DHWR power | `to_stmq/dhwr/power` | `stmq/home/dhwr/status/power` | Numeric watts |
| Upstairs temperature | `stmq/smoke/1/temperature` | `stmq/home/smoke1/status/temperature` | Numeric Celsius |
| Bedroom temperature | `stmq/smoke/2/temperature` | `stmq/home/smoke2/status/temperature` | Numeric Celsius |
| Downstairs temperature | `stmq/smoke/3/temperature` | `stmq/home/smoke3/status/temperature` | Numeric Celsius |
| Garage door 1 | `from_hass/garage_door1/sensor` | `stmq/garage/door1/status/contact` | JSON contact snapshot |
| Garage door 2 | `from_hass/garage_door2/sensor` | `stmq/garage/door2/status/contact` | JSON contact snapshot |
| Garage door 1 operation | `to_hass/garage_door1/action` | `stmq/garage/door1/command/cover` | `open` / `closed`; `stop` only if supported |
| Garage door 2 operation | `to_hass/garage_door2/action` | `stmq/garage/door2/command/cover` | `open` / `closed`; `stop` only if supported |
| Optional HA garage air temperature | Existing HA publisher retained | `stmq/garage/air/status/temperature` | JSON Celsius snapshot |

The installation uses power-only DHWR feedback. No physical or virtual switch-state
publisher is required or enabled. Positive power means on and zero means off.
Every command needs a subsequent power report to verify its result; timed
circulation and its durable OFF obligation remain independent. See [DHWR setup](dhwr-mqtt.md).

[BMW CarData](bmw-cardata.md) publishes retained QoS 1 JSON on the established
vehicle feed `stmq/garage/charger1/vehicle`: charge percentage, vehicle target,
usable capacity and the original measurement timestamps.

## Publisher changes and cutover

Update the SmartThings MQTT switch subscription to the new DHWR command topic,
and the power and three temperature publishers to the new status topics. Keep the
current payloads; select QoS 1 and leave retention disabled. These are manual
SmartThings changes, separate from ST-MQ configuration. Smoke readings retain
their 70-minute report interval and five-minute delivery grace.

The [Home Assistant publishers](homeassistant-mqtt.md) add door snapshots, queries
and availability topics. Both public door configurations select this
protocol. The optional HA air-temperature publisher is available separately;
ST-MQ's default garage temperature source remains native Shelly MQTT.

The three HA status publishers and two cover-command handlers use the new topics.
Legacy routes remain until their readers and writers migrate. The four legacy
door status publishers and four separate legacy operation handlers are different
automations; migrating status alone does not make the operation handlers redundant.
The legacy temperature publisher uses source changes instead of a minute timer.
Home Assistant publishing changes do not restart or migrate ST-MQ. Exact
[SmartThings door settings](homeassistant-mqtt.md#smartthings-door-settings) include
both directions and the JSON format change.

Coordinate publisher changes with an ST-MQ restart to load the updated acquisition
code and settings. Finish any active timed
circulation run through the old command route before changing that route, so its
pending OFF reaches the original subscriber. A private equipment list replaces the
public list and must be updated separately if present.

## Door recovery protocol

Each HA door publisher accepts `status_update` on
`stmq/garage/door1/command` or `stmq/garage/door2/command` and replies on its normal
contact topic. The corresponding `mqtt.request_topic` and `mqtt.request_payload`
are configured in the public defaults. ST-MQ requests status after successful
startup/reconnect subscriptions and during Recheck, using QoS 1 with retention
disabled. These query topics do not operate a door. Movement uses the separate
`/command/cover` routes described above.

A snapshot preserves the HA source entity's `last_reported` time in `timestamp`,
with its value in `value`. Public defaults select those JSON paths. The separate
`published_at` field records when HA publishes the snapshot. Queries read HA's
cache; they do not refresh the physical sensor. Retained messages cannot complete
a live Recheck. Publications occur on source changes, startup, HA MQTT birth and
status requests; there is no timer or heartbeat publisher.

Each door publishes retained `online` / `offline` to its `/availability` topic.
ST-MQ requires a live child online report and a live contact snapshot. Unknown or
unavailable source states publish offline with a null value. The additional
`mqtt.bridge_availability_topic: "homeassistant/status"` tracks HA connectivity:
bridge offline immediately invalidates both doors; live online requests recovery.
An initially absent bridge status does not prevent a live child reply. Retained
bridge online provides context but cannot restore a contact by itself. Neither
availability signal establishes a new physical contact observation.

Doors use event-driven availability throughout equipment display, the garage
model and history. Their last confirmed state does not expire after five minutes.
Outages make the current state unknown; a live source-online report and snapshot
can recover it without replacing the original source clock or erasing the gap.
The model records door continuity so brief openings or outages between temperature
reports still exclude affected learning and validation. The new garage algorithm
starts an explicit epoch; archived learning is not reinterpreted.
