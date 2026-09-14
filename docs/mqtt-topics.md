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
| Garage door 1 | `from_hass/garage_door1/sensor` | `stmq/garage/door1/status/contact` | `open` / `closed`, or a configured JSON snapshot |
| Garage door 2 | `from_hass/garage_door2/sensor` | `stmq/garage/door2/status/contact` | `open` / `closed`, or a configured JSON snapshot |

The installation uses power-only DHWR feedback. No physical or virtual switch-state
publisher is required or enabled. Power is last-reported consumption, not an
ON/OFF acknowledgement; timed circulation and its durable OFF obligation remain
independent. See [DHWR setup](dhwr-mqtt.md).

## Publisher changes and cutover

Update the SmartThings MQTT switch subscription to the new DHWR command topic,
and the power and three temperature publishers to the new status topics. Keep the
current payloads; select QoS 1 and leave retention disabled. These are manual
SmartThings changes, separate from ST-MQ configuration. Smoke readings retain
their 70-minute report interval and five-minute delivery grace.

Update the corresponding Home Assistant door publishers to the new contact topics.
Before adding query or availability mappings, inspect the actual source entities
and their reporting behavior. Public defaults currently change the contact topic
names only; they do not claim that an HA query endpoint has been installed.

Coordinate publisher changes with ST-MQ settings reload. Finish any active timed
circulation run through the old command route before changing that route, so its
pending OFF reaches the original subscriber. This repository change does not reload
or restart an installed service, configure Home Assistant, or migrate the separate
production installation. A private equipment list replaces the public list and
must be updated separately if present.

## Door recovery protocol

Once implemented by the HA publisher, each door can accept `status_update` on
`stmq/garage/door1/command` or `stmq/garage/door2/command` and reply on its normal
contact topic. Configure the corresponding `mqtt.request_topic` and
`mqtt.request_payload`. ST-MQ requests status after successful startup/reconnect
subscriptions and during Recheck, using QoS 1 with retention disabled. There are
no door movement commands and no application-level receipt requirement.

A bridge snapshot should preserve the source state time, for example
`{"value":"closed","timestamp":"2026-09-14T10:00:00Z"}`. Configure
`mqtt.state_path: "value"` and `mqtt.timestamp_path: "timestamp"` for that format.
Replies containing cached state must keep the original timestamp. MQTT receipt,
bridge uptime, and sensor observation time have different meanings. Retained
messages cannot complete a live Recheck.

Forward unknown/unavailable source states explicitly. A proposed per-door
availability topic is `stmq/garage/door1/availability` (and likewise `door2`), with
`online` / `offline` payloads. Configure it only when the publisher implements it.
HA's own availability proves bridge connectivity, not physical contact health.

The garage model currently requires door source timestamps younger than five
minutes. Recovery of an older event-only state for display does not override that
model limit. Inspect the HA source reporting contract before changing this policy;
periodic publication of cached state with a new timestamp is not a valid fix.
