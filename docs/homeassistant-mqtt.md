# Home Assistant MQTT publishers

[The automation factory](../integrations/homeassistant/mqtt-feeds.js) creates
three independent publishers: two garage contacts from `meross_cloud` cover
entities and an optional garage air-temperature feed from an external Shelly
sensor in HA. Source entity identifiers are supplied privately, never embedded
in the repository. These automations publish observations and answer cache
queries; they do not operate doors or force device refreshes. The same factory
also creates separate cover-command handlers for SmartThings and ST-MQ controls.

These are Home Assistant Core automations. Installing the ST-MQ app does not
install them. First configure the [MQTT integration](https://www.home-assistant.io/integrations/mqtt/)
under **Settings → Devices & services** and connect it to the same broker as
ST-MQ. Configure ST-MQ's broker login separately in its saved app options. Keep
Home Assistant's birth/will topic `homeassistant/status` with payloads `online`
and `offline`: the generated triggers and default bridge availability use it.
If that topic has been customized, update both the generated definitions and
ST-MQ's matching bridge topic before enabling the publishers.

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
Door observations supply the live equipment display and recorded contact history.
Garage uses manual Normal/Away targets and independent device-local frost
protection; there is no Garage economic controller or learned model. A door
contact does not grant heating-control authority or confirm pump protection.
See [Garage heating](garage.md).

## Door commands

Each door accepts plain `open` and `closed` on
`stmq/garage/door1/command/cover` or `stmq/garage/door2/command/cover`.
Commands use QoS 1 with retention disabled. The separate `/command` endpoint
continues accepting only the read-only `status_update` request.

The operation handlers call HA's explicit `cover.open_cover` / `cover.close_cover`
actions. They check source availability and the source's advertised capabilities
before dispatch. A `stop` branch calls `cover.stop_cover` only if HA advertises
Stop support. The public ST-MQ configuration exposes Open and Close only.
Check the installed cover's capabilities before enabling Stop; no toggle pulse
emulates it and the bridge does not provide percentage positioning.

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

Before selecting this equipment/history route, verify genuine source reports
satisfy the configured freshness limit and represent the stated location. Replace
the existing route for that signal when enabling it. This optional HA feed does
not replace the pump controller's native BTHome regulation or sender frost
protection. A change-only feed can become stale while HA remains online. Queries
containing cached source timestamps cannot extend temperature validity.

## Installing the automations

Generate one `garageMqttAutomation({ id, label, sourceEntity, prefix, kind })`
per source. Use `kind: "contact"` and the door prefixes above for each cover;
the optional `sensor.*` air source uses `kind: "temperature"`. Generate a separate
`garageCoverAutomation({ id, label, sourceEntity, prefix })` for each door whose
commands you intend to expose. IDs must be unique lowercase identifiers.

The builders return ordinary automation objects with `triggers`, `conditions`
and `actions`. Generate them on a development computer with Node and this
checkout, using privately maintained entity mappings. Import each object as one
automation through **Settings → Automations & scenes → Create automation →
Create new automation → ⋮ → Edit in YAML**. JSON objects are valid YAML; paste
one complete automation object, not an array of all the objects. Save and inspect
its trace after a read-only `status_update` query. Alternatively, merge the
objects as individual entries into the existing `automations.yaml` list and
reload automations. Do not replace unrelated automations. See Home Assistant's
[automation editor instructions](https://www.home-assistant.io/docs/automation/editor/).

Install and verify status publishers before command handlers. Clear any retained
message on a `/command/cover` topic before enabling its handler; the HA MQTT
trigger does not expose the retained flag. Status requests must not be retained.
Verify source timestamps, availability and query replies without moving a door.
Only then enable the explicitly configured movement controls and check them as
a separate installation test.

If another system still uses older MQTT topics, coordinate its publishers and
subscribers separately. Retire each external route after its consumers move;
ST-MQ accepts only the currently configured protocol. Installing these
Home Assistant automations does not change ST-MQ's saved options or restart it.

Keep generated automations, source entity mappings and pre-edit backups outside
Git, in a private directory with mode `0700` and files with mode `0600`. See the
[topic cutover guide](mqtt-topics.md) for the separate manual SmartThings changes.
