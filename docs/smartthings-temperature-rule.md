# Fibaro temperature reporting through SmartThings

Fibaro FGSD-002 smoke sensors need the modified Edge driver supplied with st-mq
when genuine, unchanged temperature reports must reach MQTT. The standard
reporting path can suppress repeated values, and the detector's temperature
report interval is change-conditional. Selecting 15 minutes there does not
establish a fresh unchanged-value report every 15 minutes.

The modified driver marks each received temperature report as an event and
requests a fresh measurement on wake-up. An independent SmartThings Rule forwards
that event to an MQTT temperature publisher. st-mq records value changes and
compact report coverage, so a confirmed unchanged value remains a continuous
line while missing reports produce gaps and exclude affected learning windows.
No timer in this path should manufacture readings from a cached temperature.

## Source and reasons for the modifications

The complete buildable source is in
[integrations/smartthings/fibaro-temperature/driver](../integrations/smartthings/fibaro-temperature/driver).
It is about 83 KiB across 31 files, including the original support files and SDK
tests. Keeping this small package alongside the exact patch avoids depending on
an upstream download to recover the driver. The
[package README](../integrations/smartthings/fibaro-temperature/README.md) explains
building from this checkout and reconstructing from pinned upstream source.

| Modification | Reason |
| --- | --- |
| Separate package name/key: **ST-MQ Fibaro Temperature Reports** / `stmq-fibaro-temperature-reports` | Keep the customized package identifiable and preserve the stock driver for rollback. |
| `state_change = true` on genuine Fibaro temperature events | Allow repeated values to reach SmartThings subscriptions and Rules. Values, Celsius/Fahrenheit units and source endpoints are preserved; invalid reports are ignored. |
| Wake-up selector, default 70 minutes | Request fresh measurements even during stable temperature; parameter 20 alone does not establish this cadence. |
| Wake-up capabilities query, Set/Get and persisted interval/controller readback | Check advertised limits and distinguish an attempted setting from an accepted one; retry missing or mismatched readback on a later wake. |
| Embedded preferences and first-wake application of their current selections | Provide consistent defaults and send them even when the SDK's initial snapshot already contains those values. |
| Current local preference IDs and count diagnostics | Match the bundled profiles to the sender and detect missing current preferences without logging their values. |
| One forwarding Rule per physical source, with `changesOnly: false` | Preserve equal-value confirmations without copying another sensor's cached value. |

Six upstream files differ: package configuration, two Fibaro profiles,
the Fibaro subdriver, parent preference sender and preference-ID table. Smoke/tamper/heat handlers,
other device support and the existing Configuration parameter mappings remain
inherited. The stock wake-up handler's smoke-clear event and `health_check = false`
policy are also retained. These are not new alarm-verification mechanisms.

The temperature override applies to the Fibaro fingerprint family with
manufacturer `0x010F`, product type `0x0C02`, and product IDs `0x1002`, `0x1003`,
`0x3002` or `0x4002`. The complete package includes additional stock fingerprints;
select the intended devices explicitly instead of treating every match as a
reason to change its driver.

## Default selections and limitations

These are the package's default selections, not readback of detector parameters:

| Setting | Default selection | Raw value |
| --- | --- | --- |
| Smoke sensor sensitivity | Medium, as labelled in the inherited UI | `1` |
| Extra Z-Wave notifications | None | `0` |
| Extra visual notifications | None | `0` |
| Extra sound notifications | None | `0` |
| Temperature report interval | 15 minutes | `90` |
| Temperature report hysteresis | 0.1°C change | `1` |
| Temperature report threshold | 1°C / 2°F, as labelled in the inherited UI | `10` |
| Overheat signalling interval | 30 minutes | `180` |
| Lack-of-range indication interval | 1 hour | `360` |
| Wake-up interval | 70 minutes | `4200` seconds |

The wake-up selector also offers two, three, six and twelve hours. Its default
is not a claim that every hardware revision accepts that interval. Inspect
`IntervalCapabilitiesReport` and confirm the actual selected interval through
`IntervalReport`. Until a sleeping sensor wakes, its previous interval remains
in force. A manual wake-up can expedite configuration but is not required for
normal installation. The driver also attempts wake-up configuration when added;
the regular wake-up path retries it if readback is missing or mismatched.

The first wake of each driver runtime queries capabilities. Reported minimum and
maximum limits are saved; a selection outside known limits is not written. Once
readback matches the selected interval and hub controller, repeated writes are
suppressed, but later wakes still query the interval and request fresh battery
and temperature reports. This is a radio request/response path, not a guarantee
that every scheduled report will arrive.

Embedded preference names use local IDs such as `tempReportInterval`; dotted
`certifiedpreferences.*` names cannot be embedded this way. The bundled profiles
and sender share one current ID set. Namespaced values do not supply a fallback.
Review the current settings after installing the package; valid local values,
including zero, are preserved.

Once all nine local Configuration settings are available, their current values
are attempted together on a real wake-up. A persisted marker records completion
of those sends, not detector acknowledgement. An interrupted send attempt is
retried on a later wake. Later setting changes use the normal deferred preference
callback. The wake-up selector is never sent as a Configuration parameter.

**Inherited device mapping:** the threshold UI describes a reporting difference,
but the driver maps its raw value to parameter 30, the absolute excess-temperature
threshold, retaining the existing two-byte size. Raw `10` therefore requests a
10°C threshold if accepted; it is not the report hysteresis. Parameter 21 is the
separate hysteresis preference. The inherited sensitivity label for raw `1`
says Medium, while the manufacturer's parameter meaning is High. These labels,
encodings and parameter sizes have not been repaired by the reporting change.
Consult the [FGSD-002 manual](https://manuals.fibaro.com/content/manuals/en/FGSD-002/FGSD-002-EN-A-v1.1.pdf)
when choosing detector settings. Extra notification settings are separate from
the main smoke alarm.

## Build and install the driver

Use an authenticated SmartThings CLI with access to the target hub. For source
validation, install Python 3 with PyYAML, `patch`, and Lua 5.3/5.4 or `texlua`.
The CLI is needed for packaging/upload; the Lua SDK is not needed for the focused
source tests. From the st-mq repository root:

```bash
python3 integrations/smartthings/fibaro-temperature/tests/verify_source.py
python3 integrations/smartthings/fibaro-temperature/build.py /tmp/stmq-fibaro-temperature.zip
sha256sum /tmp/stmq-fibaro-temperature.zip
```

The helper builds without uploading. It stages SmartThings' required `config.yml`
outside the checkout from `driver/config.yml.template`, preventing Home Assistant
from detecting it as another app manifest. Choose a new ZIP path outside the
repository; existing outputs are never overwritten.

Keep deployment requests, responses, errors, identifiers, original assignments,
preferences and logs outside Git in a new private backup directory. Use directory
mode `0700`, file mode `0600`, and `umask 077` before creating files. Retain the
exact ZIP, its digest and the uploaded driver/version response for restoration.
See [private configuration](secret-handling.md). Use these saved deployment
records to identify the channel, hub, devices and versions during restoration.

The commands below are templates. Replace angle-bracket placeholders with the
privately verified identifiers. Capture both stdout and stderr privately, for
example by appending `> <private-result-file> 2> <private-error-file>` to each
command. Do not paste their unredacted output into Git or shared logs.

1. Inspect `smartthings devices --json` and select each intended detector by its
   identity and fingerprint. Save its hub, original driver, profile, preferences
   and physical-to-MQTT mapping. Keep the original stock driver installed for
   rollback. Record the stock ID separately if the current driver is already
   a custom version.
2. Upload the validated artifact:
   `smartthings edge:drivers:package --upload /tmp/stmq-fibaro-temperature.zip --json`.
   Save the returned driver ID and exact version. Reuse the existing custom
   package identity on subsequent uploads.
3. Reuse an existing private driver channel, or create one with
   `smartthings edge:channels:create --input <private-channel-request.json> --json`.
   A channel request can use these public fields:

   ```json
   {
     "name": "ST-MQ private drivers",
     "description": "Custom drivers maintained with st-mq",
     "type": "DRIVER",
     "termsOfServiceUrl": "https://www.apache.org/licenses/LICENSE-2.0"
   }
   ```

   Save the returned channel ID. Enroll the hub, if it is not already enrolled:
   `smartthings edge:channels:enroll <hub-id> --channel <channel-id>`.
4. Assign and install the exact version:
   `smartthings edge:channels:assign <driver-id> <version> --channel <channel-id>`
   followed by
   `smartthings edge:drivers:install <driver-id> --hub <hub-id> --channel <channel-id>`.
   Read `smartthings edge:drivers:installed --hub <hub-id> --json` and verify the
   driver ID/version before switching devices. Allow asynchronous hub delivery
   to finish and confirm driver initialization in the private log.
5. For each intended detector using a different driver, run
   `smartthings edge:drivers:switch <device-id> --hub <hub-id> --driver <driver-id>`.
   Read it back with `smartthings devices <device-id> --json` and verify
   `zwave.driverId`. Devices already using this driver share the installed
   version update. No exclusion, reset or re-pairing is required.
6. Read `smartthings devices:preferences <device-id> --json` and
   `smartthings deviceprofiles <profile-id> --json`. Check the ten settings and
   actual selections, including the wake-up selector. Also inspect hub preference
   counts as described below: cloud settings alone do not prove the hub loaded
   the new preference IDs.
7. Allow natural wake-up to apply pending radio settings. If immediate verification
   is useful, use the detector's documented manual wake-up procedure. A hub or
   st-mq restart is not a substitute for a sleeping detector waking.

The [SmartThings channel guide](https://developer.smartthings.com/docs/devices/hub-connected/driver-channels)
describes channel ownership, enrollment and deployment commands. Uploading source,
assigning a channel version, installing it on a hub and assigning a device are
separate operations; verify each relevant result.

## Set up forwarding to MQTT

Install/configure an MQTT temperature virtual device capable of the
`partyvoice23922.vtempset.setvTemp` command, such as the
[MQTT Devices publisher](https://github.com/toddaustin07/MQTTDevices).
Enable publishing and give each physical sensor's destination a distinct exact
MQTT topic configured in st-mq. The supplied Rule forwards the numeric value
without conversion and uses a Celsius lower bound, so use Celsius throughout
this forwarding setup.

Copy [temperature-report-rule.template.json](smartthings/temperature-report-rule.template.json)
to a private file. Replace both `REPLACE_PHYSICAL_SENSOR_ID` occurrences, the
`REPLACE_MQTT_TEMPERATURE_DEVICE_ID` occurrence and the Rule name. Use one Rule
per physical source. Create and read it back with:

```text
smartthings rules:create --location <location-id> --input <private-rule.json> --json
smartthings rules <rule-id> --location <location-id> --json
```

Save the submitted JSON and returned Rule ID. Confirm the installed definition
matches, and check its enabled/execution status. When replacing an old Rule,
back it up first and remove its duplicate forwarding path after the replacement
is verified. Inspect existing Rules before restoring one, to avoid duplicates.
A missing Rule can be recreated from its private submitted JSON, or from the
sanitized template plus the current verified mapping.

The numeric condition uses `changesOnly: false`, the physical source uses
`trigger: Always`, and the lower bound is absolute zero in Celsius. Do not add
`changes`, a source/destination inequality, a timer, or another sensor's cached
value. Do not manually execute the Rule as a freshness test. A new MQTT arrival
must originate from a real physical report. See the
[Rules documentation](https://developer.smartthings.com/docs/automations/rules).

Driver installation does not create MQTT subscriptions, forwarding Rules or model
inputs. Configure the desired st-mq topics and membership separately using
[recording configuration](recording.md#local-mqtt-temperature-sensors-and-interface).

## Matching the st-mq report deadline

| Clock | Purpose |
| --- | --- |
| Detector parameter 20, default 15 minutes | Change-conditional temperature reporting |
| Driver wake-up selector, default 70 minutes | Request fresh temperature on actual wake-up after the interval is accepted |
| st-mq expected report interval, default 70 minutes plus 300 seconds grace | Deadline for genuine incoming MQTT evidence; does not program the detector |
| Recording | Actual indoor value/availability changes are saved; genuine unchanged reports extend compact coverage without a forced periodic row |
| Learning windows, 15 minutes | Existing journal/learning cadence, independent of wake-up interval |

For a verified 70-minute physical/MQTT stream, set
`mqtt.temperature_report_interval_minutes` to `70` and
`mqtt.temperature_report_grace_seconds` to `300`. These are the public defaults
and give an exact 75-minute deadline. Older 15-minute interval settings should
be removed or updated to avoid declaring stable sensors missing before their
next expected wake. The interval/grace policy is shared by the
configured dedicated indoor MQTT topics; it is not set per detector.

Save/apply through the normal configuration workflow and check the active policy
in the temperature availability details. The driver selector does not change
st-mq configuration. Changing the deadline establishes a forward-only boundary;
a genuine report younger than the new limit can remain valid from that point,
but the change cannot fill past gaps or renew retained data.
Use interval `0` only for the explicit older change-only policy, which retains a
known value indefinitely and gives up missed-periodic-report detection.

Unchanged genuine reports extend compact coverage without extra temperature rows.
Value and availability changes are saved. A missed deadline ends coverage and
leaves a chart gap; recovery starts a new covered segment, even at the same value.
Affected learning windows are excluded rather than redistributing weights to
remaining rooms. Normal heating remains available. See
[temperature coverage and learning](temperature-sensors.md).

## Verify and troubleshoot

Capture driver output privately with
`smartthings edge:drivers:logcat <driver-id> --hub-address <hub-local-address> --log-level debug`.
Stop the capture when finished; unattended waiting is not required for setup.
For later cadence checks, retain timestamped evidence over several natural wakes.

Check these independently:

1. **Driver and profile:** correct installed version, intended device assignment,
   ten selections, and the nine mapped local preferences loaded in the hub.
2. **Radio configuration:** `IntervalCapabilitiesReport` advertises limits;
   `IntervalReport` returns the chosen seconds and hub controller node. A Set log
   or visible selection is not acceptance. Configuration send logs likewise do
   not prove that each detector parameter was accepted.
3. **Genuine events:** each received temperature response emits a temperature
   capability event with `state_change=true`, including consecutive equal values.
4. **Forwarding:** each event reaches only its matching MQTT publisher and yields
   a non-retained MQTT arrival. Retained reconnect data must not renew coverage.
5. **Automatic delivery:** observe several natural intervals during stable
   temperature. A manual wake-up test alone does not verify cadence.
6. **Alarm behavior:** use the manufacturer's separate self-test procedure and
   check audible behavior and expected remote notifications separately. Temperature
   success or a cached smoke-clear state does not verify alarm delivery.

Initialization diagnostics report `mapped`, `local` and `attempted`.
For the modified Fibaro profile, `mapped=9 local=9` means the current
Configuration setting IDs are available; the separate wake-up selector is not
part of that count. `attempted=true` records a completed send attempt only.

If the hub reports fewer than nine local Configuration settings, verify that the
installed package and assigned profile match this checkout, then review its
current selections. A missing current preference is not synthesized from an
older ID. Installing or switching a driver remains a separate owner operation.

If reports are visible in Edge but absent from MQTT, check Rule filtering,
source/destination mapping and publisher enablement. If MQTT reports arrive but
st-mq declares an outage between expected wakes, inspect its separate report
deadline. Missing radio readback remains pending; the driver retries on a later
wake, and no cached report should be substituted for missing evidence.

## Update, reinstall or roll back

Editing this checkout or receiving upstream source changes does not update the
hub package. To deploy a new version, build/upload it, assign that exact version
to the private channel and install it on the hub, then repeat the relevant checks.
An installed version change affects every device using that driver ID on the hub.
A driver-version deployment is therefore different from switching one device.

To reinstall an archived version, use its saved upload response, channel ID and
exact version in installation step 4; re-uploading is unnecessary while that
version remains available. If enrollment was removed, enroll the hub again.
Verify assignments, preferences and radio behavior afterward. If cloud records
or the ZIP are unavailable, rebuild the bundled source or reconstruct the pinned
package using the [source recovery instructions](../integrations/smartthings/fibaro-temperature/README.md#reconstruct-from-upstream),
then create/reuse a channel and follow the normal installation steps.

To roll back selected devices to stock, use the original stock driver IDs saved
before customization, confirm stock is installed, switch only those devices,
and verify their assignments, preferences and wake-up intervals. A backup taken
after customization may name a custom driver as the previous driver, so it is
not sufficient evidence of the original stock ID. To restore an earlier custom
version, deploy its archived version while accounting for every device sharing
that driver ID. Keep working independent forwarding Rules; driver rollback does
not require restoring filters that discard equal-value confirmations.
