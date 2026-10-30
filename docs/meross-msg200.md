# Meross MSG200 garage doors

ST-MQ communicates with the MSG200 through the signed Meross MQTT protocol.
The device connects to a local TLS MQTT broker. In a paired installation, it uses
the MQTT virtual IP on port 8883. The active ST-MQ node reads contacts and sends
commands through its local primary broker.

## Requirements

The installation needs the device UUID, local key, Meross user ID, channel mapping
and a working TLS broker on each node that can host the device connection.
Credentials and installation addresses
belong in private configuration. [Mosquitto setup](mosquitto-meross.md) covers
broker authentication, certificates, listeners and device binding.

## Equipment configuration

Each door is an equipment entry with an explicit channel. MSG200 channels are
1–3. This example contains invented identity and key values:

```json
{
  "id": "garage_door1",
  "label": "Door 1",
  "area": "garage",
  "kind": "door",
  "connection": "mqtt:/appliance/0123456789abcdef0123456789abcdef/publish",
  "cover_control": false,
  "meross": {
    "uuid": "0123456789abcdef0123456789abcdef",
    "key": "abcdef0123456789abcdef0123456789",
    "channel": 1
  }
}
```

An `equipment.devices` override replaces the full device list. Existing entries
and stable device IDs preserve their equipment configuration and history signals.
Several doors may share the device topic when their channel mappings differ and
the UUID and key match. Custom MQTT payload mappings are not used on Meross entries.

`cover_control: true` enables the configured door's Open and Close actions after
its channel has been commissioned. The MSG200 adapter exposes no Stop action or
measured position percentage. `garage.door_travel_seconds` controls the Garage
illustration's movement estimate; it does not change the motor or contact sensor.

## Contact state and connectivity

ST-MQ subscribes to the device publish topic and a unique application reply topic.
It requests each configured channel after subscription and every equipment poll
interval. Reports expire after 90 seconds by default.

The configured freshness must allow at least one poll interval. Recorded contacts
retain that poll interval and the remaining freshness margin, so chart coverage
ends at the original report deadline even if no disconnect event was recorded.
Source, receive and delayed-admission timestamps remain distinct in stored history.
Contact changes within one source-clock second retain their receive order.

Signed PUSH messages and responses to current state requests provide contact
readings. Retained packets, invalid signatures, stale source timestamps, duplicate
messages and unmatched responses do not refresh the contact. Small source-clock
leads use [delayed admission](time-evidence.md#device-report-admission): the original
source and receipt times remain intact, and control waits until the source time
arrives. Larger leads are rejected. A command acknowledgement does not establish
movement or a new contact observation.

A closed contact confirms the configured closed sensor. An open contact means
that the door is not closed; it does not prove full opening. Unknown connectivity
retains the last reported value and timestamp as context while disabling control.

Meross MD5 signatures cover the message ID, key and timestamp, but not the payload.
Broker access controls and trusted application accounts protect the native topics.
Device identity, contact timestamps and command outcomes remain separate evidence.

## Controls and recovery

Open and Close require the active control role, a subscribed broker connection,
fresh contact evidence and the configured door permission. Native traffic uses
MQTT QoS 0 to avoid stalled delivery windows on firmware that leaves QoS 1
deliveries unacknowledged. Commands are sent once, without retention or application
replay. A newer request cancels an unsent request;
a request whose starting contact changed before transmission is rejected.

Publication confirms a transport write, not a broker acknowledgement. The
interface distinguishes publication from a subsequently observed contact.
An unconfirmed outcome requires checking current door state before another request.
The opener retains its native limits and protection.

Reconnection sends state queries and session metadata replies. These do not move
a door. A restored connection requires fresh reports before controls become usable.
The paired [MQTT frontend](pairing.md#mqtt-address-management) releases both plain
and TLS connections before transferring the virtual IP. Promotion is explicit.
Broker sessions and retained stores are local to each Mosquitto instance.

## Commissioning

Back up the current configuration and active database before changing equipment
routes. Verify the backup, broker credentials and TLS listeners before changing the
device endpoint. With movement controls disabled, confirm both contact mappings
using fresh reports. Enable each door's control only after its mapping is verified.

Attended checks cover each door's opening and closing, closed-contact feedback,
command outcomes, application restart, broker restart and handover in both
directions. Keep travel areas clear and use the opener's own controls and
manufacturer's procedure for testing its native safety protection.

Rollback uses the saved equipment configuration, broker configuration and device
binding. Device binding changes preserve the local key and user ID. A binding
acknowledgement is followed by a separate connection and contact-state check.

## Companion integrations

[Home Assistant and SmartThings setup](../integrations/homeassistant/meross-msg200.md)
covers the Meross LAN component, HA cover entities and SmartThings MQTT settings.
