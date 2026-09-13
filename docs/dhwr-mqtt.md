# DHWR MQTT switch setup

ST-MQ starts and stops domestic hot-water recirculation. Configure a **switch**
with separate ON and OFF actions in the MQTT-to-device integration. Remove the
old SmartThings push-button action and its fixed ten-minute duration from this
path. No device setup or live commands are performed by installing this code.

The private configuration supports:

```json
{
  "mqtt": { "dhwr_topic": "from_stmq/dhwr/set" },
  "controller": { "dhwr_duration_minutes": 10 }
}
```

Keep the existing broker address and authentication settings. The topic must be
an exact topic, without MQTT wildcards. ST-MQ sends the literal uppercase string
`ON` to start, then `OFF` after the configured duration (1–60 minutes). Messages
use QoS 1 with retain disabled. Configure the receiving integration to set the
switch idempotently: duplicate ON messages must not create independent timers.
The old `from_stmq/heat/action` `heaton60` button message is no longer published.
The equipment card's **Start circulation** action uses the same ST-MQ timer as automation.
Reload settings to apply a new duration; an existing run is stopped through the
normal runtime restoration before the new configuration starts.

The deadline starts when ON delivery completes; subsequent heating command or
H66 readback latency does not extend it. ST-MQ saves an OFF obligation before
attempting ON, because a lost broker acknowledgement can still mean delivery.
The expiry timer sends OFF without waiting for the next control tick. Shutdown,
control restoration and restart also send OFF. Failed OFF delivery remains
pending and is retried while ST-MQ owns control. Turning off automatic control
restores equipment; monitoring/shadow mode never starts a new automatic run.
In a paired installation, a demoted instance stops sending commands; its saved
obligation is handled by the instance that owns control on restoration.

A stopped process or unreachable broker cannot deliver OFF. Set the device's
own maximum-on watchdog, if supported, above the longest configured ST-MQ run
as an independent failsafe, and set its power-on state to OFF. This watchdog is
not the normal run-duration control. Verify ON, timed OFF and restart restoration
on the installed device before enabling active control.

## Live SmartThings feedback

Configure the SmartThings-to-MQTT integration to report the actual switch value
and measured pump power. The MQTT device and rules remain responsible for
publishing those reports; ST-MQ subscribes to the configured topics. The
SmartThings switch must expose separate ON/OFF actions, with the normal run
duration owned by ST-MQ as described above.

Add this entry to the existing `equipment.devices` list, replacing the invented
topic with the one used by your integration:

```json
{
  "id": "dhwr",
  "label": "Hot-water circulation",
  "area": "home",
  "kind": "switch",
  "connection": "mqtt:example/dhwr/status",
  "record": false,
  "max_age_seconds": 120,
  "mqtt": { "state_path": "switch" },
  "readings": [
    { "key": "power", "label": "Pump power", "unit": "W", "path": "power", "record": false }
  ]
}
```

For this mapping, publish a non-retained JSON report such as
`{"switch":"on","power":24.5}` when running and
`{"switch":"off","power":0}` when stopped. Publish switch changes immediately
and refresh the combined report at least once a minute while monitoring, so the
two-minute freshness limit remains useful. State also accepts `ON`/`OFF`, JSON
booleans, or numeric 1/0. Power must be numeric, with its declared unit `W` or `kW`;
it is never treated as switch confirmation or proof of water flow.

If switch and power arrive on different topics, set the power reading's `topic`
to its exact topic. For a plain numeric power payload, omit its `path`. For a
plain switch payload, omit `mqtt.state_path`. Safe dotted JSON paths can select
nested fields, for example `state.switch`. Optional `mqtt.timestamp_path` selects
a UTC epoch-millisecond timestamp or an ISO timestamp with an explicit timezone.
Without a source timestamp, a new report uses its receive time.

The `dhwr` entry is for feedback only: do not enable `switch_control` or
`tariff_control` on it. Circulation's own Start/Stop actions use the executor's
timed command path, including pending-OFF recovery. Command, state and separate
power topics must be distinct. If the integration supports a read-only status
request, configure `mqtt.request_topic` and `mqtt.request_payload`; the request
topic must also differ from `mqtt.dhwr_topic`. Event publishers without a request
endpoint cannot be made to answer by rechecking them.

**Stop** is also available when a fresh report shows the switch ON without an
ST-MQ run, such as a switch started through SmartThings. That explicit OFF uses
the same durable delivery/retry path. Its broker acknowledgement remains
separate from the reported switch becoming OFF.

The equipment card shows reported switch state and live watts alongside the
requested run. Missing power does not hide an otherwise valid switch report.
Retained messages, expired reports and disconnected sources do not confirm a
current switch state. An ON/OFF report describes the switch, not water flow; a
broker acknowledgement describes delivery, not switch state. Full connection
topics are available in the device connection details.

DHWR feedback stays in memory (`record: false` is also its default). Neither
state samples nor power samples are written as database time series. Actual ON
periods are not persisted in this version. Existing requested circulation history
continues to be recorded: the chart shows **requested** circulation, clipped by
recorded OFF requests. Imported historical CSV `heaton60` pulses keep their
original ten-minute interpretation. This changes neither the committed learning
algorithm nor imported CSV provenance.

A private `equipment.devices` override replaces the complete public list; retain
the other equipment entries when adding this one there. No feedback subscription
is created until the `dhwr` entry is configured and enabled.
