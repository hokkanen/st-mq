# Custom MQTT topics

Custom topics follow `stmq/<area>/<device>/command/<property>` for actions and
`stmq/<area>/<device>/status/<property>` for reports. Native Shelly topic prefixes
and protocols remain as configured. This convention uses Shelly's command/status
vocabulary; custom MQTT devices are still configured with `mqtt:` connections.

The primary broker carries independent equipment. When a separate `mqtt.ha`
endpoint is configured, TeslaMate, BMW CarData, garage doors and the Tuya
dehumidifier bridge use that endpoint for their complete integration, including
availability and commands. Without it they share primary. See
[broker routing](configuration.md#primary-mqtt-and-ha-hosted-integrations) and
[paired frontend ownership](pairing.md#mqtt-address-management).

| Purpose | Previous topic | New topic | Payload |
| --- | --- | --- | --- |
| Upstairs temperature | `stmq/smoke/1/temperature` | `stmq/home/smoke1/status/temperature` | Numeric Celsius |
| Bedroom temperature | `stmq/smoke/2/temperature` | `stmq/home/smoke2/status/temperature` | Numeric Celsius |
| Downstairs temperature | `stmq/smoke/3/temperature` | `stmq/home/smoke3/status/temperature` | Numeric Celsius |
| Garage door 1 | `from_hass/garage_door1/sensor` | `stmq/garage/door1/status/contact` | JSON contact snapshot |
| Garage door 2 | `from_hass/garage_door2/sensor` | `stmq/garage/door2/status/contact` | JSON contact snapshot |
| Garage door 1 operation | `to_hass/garage_door1/action` | `stmq/garage/door1/command/cover` | `open` / `closed`; `stop` only if supported |
| Garage door 2 operation | `to_hass/garage_door2/action` | `stmq/garage/door2/command/cover` | `open` / `closed`; `stop` only if supported |
| Optional HA garage air temperature | Existing HA publisher retained | `stmq/garage/air/status/temperature` | JSON Celsius snapshot |

Circulation uses the native Shelly prefix `stmq/home/dhwr`, including its
RPC and status routes. It has no custom ON/OFF or SmartThings power-forwarding
topics. See [direct circulation setup](dhwr-mqtt.md).

[BMW CarData](charging/integrations/bmw.md) publishes retained QoS 1 JSON on the established
vehicle feed `stmq/vehicles/bmw`: charge percentage, vehicle target,
usable capacity and the original measurement timestamps. Configure the matching
`charging.vehicles.bmw.mqttTopic`; the feed belongs to the vehicle, not a charger.

## Caravan devices

Caravan air uses the Shelly BLU bridge topic `stmq/garage/caravan_air/state`
and read-only query `stmq/garage/caravan_air/get`. Reinstall the generated bridge with this prefix at cutover.
The dehumidifier uses the separate `stmq/garage/caravan_dehumidifier` prefix
with `/state` snapshots, `/set` commands, `/get` readback queries and `/availability`.
See the [payload and confirmation contract](caravan-dehumidifier.md). It does not
share the Caravan energy plug’s native `stmq/garage/caravan` prefix.

## Publisher changes and cutover

The three SmartThings temperature publishers use the current status topics,
with QoS 1 and retention disabled. Their settings are separate from application
configuration. Smoke readings retain the 70-minute report interval and
five-minute delivery grace.

The [Home Assistant publishers](homeassistant-mqtt.md) add door snapshots, queries
and availability topics. Both public door configurations select this
protocol. The optional HA air-temperature publisher is available separately;
ST-MQ's default garage temperature source remains native Shelly MQTT.

Generate status publishers and cover-command handlers using the current topics.
An external installation may still have older routes; retire them once their
readers and writers have been changed. Status publishing and command handling
are separate automations, so changing one does not change the other. The optional
temperature publisher reacts to source changes and read-only status requests.
Home Assistant publishing changes do not restart or reconfigure ST-MQ. Exact
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

Doors use event-driven availability in equipment display and history. Their
last confirmed state has no age expiry. Outages make current state unknown;
a live source-online report and snapshot can recover it without changing the
original source clock or erasing the gap. Door observations do not drive an
automatic Garage heat model.
