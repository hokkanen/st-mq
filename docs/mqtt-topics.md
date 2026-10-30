# Custom MQTT topics

Custom topics follow `stmq/<area>/<device>/command/<property>` for actions and
`stmq/<area>/<device>/status/<property>` for reports. Native Shelly topic prefixes
and protocols remain as configured. This convention uses Shelly's command/status
vocabulary; custom MQTT devices are still configured with `mqtt:` connections.

The primary broker carries local equipment traffic. The optional `mqtt.ha`
connection carries HA-hosted vehicle and appliance feeds. Native Meross devices
use their appliance and application topics on primary; see
[Meross configuration](meross-msg200.md). Other routing is described in
[broker configuration](configuration.md#primary-mqtt-and-ha-hosted-integrations)
and [paired endpoint ownership](pairing.md#mqtt-address-management).

| Purpose | Previous topic | New topic | Payload |
| --- | --- | --- | --- |
| Upstairs temperature | `stmq/smoke/1/temperature` | `stmq/home/smoke1/status/temperature` | Numeric Celsius |
| Bedroom temperature | `stmq/smoke/2/temperature` | `stmq/home/smoke2/status/temperature` | Numeric Celsius |
| Downstairs temperature | `stmq/smoke/3/temperature` | `stmq/home/smoke3/status/temperature` | Numeric Celsius |

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

Source entity mappings and generated household automations remain private.
A private equipment list replaces the public list and is maintained separately.
Publisher changes retain original source timestamps and do not refresh cached
physical observations. Coordinate equipment-route changes with application
configuration and preserve any outstanding restoration obligations.

## Home floor controller

The commissioned floor adapter uses the fixed Sonoff board profile on the shared
MQTT broker: `cmnd/sonoff4chpro/LEASE` for non-retained requests,
`stat/sonoff4chpro/LEASE` for replies and state, and `tele/sonoff4chpro/LWT` for
availability context. Exact private device identity and correlated current
feedback are required; Online alone grants no authority. Use custom lease `get`
for monitoring because native maintenance commands terminate the active lease.
See [floor setup and evidence](floor-preheat.md) and the separate
[firmware protocol](https://github.com/hokkanen/sonoff-4chpro-mqtt/blob/main/docs/protocol.md).
