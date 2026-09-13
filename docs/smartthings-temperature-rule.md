# SmartThings temperature forwarding

On 2026-09-13, the old temperature-copy Rule was replaced with three independent
Rules named **ST-MQ genuine temperature reports 1**, **2** and **3**. All three
were read back from the SmartThings API and matched the submitted definitions;
SmartThings reported each as **Enabled**, executing **Local**. The previous Rule
was removed after these checks. Existing physical sensor → MQTT virtual device
pairs and the `partyvoice23922.vtempset.setvTemp` command were preserved.

**The Rule replacement is installed, and the bedroom smoke detector now uses the
custom temperature-report driver.** Hub and device readback verified the exact
uploaded version and bedroom assignment. Two manual wake-ups produced equal
genuine temperature reports, two forced capability events, and two matching
non-retained MQTT arrivals. The owner confirmed a normal audible self-test,
but no SmartThings notification appeared and no alarm/test report was captured.
Remote alarm delivery and an automatic 15-minute cadence remain unverified.
A reporting-interval preference alone does not establish that cadence.
The earlier Rule replacement did not change driver assignments or preferences;
the later driver installation is a separate operation.

## Why the old Rule lost confirmations

The old Rule forwarded a temperature only when the physical sensor's value
differed from its MQTT virtual device's value. This discarded fresh reports of
the same temperature. The replacement uses a simple numeric condition with
`changesOnly: false` and the physical source's `trigger: Always`. Its lower bound
is absolute zero in Celsius, so zero and ordinary negative temperatures are
forwarded too. The inspected physical sources report Celsius; the setter forwards
the numeric value without unit conversion.

There is **one physical source per Rule**. Combining three always-satisfied
branches into one Rule could copy the other two sensors' cached values whenever
one sensor reports, falsely refreshing their coverage. The destination does not
appear in a trigger or comparison. There are no schedules, `every` actions,
`changes` conditions or source-versus-destination comparisons.

The [sanitized JSON template](smartthings/temperature-report-rule.template.json)
contains exactly the installed action structure. Only its name and private
device identifiers differ. SmartThings documents event-based numeric conditions
and explicit triggers in its [Rules guide](https://developer.smartthings.com/docs/automations/rules).
Its developer support also confirms that [`changes` still suppresses identical
values even with `state_change=true`](https://community.smartthings.com/t/rules-api-changes-condition-does-not-trigger-for-same-value-when-state-change-true/307852/4).

## Physical reporting is a separate prerequisite

SmartThings can filter repeated capability values before delivering them to
Rules. Emitting each actual temperature report with `state_change = true` tells
the platform to forward equal values to subscriptions too. This metadata belongs
on an event produced by a received physical report, rather than a timer or cached
device state. The earlier observation of only one report did not prove that the
stock driver was the sole cause of missing reports. See the official
[Edge capability-event documentation](https://developer.smartthings.com/docs/edge-device-drivers/capabilities.html#state-change).

All three physical sources initially used the stock **Z-Wave Smoke Alarm**
driver. The custom **ST-MQ Fibaro Temperature Reports** package adds the metadata
only in the Fibaro temperature-report handler. Its complete source is now stored
in [integrations/smartthings/fibaro-temperature](../integrations/smartthings/fibaro-temperature/README.md).
The authorized rollout targets the bedroom smoke detector only. Keep the other
detectors on stock drivers until the bedroom detector's normal self-test, alarm
notifications, and temperature forwarding have been verified.

For the Fibaro FGSD-002, parameter **20** controls a change-conditional reporting
interval; parameter **21** controls the required temperature difference. Setting
parameter 20 to 15 minutes therefore does **not** promise a fresh report every
15 minutes during stable temperature. The [manufacturer's manual](https://manuals.fibaro.com/content/manuals/en/FGSD-002/FGSD-002-EN-A-v1.01.pdf)
also distinguishes polling and wake-up configuration. The inspected public
[stock Fibaro subdriver](https://github.com/SmartThingsCommunity/SmartThingsEdgeDrivers/blob/main/drivers/SmartThings/zwave-smoke-alarm/src/fibaro-smoke-sensor/init.lua)
sets a six-hour wake-up interval when adding the device and requests a temperature
measurement upon wake-up. It does not establish a 15-minute confirmation stream.

The public [MQTT Devices temperature setter](https://github.com/toddaustin07/MQTTDevices/blob/main/hubpackage/src/cmdhandlers.lua)
publishes the numeric value whenever the setter is invoked with publishing
enabled, including unchanged values. It does not include the original physical
observation timestamp. For this feed, st-mq therefore uses non-retained MQTT
receipt time as a report-time proxy, contingent on genuine-event forwarding.
Do not manually execute a live forwarding Rule or schedule copying the cached
temperature: that produces a fresh MQTT receipt without a fresh measurement.

## Reproducible physical-driver package

The [current driver patch](../integrations/smartthings/fibaro-temperature/changes.patch)
applies to public SmartThingsEdgeDrivers revision
`19bb6f9b75a4a7590dfb5c5f9aed3bbf3308c77c`. It changes only
`drivers/SmartThings/zwave-smoke-alarm/config.yml` and
`src/fibaro-smoke-sensor/init.lua` beneath that driver. The package receives its
own name and package key. The Fibaro subdriver overrides only
`SENSOR_MULTILEVEL.REPORT`, checks temperature type, finite numeric value and
Celsius/Fahrenheit scale, then emits to the original endpoint with
`state_change=true`. Its wake-up handler retains the stock requests and adds
one read-only capabilities query per runtime, described below. The lifecycle
handlers remain unchanged. The [original temperature-only patch](smartthings/fibaro-temperature-reports.patch)
is retained for reproducing the first installation. The relevant [dispatch precedence](https://developer.smartthings.com/docs/edge-device-drivers/zwave/defaults.html)
and [sensor constants](https://developer.smartthings.com/docs/edge-device-drivers/zwave/generated/SensorMultilevel/constants.html)
are documented by SmartThings.

The repository now contains the full installable package, the upstream
Apache-2.0 license, original file digests, the exact patch, and repeatable tests.
Build from the repository root:

```bash
python3 integrations/smartthings/fibaro-temperature/tests/verify_source.py
smartthings edge:drivers:package \
  --build-only /tmp/stmq-fibaro-temperature-reports.zip \
  integrations/smartthings/fibaro-temperature/driver
sha256sum /tmp/stmq-fibaro-temperature-reports.zip
```

SmartThings CLI **2.1.2** built the initial package successfully. Its uploaded ZIP has
SHA-256 `8ae4eb570e6e61743d5cb105d735f9a742359fb2da39360c3fd3312830eff082`.
All 31 vendored upstream files and the license passed the reverse-patch/hash
check; the archive matches the 26 deployed files (the CLI excludes upstream
tests). The initial 21 Lua behavior assertions passed for duplicate/changed values,
Celsius/Fahrenheit, endpoints, invalid input, fingerprint selection, and the
original added/wake-up behavior. These use API stubs; the full SmartThings Lua
SDK tests have not run. Actual hub checks are recorded below. The
[package README](../integrations/smartthings/fibaro-temperature/README.md)
documents source reconstruction and the limits of those checks. The driver
preserves genuine reports; it does not alter their frequency or make parameter
20 an unconditional heartbeat.

## Bedroom driver installation and rollback

On 2026-09-13, the custom package was uploaded, assigned to a private developer
channel, and installed on the enrolled hub. Hub readback matched the uploaded
driver identifier and exact version, and device readback confirmed the bedroom
detector uses that driver. The other detectors' assignments and the bedroom
preferences were unchanged. The original stock driver remains installed for
rollback. No st-mq restart, hub restart, or re-pairing was performed.
Readback also confirmed the Fibaro fingerprint match, local driver execution,
current smoke `clear`, and enabled MQTT publishing to the bedroom topic used by
st-mq. A cached smoke state does not verify the detector's physical self-test.
Two manual B-button wake-ups produced consecutive equal Z-Wave temperature
reports. Each was traced through its own `state_change=true` capability event
to one matching non-retained MQTT arrival, within ten seconds of the physical
report. The first value also equaled the pre-install temperature. This verifies
fresh unchanged-value forwarding through the installed driver, Rule, and
virtual publisher. The owner then confirmed that the normal smoke self-test
sounded correctly, but no SmartThings notification appeared. The private hub
capture contained no corresponding smoke/alarm test report or alarm capability
event, so **remote alarm delivery remains unverified**. The temperature override
does not change smoke handlers, and this observation does not establish its
cause. Verify that path before extending the rollout. The automatic reporting
interval also remains **unverified**; manual wake-ups do not establish it.

The installation archive is outside Git:

```text
~/.config/st-mq/smartthings/bedroom-driver-2026-09-13/
```

Directories use `0700` and files `0600`. Retain this directory with private
configuration backups. It contains:

- `target.json`: the bedroom physical and MQTT device mapping, hub, and original
  stock driver; use this mapping instead of selecting devices by list position.
- `driver-uploaded.json` and `channel-created.json`: cloud driver/version and
  private channel identities required for reinstalling the same package.
- `installed-package.zip` and `package-validation.json`: the exact uploaded
  artifact and validation record.
- `before-preferences.json`, `after-preferences.json`, `after-installed.json`,
  and `installation-status.json`: settings and installation/readback evidence.
- `runtime-verification.json`, `driver-logcat.log`, and
  `mqtt-observations.jsonl`: private report-correlation evidence and raw captures.

Reinstallation uses the existing cloud driver and channel; it does not require
uploading another package. Keep the stock driver installed on the hub. To roll
back, switch the bedroom device to `target.json`'s `oldDriverId`, verify the
assignment, and compare preferences. Leave the temperature forwarding Rule
installed; restoring the old driver does not require restoring duplicate-value
filtering in the Rule.

Use the following snippet from the repository root to reinstall the archived
version. Change `reinstall` to `rollback` on its first line to restore the stock
driver. It reads identifiers from the archive and directs every CLI response
and error to a new private directory. It verifies the hub version before
switching and then checks device assignment and preferences. These operations
can be asynchronous; a pending readback is not confirmation of success.

```bash
STMQ_DRIVER_ACTION=reinstall python3 - <<'PY_DRIVER'
import json
import os
from pathlib import Path
import subprocess
import time

os.umask(0o077)
private = Path.home() / '.config/st-mq/smartthings/bedroom-driver-2026-09-13'
action = os.environ['STMQ_DRIVER_ACTION']
assert action in ('reinstall', 'rollback')
run_dir = private / ('maintenance-' + str(time.time_ns()))
run_dir.mkdir(mode=0o700)

def read(path):
    return json.loads(path.read_text())

def cli(step, args, as_json=False):
    result = run_dir / (step + '.json' if as_json else step + '.log')
    errors = run_dir / (step + '.errors.log')
    with result.open('w') as output, errors.open('w') as error:
        completed = subprocess.run(
            ['smartthings', *args, *(['--json'] if as_json else [])],
            stdout=output, stderr=error, check=False,
        )
    if completed.returncode:
        raise SystemExit('Step failed: ' + step + '; inspect ' + str(errors))
    return read(result) if as_json else None

target = read(private / 'target.json')
uploaded = read(private / 'driver-uploaded.json')
channel_id = read(private / 'channel-created.json')['channelId']
device_id, hub_id = target['deviceId'], target['hubId']
driver_id = uploaded['driverId'] if action == 'reinstall' else target['oldDriverId']
preferences = cli('before-preferences', ['devices:preferences', device_id], True)
if action == 'reinstall':
    cli('assign', ['edge:channels:assign', driver_id, uploaded['version'], '--channel', channel_id])
    cli('install', ['edge:drivers:install', driver_id, '--hub', hub_id, '--channel', channel_id])
for attempt in range(12):
    installed = cli('installed-' + str(attempt), ['edge:drivers:installed', '--hub', hub_id], True)
    matches = [item for item in installed if item['driverId'] == driver_id]
    if matches and (action == 'rollback' or matches[0]['version'] == uploaded['version']):
        break
    time.sleep(5)
else:
    raise SystemExit('Required driver/version not verified on hub; no switch attempted')
cli('switch', ['edge:drivers:switch', device_id, '--hub', hub_id, '--driver', driver_id])
for attempt in range(12):
    after = cli('after-device-' + str(attempt), ['devices', device_id], True)
    if after['zwave']['driverId'] == driver_id:
        break
    time.sleep(5)
else:
    raise SystemExit('Device assignment pending; inspect private responses')
after_preferences = cli('after-preferences', ['devices:preferences', device_id], True)
if after_preferences != preferences:
    raise SystemExit('Driver assigned; preferences differ. Inspect private before/after records')
print('Driver assignment verified; preferences unchanged. Private record:', run_dir)
PY_DRIVER
```

For a **fresh installation**, validate and build the source first, then follow
these steps using the existing SmartThings CLI login. Keep all requests,
responses, errors, and the selected device/hub/driver/channel identifiers in a
new private archive (`0700`, files `0600`). Capture commands with the `cli` helper
above or equivalent private stdout/stderr redirection; the identifiers below
are placeholders. Preserve the original bedroom archive.

1. Privately inspect `smartthings devices --json`, select the intended bedroom
   detector, and save its physical/MQTT mapping, hub, current stock driver, and
   preferences as `target.json` and `before-preferences.json`. Preserve the stock
   driver on the hub for rollback.
2. Upload with `smartthings edge:drivers:package --upload <built-zip> --json`.
   Save the response as `driver-uploaded.json` and retain the exact ZIP as
   `installed-package.zip` with its SHA-256 in `package-validation.json`.
3. Create a channel with `smartthings edge:channels:create --input <private-channel-request.json> --json`
   and save `channel-created.json`. The request uses the following public fields;
   `termsOfServiceUrl` is required:

   ```json
   {
     "name": "ST-MQ private drivers",
     "description": "Private household drivers maintained with st-mq",
     "type": "DRIVER",
     "termsOfServiceUrl": "https://www.apache.org/licenses/LICENSE-2.0"
   }
   ```

4. Assign the exact uploaded revision using
   `smartthings edge:channels:assign <driver-id> <driver-version> --channel <channel-id>`,
   then enroll the hub using `smartthings edge:channels:enroll <hub-id> --channel <channel-id>`.
5. Install using `smartthings edge:drivers:install <driver-id> --hub <hub-id> --channel <channel-id>`.
   Read `smartthings edge:drivers:installed --hub <hub-id> --json` and confirm
   both the driver identifier and exact version before assigning the detector.
6. Switch only the selected detector with
   `smartthings edge:drivers:switch <device-id> --hub <hub-id> --driver <driver-id>`.
   Read the device back and verify its `zwave.driverId`, compare its preferences,
   and confirm other detector assignments are unchanged. Retain the readbacks.

Reinstallation assumes the saved channel and its hub enrollment still exist.
If enrollment was removed, re-enroll with the step 4 command using the archived
identifiers. If an operation fails, inspect its private error file and resume
from saved identities rather than duplicating uploads or channels. Renew CLI
authentication normally if needed. The
[SmartThings CLI reference](https://github.com/SmartThingsCommunity/smartthings-cli)
documents these driver and channel operations.

After assignment, physically wake the bedroom detector if needed for pending
configuration or an immediate genuine temperature request. The
[FGSD-002 manual](https://manuals.fibaro.com/content/manuals/en/FGSD-002/FGSD-002-EN-A-v1.1.pdf)
specifies a single B-button click for manual wake-up. Follow its separate
self-test procedure and confirm the audible result and expected SmartThings
smoke notifications. Preserve the stock
driver until those checks succeed, and complete the cadence verification below
before relying on uninterrupted temperature coverage.

## Reading the detector's wake-up limits

The bedroom detector's received `WakeUp.IntervalReport` during the initial
manual test reported **21,600 seconds (six hours)**. Its ordinary temperature
report interval (parameter 20) is separate from this scheduled wake-up interval.
The [newer FGSD-002 manual](https://manuals.fibaro.com/wp-content/uploads/2025/07/FGSD-002-EN-A-v1.3_11.07.25.pdf)
allows a 4,200-second minimum (70 minutes), while an
[older manual](https://manuals.fibaro.com/content/manuals/en/FGSD-002/FGSD-002-EN-A-v1.00.pdf)
allows a 21,600-second minimum. Query the actual detector before selecting an
interval; neither document alone establishes this unit's supported minimum.

A small update on 2026-09-13 adds one read-only `IntervalCapabilitiesGet` using
WakeUp v2 after the existing battery/temperature requests on the first wake-up
of each driver runtime. It does not send `IntervalSet`, change the six-hour
setting, replace framework report handlers, or generate temperature events.
The diagnostic ZIP has SHA-256:

```text
0d956b98e9fc3d39a2a0ddffd4954d4fc08944fd16a5c9a09cef340bde3bdae4
```

The package passes all 31 upstream-file hashes after reversing the current
patch, all 24 Lua assertions, and CLI packaging. All 26 deployed ZIP entries
match source. The same cloud driver identity and private channel are used;
the diagnostic is assigned only to the bedroom detector.

Its private archive is `~/.config/st-mq/smartthings/wakeup-limits-2026-09-13/`
(directory `0700`, files `0600`). `driver-uploaded.json` stores the new version,
`probe-package.zip` the exact artifact, `package-validation.json` its digest,
`installation-status.json` the assignment/settings verification, and
`capabilities-summary.json` plus `driver-logcat.log` the query evidence.
The original bedroom installation archive remains intact for restoring its
previous version using the reinstall instructions above. To reinstall this
revision, use its `driver-uploaded.json` for the uploaded version while retaining
the original `target.json` and `channel-created.json` mappings.

After the diagnostic version is verified on the hub, capture the private driver
log and briefly press the B-button once. Look for a received
`INTERVAL_CAPABILITIES_REPORT` containing `minimum_wake_up_interval_seconds`,
`maximum_wake_up_interval_seconds`, `default_wake_up_interval_seconds`, and
`wake_up_interval_step_seconds`. No response is inconclusive. Supported limits,
accepted interval readback, and an observed automatic temperature stream are
separate checks.

**Verified on the bedroom detector:** the next manual wake-up returned these
actual capabilities, with no runtime errors:

| Field | Reported seconds | Meaning |
| --- | ---: | --- |
| Minimum | 4,200 | 70 minutes; a shorter scheduled wake-up is unsupported |
| Maximum | 65,535 | 18 hours, 12 minutes, 15 seconds |
| Default | 21,600 | Six hours |
| Step | 1 | One-second adjustments within the supported range |

The current interval readback remains **21,600 seconds**. This check discovers
supported values; it does not apply 4,200 seconds or verify an automatic
70-minute temperature stream. The installed driver's existing wake-up handler
requests a fresh temperature on each wake-up, but the proposed interval must be
set and read back before its automatic delivery and st-mq timeout can be verified.
The minimum, current interval, and temperature-report hysteresis are distinct:
changing parameter 20 to five minutes does not change this wake-up interval.

## Private backup and restoration

The exact previous Rule, generated replacements, uploaded Rules, device mappings,
location and read-back verification are outside Git in:

```text
~/.config/st-mq/smartthings/temperature-rules-2026-09-13/
```

The directory and its parent use mode `0700`; all files use `0600`. Useful files
are `old-rule.json`, `replacement-rules.json`, `device-mapping.json`,
`created-rules.json`, `final-rules.json` and `migration-status.json`. The Rule
numbers preserve the previous Rule's pair order; use the private mapping to
identify a device, rather than inferring its room from the number. Keep the
archive with private configuration backups. Never copy its contents into Git,
issue descriptions or shared logs.

For inspection, use the sanitized template in Git. For exact recreation of a
missing Rule, use the corresponding request from `replacement-rules.json` in
the private archive. The following runs from the repository root and creates
one missing Rule selected by `STMQ_RULE_NUMBER` (choose `1`, `2` or `3`). Run it only after inspecting SmartThings
and confirming that this Rule is absent, to avoid duplicate forwarding:

```bash
STMQ_RULE_NUMBER=1 python3 - <<'PY'
import json
import os
from pathlib import Path
import subprocess

private = Path.home() / '.config/st-mq/smartthings/temperature-rules-2026-09-13'
index = int(os.environ['STMQ_RULE_NUMBER']) - 1
assert 0 <= index < 3
rules = json.loads((private / 'replacement-rules.json').read_text())
location = json.loads((private / 'locations.json').read_text())['items'][0]['locationId']
request = private / f'restore-request-{index + 1}.json'
result = private / f'restore-result-{index + 1}.json'
errors = private / f'restore-errors-{index + 1}.log'
os.umask(0o077)
request.write_text(json.dumps(rules[index], indent=2) + '\n')
request.chmod(0o600)
with result.open('w') as output, errors.open('w') as error:
    completed = subprocess.run(
        ['smartthings', 'rules:create', '--location', location,
         '--input', str(request), '--json'],
        stdout=output, stderr=error, check=False,
    )
result.chmod(0o600)
errors.chmod(0o600)
print('CLI exit status:', completed.returncode)
print('Private response:', result)
print('Private errors:', errors)
PY
```

This uses the existing SmartThings CLI login; no token is placed in a command
argument or repository file. If authentication has expired, authenticate with
the CLI normally and repeat. Read back the newly created Rule and verify its
name, full actions, enabled status and execution location before relying on it.
The CLI's [input/output options](https://github.com/SmartThingsCommunity/smartthings-cli#input-and-output-considerations)
also support `rules`, `rules:update` and `rules:delete` for private inspection and
maintenance. To restore the original behavior, strip response metadata from
`old-rule.json` to retain its name and actions, create and verify it, then remove
only the three replacements recorded in the archive. This reinstates the
original duplicate-value filtering too.

If recreating the setup on another installation, copy the sanitized template to
a private file and replace both occurrences of `REPLACE_PHYSICAL_SENSOR_ID`,
the one `REPLACE_MQTT_TEMPERATURE_DEVICE_ID`, and the name. Make one independent
Rule for each physical sensor. Configure its MQTT virtual device to publish to
the exact corresponding st-mq topic with Celsius units. Preserve actual IDs
and topic mappings in private configuration.

## Verification before relying on the cadence

1. Trace actual temperature reports in the physical Edge driver's log, including
   two consecutive equal values. Each must emit `state_change=true`.
2. Check that each report invokes the matching MQTT virtual device's setter once,
   and that another room's report does not invoke this setter.
3. Confirm a corresponding non-retained MQTT arrival for each physical report,
   including the unchanged value. Keep raw logs and household readings private.
4. Observe automatic reports during a stable period for several intervals. A
   manual wake-up test alone cannot prove the automatic interval.
5. Match `mqtt.temperature_report_interval_minutes` and
   `mqtt.temperature_report_grace_seconds` to the verified delivery behavior.
   The new default is 15 minutes plus 120 seconds. Set the interval to `0` for
   the explicit earlier change-only policy until a periodic publisher is ready.

With the periodic contract enabled, missing a report beyond the interval plus
grace creates a chart gap and excludes uncovered indoor learning windows.
Repeated equal reports extend coverage without forcing repeated temperature
rows. See [temperature storage and learning](temperature-sensors.md) for the
st-mq behavior.
