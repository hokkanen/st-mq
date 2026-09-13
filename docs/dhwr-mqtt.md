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

## SmartThings power forwarding Rule

The **DHWR power to MQTT** Rule forwards the physical circulation relay's
`main.powerMeter.power` attribute to a separate MQTT Energy virtual device.
The MQTT publisher uses the
[MQTT Devices Edge driver](https://github.com/toddaustin07/MQTTDevices).
This Rule publishes measured watts; it supplies neither the switch's ON/OFF
state nor the commands that start and stop circulation.

| Step | Definition |
| --- | --- |
| Trigger source | The physical DHWR relay, component `main`, capability `powerMeter`, attribute `power`, with `trigger: "Always"` |
| Condition | `greaterThanOrEquals` against numeric `0`, with `changesOnly: false` |
| Destination | The separate MQTT Energy device, component `main`, capability `partyvoice23922.setpower`, command `setPower` |
| Argument | A device operand reading the same physical relay's `main.powerMeter.power`; no fixed value or conversion |
| MQTT output | Exact topic `to_stmq/dhwr/power`, plain numeric watts such as `24.5` or `0`, QoS 1, retain disabled |

The condition includes zero so a stopped pump can report its measured power.
It remains true for positive readings instead of waiting for another threshold
crossing. Do not wrap it in `changes` or compare the source against the virtual
device: that would discard useful equal-value reports. `trigger: "Always"`
selects the physical power attribute as a trigger; it does not poll the relay.
See the [SmartThings Rules documentation](https://developer.smartthings.com/docs/automations/rules).

`changesOnly: false` prevents the Rule's comparison from intentionally requiring
a value change. It cannot force the physical driver or SmartThings event path
to emit another event for an unchanged measurement. A successful device refresh
or a newer cloud attribute timestamp does not by itself establish automatic
forwarding. This setup has no verified periodic, unchanged-value reporting cadence.
Do not schedule manual Rule execution to manufacture a heartbeat from cached power.

### Configure the publisher and recreate the Rule

Use the physical relay's device ID as the source and the separate MQTT Energy
device ID as the destination. Verify their current identities, profiles and
capabilities in the same SmartThings location; display labels can be renamed.
The source must report watts. The destination's `setPower` command accepts a
number in the range 0–100000; this template is for a nonnegative pump load,
not a signed import/export meter. It does not forward cumulative `energyMeter`
readings or convert kW to W.

Configure the MQTT Energy device in the SmartThings app's device Settings:

| Preference ID | Selection |
| --- | --- |
| `ppublish` | `true` — enable power publishing |
| `ppubtopic` | `to_stmq/dhwr/power` |
| `punitsset` | `watts` |
| `qos` | `qos1` |

Configure the broker on the MQTT Device Creator as required by that driver, and
confirm its connection status. Changing ST-MQ configuration does not configure
this publisher. Verify preferences after saving them; the available device
preferences API rejected attempted writes with HTTP 405, so use the app's
settings flow for this installation.

The driver's [`handle_setpower`](https://github.com/toddaustin07/MQTTDevices/blob/main/hubpackage/src/cmdhandlers.lua)
publishes the numeric command argument as a string whenever power publishing is
enabled and the MQTT client is ready. It does not wait for the virtual device's
stored value to change. The units preference affects its displayed power; it does
not convert the published string. Keep watts throughout this route. The command
handler does not buffer a missing MQTT connection for later measurement replay.

Copy [dhwr-power-rule.template.json](smartthings/dhwr-power-rule.template.json)
to a private file. Replace both `REPLACE_DHWR_RELAY_DEVICE_ID` occurrences and the
`REPLACE_MQTT_ENERGY_DEVICE_ID` occurrence with the verified mapping. The template
contains no account, location, hub or device identifiers and deliberately omits
server-generated fields such as Rule ID, status and execution location.

Use an authenticated SmartThings CLI. Save requests and responses outside Git
with private directory mode `0700` and file mode `0600`; set `umask 077` first.
The following are command templates: replace angle-bracket placeholders and
capture stdout and stderr in private files, since the results contain identifiers.

```text
smartthings rules --location <location-id> --json
smartthings rules:create --location <location-id> --input <private-rule.json> --json
smartthings rules <rule-id> --location <location-id> --json
smartthings devices:preferences <mqtt-energy-device-id> --json
```

Inspect existing Rules before creating a replacement to avoid duplicate publishers.
Save the returned Rule ID and submitted JSON. Compare the installed `name` and
`actions` with the private request and check `status: "Enabled"`. The verified
installation reports `executionLocation: "Local"`; read this field after changes,
since execution placement depends on the devices and services involved. Rule
creation and publisher configuration are separate from ST-MQ subscriptions.

### Verify automatic delivery

Check these separately:

1. The installed Rule has the intended source in both device operands, the
   separate destination, the nonnegative comparison and the numeric argument.
   Check source/destination health, source units and publisher preferences too.
2. A manual Rule execution can test the destination command and MQTT transport.
   It forwards cached source state, so an arrival proves only that command path;
   it is not a new physical measurement or an automatic trigger test.
3. During a normal circulation run, observe a genuine physical power event and
   its automatic non-retained MQTT arrival with the same numeric watts, including
   a zero report after stopping. Correlate private source/event and MQTT captures.
   A successful Rule response or `ONLINE` device health alone is insufficient.
4. Treat identical-value repetition and periodic delivery as unverified until
   several genuine reports demonstrate them. An unchanged refresh that produces
   no MQTT arrival is not evidence of a heartbeat. Fix upstream report/event
   emission before choosing a finite ST-MQ freshness deadline.

The setup check reached MQTT with a manual Rule execution, but did not establish
automatic delivery from the unchanged-value refresh. No physical switch operation
was performed as part of the subsequent read-only Rule verification.

## Live power in ST-MQ

The public defaults already contain this enabled monitoring entry:

```json
{
  "id": "dhwr",
  "label": "Hot-water circulation",
  "area": "home",
  "kind": "power",
  "connection": "mqtt:to_stmq/dhwr/power",
  "enabled": true,
  "record": false,
  "max_age_seconds": 0,
  "mqtt": {},
  "readings": []
}
```

`kind: "power"` supplies the built-in `dhwr_power` reading in watts. A plain
numeric payload needs no JSON path or extra reading mapping. The equipment card
shows the last reported watts and their receive time alongside the requested
run. Power is not interpreted as switch confirmation or proof of water flow.

`max_age_seconds: 0` is an explicit event-only policy: while connected, the last
reported value remains available with its original timestamp until replaced.
It does not establish a current measurement or detect a silent upstream failure.
Disconnecting invalidates the reading, and reconnecting or restarting needs a new
non-retained report. Rechecking subscriptions establishes that ST-MQ is listening;
it neither refreshes the relay nor re-executes the Rule. No request endpoint or
heartbeat is configured for this publisher. Retained messages cannot establish
live DHWR feedback.

A private `equipment.devices` override replaces the complete public list. If one
is present, add this entry there while retaining the other equipment entries.
Use `enabled: false` to disable monitoring where this publisher is not installed.
The measurement topic must differ from `mqtt.dhwr_topic`, whose default is
`from_stmq/dhwr/set`. The feedback entry cannot enable `switch_control` or
`tariff_control`; Start/Stop circulation uses ST-MQ's durable timed command path.

## Optional switch feedback

Add switch feedback only when an independent publisher actually reports the
physical relay's switch state. Replace the power entry with a `kind: "switch"`
entry on that publisher's exact state topic and map `dhwr_power` to the separate
power topic. For example, with an invented switch publisher:

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
    { "key": "power", "label": "Pump power", "unit": "W", "topic": "to_stmq/dhwr/power", "record": false }
  ]
}
```

This additional switch publisher is not created by the power Rule. For the
example, it sends non-retained JSON such as `{"switch":"on"}` and
`{"switch":"off"}`. State also accepts `ON`/`OFF`, JSON booleans, or numeric 1/0.
Omit `mqtt.state_path` for a plain state payload. This finite two-minute deadline
requires genuine repeated switch reports, preferably every minute. Power expires
under that deadline too; do not assume the event-only power Rule provides that
cadence. Missing power does not invalidate a fresh switch report.

Safe dotted paths can select nested JSON fields. `mqtt.timestamp_path` can select
a UTC epoch-millisecond timestamp or an ISO timestamp with an explicit timezone.
Without a source timestamp, a report uses its receive time. Command, state and
separate power topics must be distinct. Configure a read-only request only if
that integration implements it; its request topic must differ from the command.

With actual switch feedback configured, **Stop** is available when a fresh report
shows ON even without an ST-MQ run, such as circulation started in SmartThings.
That explicit OFF uses the same durable delivery/retry path. Its broker
acknowledgement remains separate from the reported switch becoming OFF.

## Recording and chart interpretation

DHWR feedback stays in memory (`record: false` is enforced). State samples and
power samples are not database time series; actual ON periods are not persisted.
Requested circulation history continues to be recorded: chart shading shows
**requested** circulation, clipped by recorded OFF requests. Watts and broker
acknowledgements do not turn that shading into measured pump operation.
Imported historical CSV `heaton60` pulses keep their original ten-minute
interpretation. These changes preserve the committed learning algorithm and CSV
provenance.
