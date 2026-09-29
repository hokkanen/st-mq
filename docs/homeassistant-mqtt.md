# Home Assistant MQTT publishers

[The automation factory](../integrations/homeassistant/mqtt-feeds.js) creates
three independent publishers: two garage contacts from `meross_cloud` cover
entities and an optional garage air-temperature feed from an external Shelly
sensor in HA. Source entity identifiers are supplied privately, never embedded
in the repository. These automations publish observations and answer cache
queries; they do not operate doors or force device refreshes. The same factory
also creates separate cover-command handlers for SmartThings and ST-MQ controls.

## Topics and payloads

| Feed | Prefix | State topic suffix | Value |
| --- | --- | --- | --- |
| Door 1 | `stmq/garage/door1` | `/status/contact` | `open` / `closed`, or `null` when unknown/unavailable |
| Door 2 | `stmq/garage/door2` | `/status/contact` | `open` / `closed`, or `null` when unknown/unavailable |
| Optional garage air | `stmq/garage/air` | `/status/temperature` | Numeric Celsius; unavailable values remain unknown |

Each prefix also provides:

- `/command`: accepts `status_update`, QoS 1, without retention.
- `/availability`: retained `online` / `offline`, QoS 1.

HA's existing `homeassistant/status` topic supplies separate bridge availability
through its MQTT birth and last-will messages. The custom publishers have no timer
or heartbeat.

State reports use QoS 1 without retention. An illustrative door snapshot is:

```json
{
  "value": "closed",
  "unit": "state",
  "timestamp": "2026-09-14T10:00:00Z",
  "published_at": "2026-09-14T10:30:00Z",
  "available": true,
  "cover_state": "closed"
}
```

Temperature snapshots use a numeric `value` and `unit: "C"`. `timestamp` comes
from the source entity's original `last_reported`; `published_at` is the bridge's
publication time. The timestamp describes HA's latest source report, not an
independently verified physical measurement. Repeated snapshots keep the same
timestamp until the source entity reports again. The `available` field describes
the snapshot; ST-MQ uses the separate availability topic for its availability gate.
`cover_state` preserves HA's `open`, `closed`, `opening` or `closing` state.
The contact `value` still means closed versus not closed; it does not measure
position or certify that opening has completed.

## Publication and recovery

Each automation publishes on source state or attribute changes, HA startup,
MQTT birth (`homeassistant/status` becoming `online`) and its status query. A
normal publication sends source availability followed by the contact or
temperature snapshot. HA shutdown publishes offline. HA's MQTT last will exposes
loss of the bridge connection. A publisher that stops while HA remains connected
has no periodic deadline; Recheck can detect an unanswered query.

Status queries read HA's existing state. They prove that the publisher answered;
they do not poll the physical contact or establish a periodic temperature
measurement interval. An unavailable source cannot be converted to a closed door.
HA connectivity and source entity availability also remain distinct from the
physical device's last communication.

ST-MQ requests status after its response subscriptions succeed on startup or
reconnect, and during Recheck. With child availability configured, a live child
online report is required; retained child online cannot establish availability.
Availability and state may arrive in either order. A retained state alone cannot
complete Recheck.

Configure `mqtt.bridge_availability_topic: "homeassistant/status"` to invalidate
the source on HA `offline`, including retained offline. Live bridge `online`
requests status after an outage without duplicating an in-progress request.
Retained bridge online is connectivity context and cannot renew a source reading.
If no bridge status is initially available, a live child online report and state
reply can establish availability. ST-MQ resets bridge status on its own reconnect.

Both default door entries use `max_age_seconds: 0`, `mqtt.state_path: "value"`,
`mqtt.timestamp_path: "timestamp"`, their command/availability topics and
`mqtt.bridge_availability_topic: "homeassistant/status"`. Confirmed event-driven
contacts remain usable in equipment display and history without an age
expiry. Source, bridge and broker outages invalidate them immediately. Recovery
requires a live source availability report and a live snapshot, preserving the
original source timestamp while starting a new availability span. A query timeout
also invalidates the source; it cannot keep silently disconnected contacts usable.
Openings and outages break closed-door continuity even when both happen between
temperature reports. The model records that compact evidence and excludes affected
learning/validation intervals. Unknown configured door status blocks a new garage
heating pause, and an open door blocks a start below 2°C outside. During an existing
pause, independent temperature/reserve protection determines restoration. The explicit garage
algorithm epoch is described in [reconstruction and versioning](reconstruction-and-versioning.md).

## Door commands

Each door accepts plain `open` and `closed` on
`stmq/garage/door1/command/cover` or `stmq/garage/door2/command/cover`.
Commands use QoS 1 with retention disabled. The separate `/command` endpoint
continues accepting only the read-only `status_update` request.

The operation handlers call HA's explicit `cover.open_cover` / `cover.close_cover`
actions. They check source availability and the source's advertised capabilities
before dispatch. A `stop` branch calls `cover.stop_cover` only if HA advertises
Stop support. Both currently installed Meross entities support Open and Close only;
neither supports Stop or percentage positioning. No toggle pulse emulates Stop.

ST-MQ enables the door buttons with `cover_control: true`, `mqtt.command_topic`,
`mqtt.open_payload: "open"`, `mqtt.close_payload: "closed"` and
`mqtt.cover_state_path: "cover_state"`. Add `mqtt.stop_payload: "stop"` only for a
source that actually supports it. Buttons show only configured actions. Requests
are sent once, without retaining or replaying them after a disconnect. A broker
acknowledgement is labelled as a sent request; only a subsequent qualifying HA
state report can mark the requested state observed. Neither proves independent
physical end-stop sensing beyond what the HA integration reports.

After a command attempt the HA handler requests a status snapshot, including when
an unsupported Stop was ignored or a service call failed. This can correct an
optimistic SmartThings display; the snapshot is not a command receipt. Handlers
never wait for full travel before allowing another supported action.

HA's MQTT automation trigger does not expose the MQTT retained flag, so command
publishers must keep retention disabled. Installation clears any retained value on
the new command topics before enabling their handlers.

## SmartThings door settings

| Field | Door 1 | Door 2 |
| --- | --- | --- |
| Subscribe Topic | `stmq/garage/door1/status/contact` | `stmq/garage/door2/status/contact` |
| Expected Message Format | JSON | JSON |
| JSON Key | `value` | `value` |
| Shade OPEN Value | `open` | `open` |
| Shade PAUSE Value | `stop` (unsupported by current opener) | `stop` (unsupported by current opener) |
| Shade CLOSE Value | `closed` | `closed` |
| Publish Changes | Enabled | Enabled |
| Publish Topic | `stmq/garage/door1/command/cover` | `stmq/garage/door2/command/cover` |
| Publish QoS | 1 | 1 |

The MQTTDevices shade driver uses the JSON setting only for incoming messages;
outgoing commands remain the configured plain strings. Its own button handling
updates its virtual state optimistically, so read the later HA contact report as
feedback. SmartThings Refresh resubscribes; it does not send `status_update`.

## Optional temperature consumer

The air publisher does not change ST-MQ's selected garage temperature source.
Native Shelly MQTT remains the default. This disabled example shows the optional
HA route for the existing rear temperature signal:

```json
{
  "id": "garage_air",
  "label": "Garage air via HA",
  "area": "garage",
  "kind": "temperature",
  "signal": "garage_temperature",
  "enabled": false,
  "connection": "mqtt:stmq/garage/air/status/temperature",
  "max_age_seconds": 120,
  "mqtt": {
    "state_path": "value",
    "timestamp_path": "timestamp",
    "request_topic": "stmq/garage/air/command",
    "request_payload": "status_update",
    "availability_topic": "stmq/garage/air/availability",
    "bridge_availability_topic": "homeassistant/status"
  }
}
```

Before selecting this route, verify genuine source reports satisfy the garage's
two-minute freshness requirement and that the sensor represents the intended
protection location. Replace the existing route for that signal when enabling it.
A change-only feed can become stale while HA remains online. Queries containing
cached source timestamps cannot extend temperature validity.

## Installation and migration

Generate the three definitions with the private source entity identifiers and
install them alongside the existing automations. The previous status publishers
remain available for separate production consumers until their migration starts.
The four legacy door automations are unchanged. The legacy temperature automation
uses its source state trigger instead of a minute timer, preserving its source,
topic, payload and retention. No minute temperature publisher remains. The new
topics can be verified with read-only status requests, including source timestamps,
availability and query replies, without moving either door.

The two new cover handlers are separate from those publishers. The four older
open/close handlers on `to_hass/garage_doorN/action` remain until SmartThings moves
to the new command routes. Remove old status publishers only after their readers
migrate, and old command handlers only after their writers migrate. Changing one
direction does not migrate the other.

Private configuration and automation backups belong in
`~/.config/st-mq/ha-door-migration` and `~/.config/st-mq/ha-door-controls`, with directory mode `0700` and file mode
`0600`. Do not copy household entity identifiers or exported automations into Git.
See the [topic migration guide](mqtt-topics.md) for the separate manual SmartThings
changes and ST-MQ cutover steps.
