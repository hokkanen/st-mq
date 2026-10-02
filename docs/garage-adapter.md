# Garage local-control adapter

The current pump contract is `shelly-cn105/v2`, with device-scoped MQTT `state`,
`telemetry` and `command` topics. Previous lease and external-sample commands are
unsupported. Configuration names the route; fresh device identity, boot and
challenge authorize a bounded command attempt. Retained state may be displayed
as recorded evidence but does not authorize a write. Reconnect never replays an
old ordinary command. Read-only replicas cannot publish commands.

## Target and native commands

A `control` command supplies the durable real target and external-control enable.
Acknowledgement follows successful persistence; active regulation additionally
requires sensor evidence and native readback. A `set` command changes a single
native field (power, mode, target, fan or vane), preserving unrelated fields.
Acceptance, serial acknowledgement and confirmed native settings are distinct.
There are no leases, renewals, timed power restoration or Normal/Away labels in
the heat-pump controller. ST-MQ owns those labels and sends only the resulting
target.

## Bluetooth and local regulation

Native BTHome sensor components provide values and received-measurement times.
Repeated cache reads do not refresh them. Unchanged new reports do. Offline
startup and wall-clock changes must not turn cached values into new measurements.
The local loop uses elapsed time, bounds serial work and retries, and preserves
one owner of the CN105 UART. It confirms native 17°C before sending measured
room temperature + 17°C - effective target, with encoding/range validation.
Power OFF is preserved; non-HEAT suspends and clears external control. Fresh
HEAT return resumes the saved request. At 180 seconds of missing valid sensor
reports, clear external input and set native 16°C in HEAT, preserving power.

## Protection sender

A compatible, mains-powered device with two DS18B20 probes runs the protection
sender script. The tested example is a Shelly 1 Gen3 with a Plus Add-on and
firmware 2.0.1; the device role does not require that particular model. The sender
retains its configuration and front/rear pipe state.
Its MQTT status uses `stmq-garage-sender/v1`; commands are bounded and tied to
fresh sender identity/challenge. `garage.protection` in loaded configuration is
the only source of installation approval and protection parameters; the dashboard
has no settings-write route. ST-MQ presents configured values separately from
actual sender readback, while configuration requests remain pending until fresh
readback matches. A successful command result alone is not confirmation.
Missing confirmation permits one retry after 30 seconds using an unused fresh
challenge, then stops with a visible mismatch. Explicit rejection or failure stops
immediately. Apply configuration or restart to retry after reviewing the source;
broker reconnects and sender reboots do not reset an exhausted retry budget.
The Bluetooth protection
interface carries the minimum target, rescue flag and input/model validity.
The heat-pump controller applies the temporary floor while protection demands
heating, including the recovery hold, without replacing the user target. The
sender reports a zero floor after release; there is no permanent 5°C limit.
The controller selects HEAT/ON when rescue requires it. Configured protection
feed loss invokes the driver's explicit local fault policy; an installation without a protection
source reports unavailable. A BLU H&T supplies temperature only.

## Sender installation

Use **Connections & configuration → Garage freeze protection**, directly below
**Floor preheating**, for installation and setup guidance.
The linked **Garage → Freeze protection** fold, below **Normal temperature**,
contains live air/pipe/reserve readings and explains active protection. Its
**Pipe model & settings** compares configured and reported parameters and explains
the pipe calculation and fixed model safety factor. Build and
install `dist/sender.js` from the
[heat-pump controller and sender repository](https://github.com/hokkanen/shelly-cn105-mqtt), following its
[sender guide](https://github.com/hokkanen/shelly-cn105-mqtt/blob/main/docs/sender.md).
That repository also owns [controller wiring and installation](https://github.com/hokkanen/shelly-cn105-mqtt/blob/main/docs/installation.md).

The supplied sender script requires scripting, `BLE.AdvBuilder`,
`BLE.advertiseOnce`, `BTHome.DataBuilder`, enabled Bluetooth, and a compatible
sensor add-on exposing both probes. These APIs require firmware 2.0.0 or later.
Shelly documents advertising on mains-powered Gen3/Gen4 devices with scripting
and selected Gen2 devices; Gen4 Zigbee mode is excluded. API support alone does
not verify add-on compatibility, memory headroom or the complete installation.
See the [official API support](https://shelly-api-docs.shelly.cloud/gen2/Scripts/APIs/BLE/#advertising-support).
The tested Shelly 1 Gen3 required an update from factory 1.2.2 via the required
1.3.3 intermediate to 2.0.1; use the sender guide for model-specific update details.

Identify the actual rear and front probe components before saving `cn105_sender_config` in its KVS.
The rear probe supplies room regulation; swapping probe labels changes the
physical meaning of the control input. Set its `prefix` to the exact prefix
of `garage.sender.stateTopic` and `garage.sender.commandTopic`, normally
`heatpump/garage/sender`. Enable MQTT to the controller's broker and script
autostart. Apply the reviewed `garage.protection` configuration and confirm the
sender's persisted readback; approval alone does not establish probe freshness.

Only new native `temperature_measurement` events provide source freshness.
Check actual reports from both probes, including unchanged values, at roughly
60-second intervals. Do not replace these with cached status polling. The
sender emits a valid BLE packet only for a new pair of probe reports; stale,
invalid or unapproved protection emits invalid/rescue flags without temperatures.

Register the sender with the heat-pump controller's native BTHome receiver.
Inspect the generated component IDs and configure the complete mapping in the
controller repository's instructions: temperature object `0x45` index 0 is rear room temperature and
index 1 is the protection floor; binary object `0x0f` index 0 is rescue and
index 1 is validity. Replace the former BLU temperature mapping and remove its
unused native registration. Keep controller Bluetooth enabled for the sender.

## Validation

Test source and generated scripts against synthetic CN105 replies, held/stale
Bluetooth values, reordered callbacks, persistence failures, one-shot replay,
remote edits, OFF preservation, mode changes and failed serial writes. Then
measure actual heat-pump controller memory, scheduler progress, timeout/recovery,
reboot and network loss using the installed firmware. Source size and isolated self-tests
are not heap headroom. Private deployment backups retain the previous sources
and current device state until the new installation is verified.
