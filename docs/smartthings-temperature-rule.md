# SmartThings temperature forwarding

On 2026-09-13, the old temperature-copy Rule was replaced with three independent
Rules named **ST-MQ genuine temperature reports 1**, **2** and **3**. All three
were read back from the SmartThings API and matched the submitted definitions;
SmartThings reported each as **Enabled**, executing **Local**. The previous Rule
was removed after these checks. Existing physical sensor → MQTT virtual device
pairs and the `partyvoice23922.vtempset.setvTemp` command were preserved.

**The Rule replacement is installed. Repeated physical reports and an automatic
15-minute temperature-confirmation cadence are not yet verified.** The source
driver and detector configuration require the checks below; changing a reporting
interval in the app alone does not establish this guarantee. No smoke driver,
smoke alarm setting or device preference was changed by this Rule replacement.

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

SmartThings ordinarily filters repeated capability values before delivering them
to Rules. A physical Edge driver must emit each actual temperature report with
`state_change = true` for unchanged readings to survive that filter. This metadata
belongs on the event produced by a received physical temperature report; it must
not be generated from a timer or cached device state. See the official
[Edge capability-event documentation](https://developer.smartthings.com/docs/edge-device-drivers/capabilities.html#state-change).

The installed-driver listing confirmed that all three physical sources still use
the stock **Z-Wave Smoke Alarm** driver. The earlier diagnosis proposed a private
driver named **ST-MQ Fibaro Temperature Reports**, adding this metadata only to
the temperature-report handler; that proposed driver is not assigned to these
sensors. Keep its source,
upstream revision and patch if implementing it, preserve smoke/tamper/battery
handlers, and verify one detector's normal self-test and alarm notifications
before changing the other detectors. This task did not install that driver.

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

## Prepared physical-driver patch (not installed)

The [temperature-report patch](smartthings/fibaro-temperature-reports.patch)
applies to public SmartThingsEdgeDrivers revision
`19bb6f9b75a4a7590dfb5c5f9aed3bbf3308c77c`. It changes only
`drivers/SmartThings/zwave-smoke-alarm/config.yml` and
`src/fibaro-smoke-sensor/init.lua` beneath that driver. The package receives its
own name and package key. The Fibaro subdriver overrides only
`SENSOR_MULTILEVEL.REPORT`, checks temperature type, finite numeric value and
Celsius/Fahrenheit scale, then emits to the original endpoint with
`state_change=true`. Its existing wake-up handler and lifecycle handlers remain
unchanged. The relevant [dispatch precedence](https://developer.smartthings.com/docs/edge-device-drivers/zwave/defaults.html)
and [sensor constants](https://developer.smartthings.com/docs/edge-device-drivers/zwave/generated/SensorMultilevel/constants.html)
are documented by SmartThings.

To reproduce the prepared source outside st-mq, replace the absolute patch path
with this checkout's path:

```bash
git clone https://github.com/SmartThingsCommunity/SmartThingsEdgeDrivers.git stmq-fibaro-edge
cd stmq-fibaro-edge
git checkout --detach 19bb6f9b75a4a7590dfb5c5f9aed3bbf3308c77c
git apply --check --unidiff-zero /absolute/path/to/st-mq/docs/smartthings/fibaro-temperature-reports.patch
git apply --unidiff-zero /absolute/path/to/st-mq/docs/smartthings/fibaro-temperature-reports.patch
git diff --check
git diff --stat
```

The patch was checked against that exact upstream source. Lua mock checks passed
for duplicate and changed values, Celsius/Fahrenheit units, endpoint routing,
invalid values and the continued presence of the original wake-up and added
handlers. **It has not been installed or tested on a hub.** Packaging and driver
assignment remain a separate step requiring the physical verification above,
including the normal smoke self-test and notifications. Keep the stock driver
available for rollback. This patch preserves genuine reports; it does not alter
their frequency or make parameter 20 an unconditional heartbeat.

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
