# Fibaro temperature-report Edge driver

This directory contains the complete **ST-MQ Fibaro Temperature Reports** driver,
package key `stmq-fibaro-temperature-reports`, for forwarding genuine Fibaro
smoke-sensor temperature reports through SmartThings to st-mq. Equal temperatures
must still confirm that a report arrived; ordinary change filtering and the
detector's change-conditional report interval cannot establish that evidence.

Start with the [general installation guide](../../../docs/smartthings-temperature-rule.md)
for the reasons, default selections, inherited limitations, driver/channel
setup, MQTT forwarding, report deadlines, verification and rollback.

## What is kept here

| Path | Purpose |
| --- | --- |
| [driver/](driver) | Complete buildable source, including profiles, fingerprints, supporting subdrivers and upstream SDK tests |
| [build.py](build.py) | Build a ZIP in an external directory without uploading |
| [changes.patch](changes.patch) | Exact complete difference from pinned upstream source |
| [upstream.json](upstream.json) | Pinned revision and original source/license digests |
| [LICENSE](LICENSE) | Original Apache-2.0 license |
| [tests/verify_source.py](tests/verify_source.py) | Reverse-patch/hash verification, profile validation and focused Lua behavior checks |

The driver source is about **83 KiB across 31 files**. Retaining this small
complete package alongside its patch makes it buildable without fetching upstream
source and preserves the support files used by the original alarm implementation.
No separate driver repository is required. Generated ZIPs, authentication and
installation-specific backups remain outside Git.

The driver manifest is stored as `driver/config.yml.template` so Home Assistant
does not discover it as a second app. The build helper restores SmartThings'
required `config.yml` filename in an external temporary directory; all packaged
source bytes remain unchanged.

Upstream is
[SmartThingsCommunity/SmartThingsEdgeDrivers](https://github.com/SmartThingsCommunity/SmartThingsEdgeDrivers/tree/19bb6f9b75a4a7590dfb5c5f9aed3bbf3308c77c/drivers/SmartThings/zwave-smoke-alarm),
revision `19bb6f9b75a4a7590dfb5c5f9aed3bbf3308c77c`, under
`drivers/SmartThings/zwave-smoke-alarm`. All original copyright notices and the
license are retained. The patch changes six files:

- `config.yml`: custom package identity.
- Two Fibaro smoke profiles: embedded defaults and the wake-up selector.
- `src/fibaro-smoke-sensor/init.lua`: genuine-temperature event metadata and
  wake-up selection, capabilities query and interval readback.
- `src/preferences.lua`: IDs matching the current bundled profiles, with unchanged hardware parameter numbers/sizes.
- `src/init.lua`: current-profile preference lookup, first-wake setting application
  and diagnostic counts; the wake-up selector is excluded from Configuration.

The temperature handler preserves Celsius/Fahrenheit units and the source
endpoint, ignores invalid reports and emits valid reports with boolean
`state_change = true`, including repeated values. Each actual wake requests fresh
battery and temperature data. The selector defaults to 4,200 seconds and also
offers two, three, six and twelve hours. The driver records accepted interval
readback separately from attempted writes and retries missing/mismatching
readback on later wakes. It does not publish cached values on a timer.

Current local preference IDs match the bundled profiles and parameter map. Saved
current choices remain authoritative. Obsolete ST-MQ namespaced preference IDs
are ignored and never translated into current selections. Once all nine local Configuration settings are present, their current
values are attempted once while awake. The persistent marker is a send-attempt
record, not a parameter acknowledgement. The inherited alarm handlers and
parameter mappings/sizes remain unchanged, including the documented threshold
label/mapping mismatch. Review the guide's
[defaults and limitations](../../../docs/smartthings-temperature-rule.md#default-selections-and-limitations)
before using those settings.

## Validate and build from st-mq

From the st-mq repository root, use Python 3.8+ with PyYAML, `patch`, and Lua
5.3/5.4 or `texlua` for validation. Packaging requires the SmartThings CLI.

```bash
python3 integrations/smartthings/fibaro-temperature/tests/verify_source.py
python3 integrations/smartthings/fibaro-temperature/build.py /tmp/stmq-fibaro-temperature.zip
sha256sum /tmp/stmq-fibaro-temperature.zip
```

The helper invokes `--build-only`, creating the ZIP without uploading it, and
refuses an existing output or a destination inside the checkout. The package contains the
26 deployable files; the CLI excludes the upstream `driver/src/test/` files.
Keep the exact artifact, digest and upload response in a private installation
backup. ZIP timestamps can change the archive digest between builds; source
verification and comparison with the actual uploaded ZIP establish what was
installed. Follow the [installation steps](../../../docs/smartthings-temperature-rule.md#build-and-install-the-driver)
to upload, assign the channel version, install on a hub and assign devices.

The verifier checks all 31 original files and the license after reversing the
patch, validates both profiles, and runs 75 Lua assertions against the actual
subdriver and parent preference sender using small SDK stubs. Cases include
repeated/changed reports, invalid inputs, original alarm events, wake choices,
readback/retry, restarts, controller mismatch, reported limits, current-profile
settings, deferred application and interrupted sends. These are source checks,
not a simulation of cloud filtering or radio delivery.

The original SDK tests under `driver/src/test/` remain upstream reference; their
old six-hour added/wake expectations are superseded by the focused modified-driver
tests. The verifier does not run the full SmartThings Lua integration framework.
Use the guide's [physical verification procedure](../../../docs/smartthings-temperature-rule.md#verify-and-troubleshoot)
for an installation.

## Reconstruct from upstream

The bundled `driver/` is sufficient for ordinary rebuilding. To independently
recreate it, obtain the public upstream repository and check out the exact
revision from `upstream.json`. Run the following from the **upstream repository
root**, replacing the absolute patch path with the path in your st-mq checkout:

```bash
git clone https://github.com/SmartThingsCommunity/SmartThingsEdgeDrivers.git /tmp/stmq-edge-upstream
cd /tmp/stmq-edge-upstream
git checkout --detach 19bb6f9b75a4a7590dfb5c5f9aed3bbf3308c77c
git apply --check --unidiff-zero /absolute/path/to/st-mq/integrations/smartthings/fibaro-temperature/changes.patch
git apply --unidiff-zero /absolute/path/to/st-mq/integrations/smartthings/fibaro-temperature/changes.patch
git diff --check
```

The resulting `drivers/SmartThings/zwave-smoke-alarm` directory is the modified
package. Compare it with `driver/`, accounting for the `config.yml.template`
filename. If copying it into a restoration checkout, rename `config.yml` to
`config.yml.template`, retain the upstream root `LICENSE` beside this README, and rerun the verifier
from the st-mq root. Apply the complete `changes.patch` here; any older standalone
temperature-only patch elsewhere in repository history is not the current driver.

For an intentional upstream upgrade, review upstream changes, update the pinned
revision, original digests, complete patch and tests together, then validate and
deploy a new package. Upstream changes and edits to st-mq do not automatically
replace the package already installed on a hub. See the
[update/reinstall/rollback instructions](../../../docs/smartthings-temperature-rule.md#update-reinstall-or-roll-back)
for deployment and its effect on every device sharing the driver ID.
