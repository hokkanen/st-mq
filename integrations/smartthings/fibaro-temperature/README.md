# Fibaro temperature-report Edge driver

`driver/` is the complete, installable **ST-MQ Fibaro Temperature Reports**
package, including device profiles, fingerprints, preferences, all original
subdrivers, and upstream tests. Its package key is
`stmq-fibaro-temperature-reports`. The source is small enough to retain here:
31 upstream files, approximately 74 kB before packaging.

Each valid physical Fibaro temperature report emits a capability event with
boolean `state_change = true`, including a repeated value. The Celsius or
Fahrenheit unit and source endpoint are preserved. Other sensor types, unknown
scales, nonnumeric values, NaN, and infinities are ignored. The metadata is the
second argument to the temperature event constructor, as specified by
[SmartThings](https://developer.smartthings.com/docs/edge-device-drivers/capabilities.html#state-change).
The explicit report handler takes precedence over the
[default handler](https://developer.smartthings.com/docs/edge-device-drivers/zwave/defaults.html).

The **Wake-up interval** selector offers 70 minutes, 2 hours, 3 hours, 6 hours,
and 12 hours. The default is **70 minutes (4200 seconds)**. Each actual wake-up
still requests a fresh battery reading and temperature from the detector. The
driver forwards the genuine temperature response even if its value is unchanged;
it never schedules fabricated events or copies cached readings. Parameter 20
still controls the detector's separate change-dependent reporting and a
15-minute selection there does not guarantee unchanged reports.

A sleeping detector receives the selected wake-up interval at its next natural
wake-up. A manual button press is optional, including for an inaccessible alarm.
The first application may therefore wait for the old wake-up interval. After
sending `IntervalSet`, the driver sends `IntervalGet` and retains only the
interval/controller returned by `IntervalReport` as confirmation. Missing or
mismatching readback triggers another attempt at the next wake-up. Matching
readback suppresses repeated writes; every wake-up still reads the setting back
to detect drift. Both a saved non-default selection and the last observed interval
survive driver restarts.

The first wake-up of each runtime also requests `IntervalCapabilitiesGet`.
Reported minimum/maximum limits are retained, and a selection outside those
limits is not repeatedly written. The 70-minute minimum was read from the
bedroom detector; other units need their own readback before treating it as
accepted. `IntervalReport` and `IntervalCapabilitiesReport` have no existing
Lua default handlers in the inspected official
[SDK API v21 / hub 0.62 release](https://github.com/SmartThingsCommunity/SmartThingsEdgeDrivers/releases/tag/apiv21_62).
The hub still sees `IntervalReport` for its own device-health interval handling.
The driver's existing `health_check = false` policy is retained.

Both Fibaro smoke profiles embed the nine existing public preference definitions
with the requested defaults. Embedded names must use the local suffix
(`tempReportInterval`, for example); the cloud rejects namespaced dotted names.
These new setting IDs start with the requested defaults. Their raw values are
`1`, `0`, `0`, `0`, `90`, `1`, `10`, `180`, and `360`, in the profile's existing
order. The original namespaced selections are archived in the private rollout
backup; this update does not migrate those selections into the new setting IDs.
Check the app-visible settings after installing the profile.

Once a local setting has been saved, its value takes priority over its default
and remains authoritative across later driver updates. The sender falls back to
the corresponding legacy `certifiedpreferences.*` value only when no local value
exists; it never lets a hidden legacy setting override the visible local
selection. The separate `wakeUpIntervalSeconds` preference is never passed to the
Configuration parameter sender. The driver uses SmartThings' deferred preference
callback for sleepy devices. Once all nine local settings are available, their
current selections are sent together on the first actual wake-up, even if the
SDK's initialization snapshot already contains those values. An interrupted
attempt is retried at the next wake-up. A persistent revision records completion
of this one-time send attempt; it does not claim Configuration readback or radio
acknowledgement. Calling `doConfigure` while the alarm is asleep cannot consume
that first-wake attempt. Later local preference edits use the existing change
comparison, and a driver restart does not repeat an already completed attempt.
Initialization and the first pending awake callback in each runtime log only
mapped/local/legacy preference counts and whether an attempt revision exists.
These diagnostics contain no setting values or device identifiers.
See the official [preference documentation](https://developer.smartthings.com/docs/devices/preferences#handling-changes-to-preferences-for-a-sleepy-z-wave-device).

The inherited threshold label/options and parameter-30 mapping are deliberately
unchanged at the owner's request. All existing Configuration parameter numbers
and sizes remain unchanged, including this known mismatch. Smoke/tamper/heat
handlers and other device support remain the stock implementation. In particular,
the stock wake-up handler emits smoke `clear`; that behavior was not introduced
or changed here. Live acceptance, cadence, and MQTT checks belong in the
[installation and forwarding record](../../../docs/smartthings-temperature-rule.md).

## Provenance and scope

Source: [SmartThingsCommunity/SmartThingsEdgeDrivers](https://github.com/SmartThingsCommunity/SmartThingsEdgeDrivers/tree/19bb6f9b75a4a7590dfb5c5f9aed3bbf3308c77c/drivers/SmartThings/zwave-smoke-alarm),
revision `19bb6f9b75a4a7590dfb5c5f9aed3bbf3308c77c`,
directory `drivers/SmartThings/zwave-smoke-alarm`.

The original [Apache-2.0 license](LICENSE) and source copyright notices are
retained. Vendored upstream files retain that license. `upstream.json` records
the original source and license SHA-256 digests. `changes.patch` is the current
complete st-mq patch. Five upstream files change: `config.yml` (package identity),
two Fibaro smoke profiles (embedded defaults and wake-up selector),
`src/fibaro-smoke-sensor/init.lua` (genuine temperature reporting and wake-up
configuration/readback), and `src/init.lua` (local/legacy setting lookup, skip
unmapped preferences, and one-time application of current local selections while
awake). The full stock fingerprint list remains available; a
rollout must select the intended detectors explicitly.

## Validate and build

Run from the st-mq repository root. Validation needs Python 3.8+ with PyYAML, `patch`, and
Lua 5.3/5.4 or `texlua`. Packaging needs the authenticated SmartThings CLI.

```bash
python3 integrations/smartthings/fibaro-temperature/tests/verify_source.py
smartthings edge:drivers:package \
  --build-only /tmp/stmq-fibaro-preferences.zip \
  integrations/smartthings/fibaro-temperature/driver
sha256sum /tmp/stmq-fibaro-preferences.zip
```

`--build-only` creates a ZIP without uploading. On 2026-09-13, SmartThings CLI
2.1.2 built the preference-selector package successfully. Its build artifact has
SHA-256:

```text
07548c87e5c1b278f7294e77727ac14dfdf1802318ec877a9e25844438354999
```

The ZIP is a build artifact kept outside Git. Rebuilding reproduces the source
package; ZIP timestamps can change the archive hash. Record the hash of the
actual uploaded artifact in the private installation backup.

The offline verifier reverses the patch in a temporary copy and checks every
upstream file and the license against the recorded digests. It checks both
profiles' requested defaults and retained threshold definition,
and supported wake-up choices. It runs **74 Lua assertions** against the real
Fibaro subdriver and parent lifecycle/configuration sender using small SmartThings
API stubs: duplicate/changed reports and invalid inputs, existing alarm events,
first natural wake with no explicit value, non-default selections, readback and
retry, restart behavior, wrong-controller correction, unsupported limits, and
preserved legacy parameter mappings/sizes and local/legacy ID handling. Additional
checks cover first-wake selection application with an unchanged SDK snapshot,
restarts, delayed profile settings, and interrupted sending. Sleepy preference
changes produce no immediate writes, and the separate wake-up selector cannot reach Configuration.
These checks do not simulate SmartThings cloud filtering or radio delivery.

The original `driver/src/test/` SDK tests remain as pinned upstream reference.
They were not executed because the SmartThings Lua integration framework is not
installed here, and the old six-hour added/wake expectations are superseded by
our focused tests. Hub and physical self-test results belong in the installation
record.

## Recreate the vendored package from upstream

In a temporary checkout of the upstream repository, use the pinned revision
above, then apply `changes.patch` from this directory:

```bash
git checkout --detach 19bb6f9b75a4a7590dfb5c5f9aed3bbf3308c77c
git apply --check --unidiff-zero /absolute/path/to/st-mq/integrations/smartthings/fibaro-temperature/changes.patch
git apply --unidiff-zero /absolute/path/to/st-mq/integrations/smartthings/fibaro-temperature/changes.patch
git diff --check
```

Copy the complete `drivers/SmartThings/zwave-smoke-alarm` directory to `driver/`
and the upstream root `LICENSE` beside this README. Re-run the offline verifier.
For an intentional upstream update, review the entire upstream change and
refresh the revision, digests, patch, and validation record together.

## Installation and rollback

The [st-mq installation record](../../../docs/smartthings-temperature-rule.md)
contains the four-detector rollout status, installation steps, physical checks, and
rollback procedure. Keep account/device/hub/channel/driver identifiers and raw
logs in the private installation backup outside the checkout. Do not commit
household mappings or authentication files. Keep the stock driver installed on
the hub for rollback.
