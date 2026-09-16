# MQTT equipment

Equipment is inside **Home → Sensors & Equipment** and **Garage → Sensors & More
equipment**, with manual controls and live feedback in each fold. Garage's charger
cards sit separately below its heating summary. Each device
has one explicit connection string. ST-MQ does not guess protocols, search the LAN,
or switch to another source when a device stops responding.

- `shelly:stmq/garage/temperatures` selects native Shelly MQTT. The part after
  `shelly:` is a topic **prefix**; ST-MQ derives the native status and command topics.
- `mqtt:home/door/state` selects the standard MQTT handler. The part after `mqtt:`
  is an **exact reading topic**. The device kind determines whether it carries a
  temperature, watts, an open/closed door state, or an on/off switch state.

The MQTT device entries and topic defaults live in the public `config.json`
`options.equipment` section. Broker credentials remain in the private configuration
file shown by **Data & settings → Configuration**. Device topics do not
need to be repeated in that file. A private `equipment.devices` override replaces
the complete public list; arrays are not merged by device ID.

## Device entries

```json
{
  "equipment": {
    "poll_seconds": 30,
    "max_age_seconds": 120,
    "devices": [
      {
        "id": "garage",
        "label": "Garage temperatures",
        "area": "garage",
        "kind": "temperature",
        "connection": "shelly:stmq/garage/temperatures",
        "signal": "garage_temperature",
        "temperature_id": 100,
        "readings": [
          {
            "key": "temperature_2",
            "label": "Garage temperature 2",
            "signal": "garage_temperature_2",
            "unit": "degC",
            "component": "temperature:101",
            "required": false
          }
        ]
      },
      {
        "id": "caravan",
        "label": "Caravan",
        "area": "garage",
        "kind": "metered_switch",
        "connection": "shelly:stmq/garage/caravan",
        "switch_control": true
      },
      {
        "id": "garage_door1",
        "label": "Door 1",
        "area": "garage",
        "kind": "door",
        "connection": "mqtt:home/door/state"
      }
    ]
  }
}
```

Use a stable device `id` and signal names so changing a display label does not
create a new history series. Device kinds are `temperature`, `door`, `switch`,
`metered_switch` and MQTT-only `power`. The kind describes the readings; write access
requires `switch_control: true`, `cover_control: true` for a door, or
`tariff_control: true` for the home's reduction relay. A discovered output is
never automatically made writable.
`enabled: false` keeps an entry inactive. Add future equipment once its actual
device capabilities and intended measurements are known.

The garage addon uses external sensor 100 as the existing rear probe. Sensor 101
is the front probe: its absence does not erase the rear reading, but both fresh
protection readings are required for [garage pauses](garage.md). Set its physical label
once installed, and change the component mapping if the device assigns a different
ID. The relay's internal electronics temperature is not the garage temperature.
There is one garage temperature entry. Its connection selects either the native
Shelly prefix or one standard MQTT topic. ST-MQ does not configure or subscribe to
an alternative route.

Additional readings can specify a `signal`, `label`, `unit`, and either a native
`component` with a `path` within that component, or an MQTT `topic`/JSON `path`.
Scaling and offset are explicit advanced settings. For native devices, the main
switch and temperature readings use `switch_id` and `temperature_id`; additional
mappings cannot replace those built-in signals. For standard MQTT, a mapping whose
signal matches a built-in power/current reading replaces its field path while
preserving the unit. An optional reading that has never arrived does not invalidate
unrelated measurements. Home indoor signals
retain their existing reporting and learning contract. Garage readings feed their
own learning/protection model and never enter the Home temperature average.

## Configure a Shelly

1. Open the device's local web interface and its MQTT settings.
2. Enable MQTT. Enter the broker host, port, and the device's broker credentials.
   These may be a separate broker account from ST-MQ's account, with permission to
   exchange the relevant topics. Configure certificate settings if the broker
   uses TLS. ST-MQ itself keeps its broker login in private `mqtt.address`,
   `mqtt.user` and `mqtt.pw` settings.
3. Set a unique MQTT topic prefix matching the `shelly:` entry. The `shelly:` marker
   belongs only to ST-MQ configuration; do not paste it into the Shelly prefix field.
4. Enable RPC over MQTT where the firmware exposes that option, RPC status
   notifications (`rpc_ntf`) and component status notifications (`status_ntf`).
   Older modern firmware may provide MQTT RPC without a separate `enable_rpc`
   checkbox. Apply the settings and reboot only if requested by the device.
5. Enable any attached addon sensors in the device UI. Keep existing integrations,
   cloud settings and unrelated schedules as configured. Ensure independent
   automations do not fight an output deliberately assigned to ST-MQ control.
6. Apply ST-MQ configuration and use **Recheck connections**. Check the displayed
   measurements and source **Shelly** before using a manual control.

No device administrator password is needed by ST-MQ for native MQTT RPC. The local
administrator login and the MQTT broker login are separate mechanisms. ST-MQ needs
broker permission to publish native requests and subscribe to device status and
its temporary reply topic. No additional script on the Shelly is required.

Modern devices default to the RPC protocol used by generations 2–4. For original
Gen1 hardware specify `generation: 1`, its complete native prefix, and the external
sensor index if used. Gen1 uses native scalar topics instead of RPC and can only
confirm relay state through a subsequent live publication. Original metering plugs
may estimate current from power; estimates must not be confused with measured amps.

References: [Shelly MQTT configuration](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Mqtt/),
[RPC channels](https://shelly-api-docs.shelly.cloud/gen2/General/RPCChannels/),
[authentication](https://shelly-api-docs.shelly.cloud/gen2/General/Authentication/),
[original device API](https://shelly-api-docs.shelly.cloud/gen1/).

## Standard MQTT devices

A plain temperature number, a `power` number in watts and `open`/`closed` door
payloads need no JSON mapping. MQTT `power` entries provide `<device-id>_power` in
W and have no switch state or command control.
Structured payloads can select a property with `mqtt.state_path`; a source timestamp
can be selected with `mqtt.timestamp_path` as UTC epoch milliseconds or an ISO string
with an explicit timezone. Without mappings, a metered switch accepts
`{"value":true,"power":0.25,"current":1.1,"energy":123.4}`: power is kW,
current is A, and `energy` is the cumulative kWh counter, not a daily reset display.

For a different cumulative field, add a reading with `key: "energy_counter"`,
its exact `path`, and `unit: "Wh"` or `"kWh"`. For example:

```json
{
  "key": "energy_counter",
  "label": "Meter total",
  "path": "meter.total_wh",
  "unit": "Wh"
}
```

A standard MQTT mapping can add an exact `topic` when that counter arrives
separately. A native mapping instead names a `component`, such as `switch:0`,
and its field path, such as `aenergy.total`. Optional `scale` and `offset` apply
before converting the declared unit to kWh. Once a counter mapping is configured,
it is the sole counter used for hourly accumulation; missing mapped data does not
fall back to another field. The live counter is shown separately from energy today.

A generic switch requires a separate command topic and distinct `mqtt.on_payload`
and `mqtt.off_payload`. The handler waits for a new matching state publication;
a broker acknowledgement is not confirmation of the output. Use
`mqtt.availability_topic` or a configured heartbeat if the publisher provides one.
When availability is configured, a live online message is required alongside live
readings; retained online alone cannot restore the device. Bridges can additionally
use `mqtt.bridge_availability_topic` with `online` / `offline` payloads to invalidate
their child devices on a bridge outage and request recovery after a live online
message. See [Home Assistant publishers](homeassistant-mqtt.md) for a change-driven
example without a timer or heartbeat.
An optional read-only request requires its own explicitly configured topic and
payload. ST-MQ never guesses that publishing to a sensor topic will request status.
For a publisher that actually implements a read request, configure its documented
mapping, for example `mqtt.request_topic: "example/device/get"` and
`mqtt.request_payload: "status"`. These are invented examples, not a universal MQTT
command. Requests use QoS 1 without retention and are also sent automatically once
all of the device's response subscriptions succeed on startup or reconnection.
There is no automatic periodic polling of generic MQTT publishers.
A sensor that only publishes changes or scheduled reports cannot be made
to answer by adding an arbitrary request topic.

Set `record: false` on an MQTT `switch` or `power` entry to keep its readings
in live monitoring without adding database samples. Additional MQTT readings can
individually use `record: false`; primary temperatures and cumulative energy
counters retain their recording contracts. Native Shelly entries do not accept
`record: false`. DHWR feedback is always live-only. The public defaults enable
`dhwr` as `kind: "power"` on `mqtt:stmq/home/dhwr/status/power`, with `record: false` and
`max_age_seconds: 0`. Its SmartThings Rule publishes event-driven watts; ST-MQ
owns the separate timed ON/OFF command path. See the
[DHWR Rule, template and feedback setup](dhwr-mqtt.md).

MQTT power feeds also default to an event-only maximum age of zero. The UI shows
last reported watts with the original receive time while connected; this does
not establish a reporting cadence or detect an upstream silent failure.
Disconnecting invalidates the reading, and DHWR requires a new non-retained
report after reconnection or restart. Choose a positive maximum age only after
verifying genuine periodic reports. Plain power is a measurement, never implicit
ON/OFF confirmation.

Door feeds can report only changes. For those, the default maximum age is zero:
confirmed state remains usable without an age expiry. Disconnection, unavailable
sources and failed queries make the current state unknown, while preserving the
last reported value and time as context. A retained value is historical context,
not proof that the door is currently closed. Invalid payloads show unknown state.
For JSON snapshots from a bridge, configure `mqtt.timestamp_path` to preserve the
source state's timestamp. A missing or invalid configured timestamp invalidates
the reading instead of substituting the bridge's publication time. A live response
can restore an event-only last-known state without establishing a new physical
measurement. Bridge availability and sensor availability remain separate evidence.
The garage model uses the same event-driven validity and records closed-door
continuity, so brief openings or outages cannot disappear between samples.

Controllable MQTT doors require `cover_control: true`, a separate
`mqtt.command_topic`, distinct `mqtt.open_payload` / `mqtt.close_payload`, and
optionally `mqtt.stop_payload` for an actual supported Stop action. The default
HA doors use `open` / `closed` on `stmq/garage/doorN/command/cover`, with
`mqtt.cover_state_path: "cover_state"` for movement and terminal-state reports.
Their cards expose Open and Close; Stop appears only when explicitly configured.
Commands are non-retained QoS 1 requests and are not replayed after failure.
The UI distinguishes sending, sent and subsequently reported state; it never
changes the contact value optimistically. See [HA setup and SmartThings fields](homeassistant-mqtt.md).

Use different exact topics for different publishers and for status versus commands.
MQTT does not assign source priority to publishers sharing a topic. Each configured
measurement has one selected connection and recorded signal; there is no backup
feed, automatic source comparison or takeover.

Room reports have a 70-minute expected interval plus five minutes of grace. At
75 minutes they become outdated and stop contributing to learning. The garage
uses the same deadline rule with a two-minute limit for both connection formats.
Successful room-topic subscriptions can restore a recent genuine reading after
a connection failure when its saved route signature matches. This does not
renew its timestamp or erase the outage. Older unsigned readings require one
new genuine report before they can be recovered on a later reconnect.
ST-MQ requests status every 30 seconds from any Shelly supplying
`garage_temperature` or `garage_temperature_2`, including custom component
mappings. Each device has its own polling clock; an unrelated Shelly's configured
polling interval does not change the garage schedule. Garage Shelly readings
expire after at most two minutes, including when a device is configured with a
longer or unlimited equipment age. Reporting metadata records this effective
cadence and grace. A full reply with one missing or errored probe cannot refresh
that probe from the other readings. Standard MQTT equipment
with a finite deadline must provide genuine periodic reports, preferably every
minute for a two-minute deadline, even when the value is unchanged. Broker connectivity, generic heartbeats and repeated source
timestamps cannot extend measurement validity.

## Rechecks, controls and recording

**Recheck connections** and per-device **Recheck** use the configured protocol while
keeping a healthy broker connection open. Native Shelly devices receive a status
request; modern devices must send its matching RPC reply. For ordinary MQTT,
ST-MQ resubscribes to the exact configured state, extra-reading, availability and
heartbeat topics and checks the broker's subscription acknowledgement. A rejected
subscription appears unavailable and can be retried without reconnecting unrelated
devices.

If a generic device has a configured status request, ST-MQ sends it after refreshing
subscriptions and waits for fresh reports for every required reading. Split state
and power topics can arrive separately; the first packet does not finish the check.
A broker publish acknowledgement or retained replay cannot count as the live reply.
The request times out when the required readings do not arrive.

Without a configured request, a successful recheck means ST-MQ is **listening**.
A retained-only result means the broker supplied historical context. An already
usable value stays **last reported**, preserving its original observation time.
None of these claims that the publisher has just responded. Its next genuine report
updates live monitoring as usual. Rechecking never operates a relay, changes device
settings, changes protocol, or renews a measurement's validity.

Each device's connection details show complete MQTT topics and their roles,
including native Shelly status, RPC request and temporary reply topics. Generic
MQTT also exposes last live/retained packet receipt and subscription status, so a
quiet publisher can be distinguished from a missing broker route. Command payloads,
broker credentials and native hardware identities are not exposed in diagnostics.
Additional connection groups list configured H66, legacy temperature, TeslaMate
and heating command topics. A reading owned by the equipment catalogue appears
under its equipment entry instead of being repeated as a legacy temperature feed.

Manual controls show current feedback alongside their actions. Ordinary switch
controls require a fresh state and confirm the new output through live readback;
they do not schedule a reversal. DHWR circulation retains its configured run length
and automatic OFF through ST-MQ's durable executor and the MQTT switch integration. Legacy timed tests keep their saved original
state and route until restoration completes; configuration cannot discard an
unresolved restoration. Explicit manual controls can operate equipment in shadow
mode; automatic control stays subject to the application's mode and controller
authority.

The Caravan reports on/off, kW, A and energy today in live monitoring. Only its
hourly energy is recorded in the database and offered in the chart. Successive
cumulative meter readings produce completed UTC-hour kWh
intervals. Daily totals use Europe/Helsinki, including daylight-saving boundaries.
The unfinished hour is saved as a checkpoint and contributes to the daily display;
it appears as an hourly chart interval after completion. Outages, first partial days
and counter resets retain partial coverage. No outage energy is invented.

The chart includes all configured home/garage probes through **All home
temperatures**, door states and Caravan hourly energy. Tariff status already comes
from heating control; duplicate relay-state datasets are not recorded. The
[garage adapter](garage-adapter.md) keeps optional native temperatures live-only,
records qualified dedicated electrical intervals, and retains used learning inputs
in its own versioned journal. Retired
development datasets and their recorder caches are removed at startup; immutable
learning records and imported history are preserved.

## Moving from the earlier configuration

The earlier fixed `shelly.garage`, `shelly.heat_savings`, `shelly.caravan` settings and
individual `mqtt.*_temperature_topic` settings are legacy configuration. Move their
connections to `equipment.devices` and remove the redundant private topic entries.
Never leave two acquisition paths configured for the same physical reading.
Credentials and unrelated private settings do not need to move. The public defaults
use the direct Shelly route for garage temperatures, tariff control and Caravan.
