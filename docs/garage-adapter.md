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

The protection sender retains its configuration and front/rear pipe state.
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
The heat-pump controller applies the floor without replacing the user target and
selects HEAT/ON when rescue requires it. Configured protection feed loss invokes
the driver's explicit local fault policy; an installation without a protection
source reports unavailable. A BLU H&T supplies temperature only.

## Validation

Test source and generated scripts against synthetic CN105 replies, held/stale
Bluetooth values, reordered callbacks, persistence failures, one-shot replay,
remote edits, OFF preservation, mode changes and failed serial writes. Then
measure actual Pill memory, scheduler progress, timeout/recovery, reboot and
network loss using the installed firmware. Source size and isolated self-tests
are not heap headroom. Private deployment backups retain the previous sources
and current device state until the new installation is verified.
