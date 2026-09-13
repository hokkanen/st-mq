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

This driver does not schedule temperature events, copy cached readings, or
change the detector's reporting interval. Its existing six-hour wake-up setting,
wake-up battery and temperature requests, smoke/tamper/heat handlers, preferences,
and other device support remain the stock implementation. In particular, the
stock wake-up handler emits smoke `clear`; that behavior was not introduced or
changed here. A 15-minute parameter 20 setting alone does not guarantee periodic
unchanged reports. Follow the separate cadence and MQTT checks in the
[installation and forwarding record](../../../docs/smartthings-temperature-rule.md).

The first wake-up after each driver runtime starts also sends a read-only
`WakeUp` v2 `IntervalCapabilitiesGet`. This asks the detector for its supported
minimum, maximum, default, and step in seconds. The decoded response is captured
in private logcat. No interval is written by this diagnostic; a missing response
is inconclusive. Existing interval-report and capabilities-report dispatch are
left to the framework. See the official
[query](https://developer.smartthings.com/docs/edge-device-drivers/zwave/generated/WakeUp/IntervalCapabilitiesGet.html)
and [report fields](https://developer.smartthings.com/docs/edge-device-drivers/zwave/generated/WakeUp/IntervalCapabilitiesReport.html).

## Provenance and scope

Source: [SmartThingsCommunity/SmartThingsEdgeDrivers](https://github.com/SmartThingsCommunity/SmartThingsEdgeDrivers/tree/19bb6f9b75a4a7590dfb5c5f9aed3bbf3308c77c/drivers/SmartThings/zwave-smoke-alarm),
revision `19bb6f9b75a4a7590dfb5c5f9aed3bbf3308c77c`,
directory `drivers/SmartThings/zwave-smoke-alarm`.

The original [Apache-2.0 license](LICENSE) and source copyright notices are
retained. Vendored upstream files retain that license. `upstream.json` records
the original source and license SHA-256 digests. `changes.patch` is the current
complete st-mq patch: the only changed upstream files are `config.yml`
(independent package name/key) and `src/fibaro-smoke-sensor/init.lua` (temperature
report override and read-only wake-up-limits query). The full stock fingerprint list remains available, but a
rollout must select the intended detector explicitly.

## Validate and build

Run from the st-mq repository root. Validation needs Python 3.8+, `patch`, and
Lua 5.3/5.4 or `texlua`. Packaging needs the authenticated SmartThings CLI.

```bash
python3 integrations/smartthings/fibaro-temperature/tests/verify_source.py
smartthings edge:drivers:package \
  --build-only /tmp/stmq-fibaro-temperature-reports.zip \
  integrations/smartthings/fibaro-temperature/driver
sha256sum /tmp/stmq-fibaro-temperature-reports.zip
```

`--build-only` creates a ZIP without uploading. On 2026-09-13, SmartThings CLI
2.1.2 built the package successfully. The current diagnostic build uploaded to
the bedroom driver has SHA-256:

```text
0d956b98e9fc3d39a2a0ddffd4954d4fc08944fd16a5c9a09cef340bde3bdae4
```

The ZIP is a build artifact kept outside Git. Rebuilding reproduces the source
package; ZIP timestamps can change the archive hash. Record the hash of the
actual uploaded artifact in the private installation backup.

The offline verifier reverses the patch in a temporary copy and checks every
upstream file and the license against the recorded digests. This checks that
alarm, battery, preferences, default registration, profiles, and all remaining
code retain the pinned stock source. It also runs 24 Lua assertions against the
actual Fibaro subdriver using small SmartThings API stubs: duplicate/changed
reports, Celsius/Fahrenheit, negative/zero temperatures, endpoint routing,
invalid input rejection, fingerprint selection, existing added/wake-up behavior,
and the single v2 diagnostic query without replacing report dispatch. These tests do not simulate SmartThings event filtering or the radio.
The original `driver/src/test/` SDK integration tests are retained; they were
not executed because the SmartThings Lua integration framework is not installed
here. Hub and physical self-test results belong in the installation record.

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
contains the bedroom rollout status, installation steps, physical checks, and
rollback procedure. Keep account/device/hub/channel/driver identifiers and raw
logs in the private installation backup outside the checkout. Do not commit
household mappings or authentication files. Keep the stock driver installed on
the hub for rollback.
