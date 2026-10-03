# Home Assistant app setup

ST-MQ runs as a Home Assistant **app** (formerly called an add-on) on
**Home Assistant OS**, on `aarch64` including Raspberry Pi 5, or `amd64`.
Home Assistant Container has no app manager; run ST-MQ separately using the
[standalone instructions](docs/startup.md). ST-MQ is installed from
this repository as **Home Energy**, not through HACS or as a Home Assistant Core
integration. The project and installation slug remain `st-mq`.
See Home Assistant's [installation types](https://www.home-assistant.io/installation/#about-installation-types).

The 0.9.5-dev.1 development prerelease starts with **simulated devices and Pause heating**. Default
startup launches no live controller or provider. Live automation is enabled separately in each feature after configuring its connection. See [learning and control](docs/learning-and-control.md)
for the algorithm, native-setting restoration and equipment testing limits.
[Automation and manual heating](docs/automation-and-manual-control.md) explains
the independent feature controls and Garage local temperature regulation.

1. Open **Settings → Apps → Install app → ⋮ → Repositories**, add
   `https://github.com/hokkanen/st-mq` and install **Home Energy** from the
   **Home Energy apps** repository. The default branch, `main`, contains the
   integrated H66 work and the 0.9.5-dev.1 development prerelease. An existing
   repository configured with `#H66` needs the default repository source for
   this release.
   A Git tag or GitHub prerelease does not change the branch installed by HA.
   Home Assistant builds the image locally; the host needs network access for
   the build and enough free storage. If the repository does not appear, refresh
   the app store and inspect **Settings → System → Logs → Supervisor**.
   This follows Home Assistant's [third-party app installation](https://www.home-assistant.io/common-tasks/os/#installing-a-third-party-app-repository).
   For a local development installation, place the checkout in the local-app
   folder, `/local_apps/st-mq` in the current official Terminal & SSH app
   (`/addons/st-mq` in tools using the older mount), then choose **Check for
   updates** in the app store. It appears in **Local apps**.
2. Leave `controller.web_token` and `controller.web_family_token` empty to use
   Home Assistant ingress through your Home Assistant login. Every accepted
   ingress session has full ST-MQ admin access. Save settings on the app's **Configuration**
   tab. Set an admin password of at least 24 characters in `web_token`
   for optional direct access at `http://<HA-host-address>:1234`. Optionally set a different family
   password of at least 24 characters in `web_family_token`. Leave
   `controller.input: simulated` for initial review; Home defaults to Pause; Garage control is disabled by default.
3. Start ST-MQ and choose **Open Web UI** in Home Assistant. Ingress needs no
   separate application password or router port forwarding. **Start on boot**
   keeps ST-MQ running after a host restart; **Show in sidebar** adds the
   **Home Energy** entry and is optional.
   Direct access, when enabled, asks for either
   configured password and selects its role. The **Home Energy** UI clearly labels simulation.
   The header button switches between dark and light themes. The browser remembers
   the last choice across page loads, with green dark as the initial default.
4. The working database is under `/config/st-mq/`, in Home Assistant's public
   app folder. Terminal & SSH exposes it under
   `/app_configs/<repository-id>_st-mq/st-mq/`. Private provider token caches stay
   in `/data/st-mq/`. Both are included in the app backup; `/share` remains
   available for imports/exports. See the path and backup instructions below.
5. Historical import is optional. The [CSV import guide](docs/csv-import.md)
   accepts only v0.7.5 `st-mq.csv` and `easee.csv`. With a shell inside the ST-MQ
   container, run `node scripts/history.js import --db /config/st-mq/st-mq.sqlite
   --file /share/st-mq/st-mq.csv --kind stmq`, then import `easee.csv` with
   `--kind easee`. Terminal & SSH is a separate container and does not contain
   ST-MQ's Node executable or history script. Alternatively prepare a fresh
   database from those CSVs with the same ST-MQ version on standalone Linux,
   close its writer, and copy it into the public app folder while ST-MQ is stopped. Source CSVs stay outside the image.
6. Choose `controller.input: offline` to view imported history without device
   connections. Choose `providers` or `mqtt` for live temperatures and prices.
   Keep Home on **Paused** while reviewing plans. Configure the
   current direct equipment relay route in [equipment setup](docs/mqtt-equipment.md)
   and verify its device identity, command acceptance and fresh state readback, or
   commission H66 native control as described below. Then enable Home **Automatic** if desired. Configure Garage manual control separately.
   Disable the former heat/action automation; the current application does not
   publish heating commands through that protocol.
   Configure local indoor temperature subscriptions under `mqtt`: smoke channel 1
   supplies Upstairs, channel 2 Bedroom and channel 3 Downstairs. See
   [temperature configuration](docs/recording.md#local-mqtt-temperature-sensors-and-interface)
   for the topic fields and payload formats.
7. Follow [H66 MQTT setup](docs/h66-mqtt.md) to connect the gateway and set
   `controller.h66_device` to its exact MQTT prefix. Verify C60 telemetry, native
   settings and restoration before enabling automatic H66 control.
   **Home** opens **Heating configuration** with current settings;
   **Home → Sensors & Equipment → Ground-source heat pump** contains parameter
   controls and all readbacks. **Home → Heating configuration → Home learning** contains model evidence.

   Existing coordinates and market country enable FMI, Open-Meteo and Elering
   without new keys. ENTSO-E is primary for prices and Elering is the backup.
   Temperature and global radiation forecasts use FMI first, then Open-Meteo
   ICON Seamless. Missing FMI radiation can use Open-Meteo while retaining FMI
   temperature. Radiation includes cloud effects and uses W/m². Current outdoor
   temperature uses FMI station observations, then an Open-Meteo model estimate;
   H66 outdoor readings are excluded from the model's outdoor observation feed. Device
   temperatures arrive through MQTT, Easee collection runs every 15 seconds,
   outdoor weather every five minutes, forecasts every 30 minutes, prices hourly
   and H66 snapshot requests every minute.
8. Configure `electricity` in app options. Every monetary field explicitly
   **excludes VAT**; `vat_percent` applies VAT once to spot, margin, tax and transfer.
   Defaults are margin **0.33 c/kWh ex VAT**, tax **2.325 c/kWh ex VAT**, and
   **25.5% VAT**. These produce 0.41415 and 2.917875 c/kWh including VAT.
   Transfer defaults are stored excluding VAT and yield day/night **3.34/1.96**,
   seasonal winter daytime/other **4.17/2.07 c/kWh including VAT**. Day/night stays
   selected. All four amounts and the tariff are configurable.
9. Set the occupied preferred drop with `controller.max_drop_c` (default **1.5°C**).
   It does not constrain away cooling. Permanent settings are reported in the UI;
   change them in options, then use **Data & settings → Connections & configuration →
   Configuration → Check & review configuration**, inspect the diff, then choose
   **Apply reviewed configuration** (admin only).
   Browser-saved values cannot override these settings. Unknown or retired
   options are rejected; remove obsolete keys before starting the current version.

**Check & review configuration** reads freshly saved Home Assistant options from
Supervisor and validates them without changing the runtime or saving imports.
The admin-only diff conceals credentials and private values. Choose **Apply reviewed
configuration** to reconnect providers after reviewing the changes. A changed source
or a review older than five minutes requires another check; restart-only changes
disable application. Save options in Home Assistant before checking. This workflow
does not rely on `/data/options.json`, which Supervisor exports
when starting the app. **Applies without restart** lists price-control mode,
comfort limits, learning settings, electricity rates, recording interval, storage
budget and the direct-access token. With live input, provider connections,
location, sensor topics, polling intervals, H66 device selection and its
verification file are included. **Requires restart** lists input mode, web
address/port, data and database locations, and environment variables. Changed
startup settings reject the entire application of settings; use a restart for
those changes. Wait for ongoing heating operations and native setting tests to
finish. Existing equipment overrides are restored before reconnecting; pending
restoration blocks the update until equipment is available. An in-progress
automatic heating cycle ends, while Away and pause choices and learning history
remain. Startup environment overrides still apply.

You can also import private settings through the same check, review and apply
workflow. In Terminal & SSH, upload `secrets.json` to this app's configuration
folder. The UI displays the current official Terminal & SSH path, such as
`/app_configs/<actual-app-slug>/secrets.json`; inside ST-MQ it is
`/config/secrets.json`. Some third-party SSH/file apps expose `/addon_configs`
instead; keep the same slug and filename under that app's mounted prefix.
This is next to the `st-mq/` database folder, not inside it.
Use a **plain JSON options object without an outer `options` wrapper**. Keep the
file private while transferring it. For example, a sparse settings import can be:

```json
{
  "controller": { "max_drop_c": 0.8 },
  "electricity": { "margin_ct_per_kwh_ex_vat": 0.4 }
}
```

Only provided fields override saved options. Nested objects merge recursively;
arrays replace saved arrays; explicit empty values clear fields where an empty
value is valid. Before saving an import, ST-MQ fills missing schema-required
object/list containers with empty objects/lists, such as equipment `mqtt: {}`,
`readings: []` and `temperature_control: {}`. This only completes the Supervisor
configuration shape; it does not create device wiring or control permission.
Omitted fields preserve saved values. Invalid JSON or settings reject the import. Apply merges the upload over freshly saved Supervisor options,
saves the imported result in Home Assistant, then applies supported settings.
The uploaded file is deleted only after successful import and application. If
import or application fails, it stays for correction. If only file removal fails,
the UI reports successful application and asks you to delete the upload. Imported
values persist in Home Assistant after the file is removed. Existing `!secret`
references in untouched saved fields remain references; runtime values are
resolved through Supervisor. The import must contain actual values, not new
`!secret` references. Providing a value replaces that field's saved reference.

The **Configuration** section also reports live access status. Setting a valid
`controller.web_token` and applying enables direct admin access on port 1234.
`controller.web_family_token` optionally enables family access with a different
password. Family can read all pages, operate firewood (removal within 15 minutes),
DHWR, manual heating and Away/Pause, garage doors and all EV card
controls. Other writes, exports/downloads and settings administration require
admin; see [web access](docs/configuration.md#admin-and-family-web-access).

Changing a password applies immediately; affected direct-access tabs must use
the new password. Clearing both and applying disables direct access while Home
Assistant ingress remains available as admin. Direct login includes password
visibility and **Logout** under **Configuration**. Logging out clears that tab's
login without interrupting requested device operations. Ingress logout belongs
to Home Assistant. If `STMQ_API_TOKEN` or `STMQ_FAMILY_API_TOKEN` overrides an
option, change that environment override and restart to change it. Edit Supervisor-owned options through Home
Assistant or the import above; do not edit its exported `/data/options.json`
inside the running container.

The optional `electricity.effective_date` schedules rates at Finnish midnight.
Without a date, first-use rates start today; later rate changes start when loaded.
Previous rate periods retain their VAT and transfer values. Future periods can be
corrected before they start. Present-day defaults do not manufacture historical
rate coverage. Day/night applies 07:00–22:00 versus other times; seasonal winter
daytime applies November–March, Monday–Saturday 07:00–22:00.

The main chart defaults to today's complete Finnish calendar day. Choose a start
date to view one day immediately; the second date picker extends the inclusive
range immediately. Both pickers remain available in chart inspection mode. **Yesterday – today**, **Today**,
**Today – tomorrow** shortcuts keep both observations and forecasts within the
selected dates. The small outer arrows move the shown window one calendar day
back or forward while preserving its length. The **Left axis** drawer offers
Power, phase currents, home temperatures, live heating integral,
solar radiation and all four historical learning metrics. **Average indoor**, Garage, outdoor temperature and prices remain
available on the right with their existing colours. Average indoor is the configured
sensor average used by the house model, with equal weights for Upstairs, Bedroom
and Downstairs when all three are configured with defaults. Missing contributing
readings remain gaps; imported learning keeps its original Upstairs measurement.
**Home and garage temperatures** in the left drawer adds the three individual room
readings and Garage front with synchronized air-temperature scales. Garage remains available on
the right axis. For rare sensor replacements, moves or calibrations, open **Home →
Heating configuration → Home learning → Model inputs → Average indoor → Sensor changes**. Its
**Reason** field describes the saved history; it does not alter the learning effect.
Whole-house and EV power estimates use recorded
phase-energy increments divided by their actual intervals. Equivalent chart
currents use the applicable recorded per-phase voltage estimates and assume
unity power factor. Older current-only CSV history uses the first established
voltage estimates retrospectively where no earlier estimate exists; missing
voltage leaves the derived power unavailable. H66 AUX power is a red fill derived from the
configured rated power (9 kW by default), with Charger 1 and Charger 2 stacked
above it. Compressor space heating is yellow, hot-water heating blue, and heat-off
requests use a light crossed hatch. Red DHWR requests occupy their own strip
below the chart; saved legend choices persist. A separate strip
shows observed native operating mode.

The chart's **Energy cost comparisons** fold contains **Heating**, **Charging**
and **Fireplace**. Heating starts on **Home** and **Model estimate**, unless a
previous **Timing cost** choice was saved. It offers **Home**, **Garage** and
**Total** scopes. Charging offers **Charger 1**, **Charger 2** and **Total** for
timing comparisons. The cards appear side by side with matching comparison
indicators; narrow screens stack the results. Heating can switch between
**Model estimate** and **Timing cost**. Fireplace uses a separate model reference
and is not added to either comparison. Shared guidance is in the **How these
comparisons work** fold. Timing and completed-cycle details show the cost operands
behind the difference, with included kWh where applicable.
Underlined labels
open explanations on hover, keyboard focus or tap. Escape or an outside tap
closes the explanation.

Heating's **Model estimate** sums supported, saved assessments of completed cycles,
using each cycle's frozen model and including recovery. Domestic hot water is
excluded. Full cycles count on their Finnish completion date, even if they began
before the selection; active, incomplete and unsupported cycles do not contribute.
Assessment counts describe this scope, not elapsed-time coverage. Home's execution
electricity uses a temperature-dependent heat-pump source estimate, not a separate
meter. Garage has no model estimate. Its electrical timing comparison uses
qualified dedicated measurements without claiming automatic-control savings.
These totals differ from the Learning view's rolling €/cycle mean and charger
session cost estimates.

Heating's **Timing cost** and Charging hold the included daily energy fixed and
compare its cost at the recorded times with each full Finnish day's
duration-weighted average all-in price. Each timing comparison identifies its
energy basis. Home heat-pump electricity, including domestic hot water, is estimated
from recorded compressor activity and auxiliary output using dated nominal
compressor, circulation and auxiliary power assumptions. It therefore differs
from the Home cycle electricity estimate even before scope and dates differ.
Garage timing requires qualified dedicated electrical intervals. Charger electricity
uses recorded phase or total energy intervals, with historical per-phase voltage
estimates for older current-only history. The pre-estimate CSV fallback is an
explicit retrospective assumption. Simulation is identified separately. The
included-time mix is duration-weighted, not a percentage of samples, energy or
accuracy. Auxiliary consumption remains a nominal estimate even when its output
is observed. Historical calculations use saved equipment readings and assumptions;
missing inputs or dated power assumptions leave gaps, and current sensors or
model predictions never fill them. Source details report the contributing input
times; these are not a claim of continuous observations between those times.

In timing views, **Time included** is the fraction of selected elapsed time used
in the comparison. Heating Total uses combined Home and Garage system-time;
Charging Total uses charger-time, so simultaneous use counts for each charger.
Heating includes valid zero-power intervals; charging includes only recorded
periods above 100 W with complete daily prices, keeping idle periods separate
from missing readings. For today the elapsed selection ends at
the calculation time, not the following midnight. The details distinguish time
without power inputs from power inputs excluded because a full day's prices are
missing. The result is never extrapolated to excluded time. Recorded energy
retains its explicit interval bounds, and reconstructed heat-pump intervals are
bounded by source freshness and availability. Older charger snapshots are held
for at most 30 minutes; these holds are not new measurements. Calculations use
the underlying intervals independently of chart point reduction and the selected
left axis. An unfinished day is identified separately from incomplete historical
coverage.

Missing historical contract periods use the nearest known rates with historical
spot prices and the historical Finnish tariff hour. With only today's rates
recorded, earlier entries use those rates. **Assumed rates** explains which
included periods depend on that assumption, including the full-day average.
This price-assumption share is separate from the energy evidence mix and does
not imply a statistical confidence level.

Historical scalar spot readings supply their containing 15-minute price slot,
allowing for small logging delays. Missing slots stay missing, and a complete
day's spot prices are still required for its daily average. Missing energy
periods are excluded. Imported CSV phase currents can provide older charger
energy estimates, but those files lack the H66 equipment readings needed to
reconstruct heat-pump consumption. These timing comparisons are distinct from
the learning metrics' modelled full-cycle profit.
Missing AUX routing, solar forecasts or complete recovery evidence stays unknown.
Learning values are stored as learned; new forecasts and models do not rewrite
earlier learning chart samples.

## Using the application

Empty direct-access passwords leave port 1234 closed; Home Assistant ingress
remains available through Home Assistant login with full application admin
access. Saved app options own permanent settings. See the
[configuration guide](docs/configuration.md) for reviewed changes, password
roles, electricity rates and the controls that retain independent intent.

Home uses Automatic/Pause and scoped manual heating; Garage uses persistent
Normal/Away targets with independent local frost protection. Each charging
integration and Caravan Automatic power has its own permission. Opening a
connection or selecting live input does not enable all controls.

- [Home heating and restoration](docs/automation-and-manual-control.md)
- [Heating plan explorer](docs/heating-plan-explorer.md)
- [Garage targets, equipment and protection](docs/garage.md)
- [Charging setup, controls and reports](docs/charging.md)
- [Charts, recording and unknown data](docs/recording.md)
- [MQTT equipment setup](docs/mqtt-equipment.md)

Current outdoor temperature uses FMI station observations, with an Open-Meteo
model estimate as backup. H66 outdoor measurements do not supply outdoor
control, learning or new recorded temperature history. Provider details retain
source ages, unknown states and backup/retry information; refreshing the page
or reconnecting does not make cached observations fresh.

The controller distinguishes broker delivery, native readback and physical heat
production. H66 restoration needs a reachable application and gateway; there is
no documented device-local expiry. Compressor-only reduction can skip the
native 14-day high-temperature water cycle under the current control design.
Read the [learning and control limits](docs/learning-and-control.md) before live
commissioning. The planned SONOFF floor interface remains unsupported, so floor
activation and commissioning are unavailable.

Normal tests are offline. The separately invoked [live diagnostics](docs/live-testing.md)
check configured APIs without starting the controller or connecting to MQTT;
API access does not commission physical equipment. The Dockerfile uses an
explicit Node 22 Alpine base, a finite frontend build and `npm ci`, with no
`BUILD_FROM` argument or retired `build.yaml`. See
[development validation](docs/development-validation.md) for the independent
browser, container and Supervisor boundaries.

## SSH database access and backups

The folder arrangement follows Home Assistant's [public app configuration
support](https://developers.home-assistant.io/docs/apps/configuration/#app-advanced-options).
This `/config` is ST-MQ's own app folder, not Home Assistant Core's configuration
folder. It is included when **Home Energy** is selected for backup; `/share` is a separate
backup selection.

| Purpose | Inside ST-MQ | In Terminal & SSH |
| --- | --- | --- |
| Active household database | `/config/st-mq/st-mq.sqlite` | `/app_configs/<repository-id>_st-mq/st-mq/st-mq.sqlite` |
| Simulation database | `/config/st-mq/simulation.sqlite` | Same public folder, `simulation.sqlite` |
| Options and provider tokens | `/data/options.json`, `/data/st-mq/` | Private to ST-MQ |
| Temporary settings import | `/config/secrets.json` | `/app_configs/<actual-app-slug>/secrets.json` |
| CSV imports and exported backups | `/share/st-mq/` | `/share/st-mq/` |

The current official [Terminal & SSH app](https://github.com/home-assistant/addons/blob/master/ssh/config.yaml)
mounts other apps' configuration at `/app_configs`; find ST-MQ with
`ls -d /app_configs/*_st-mq`. Some third-party tools, including
[Advanced SSH & Web Terminal](https://github.com/hassio-addons/addon-ssh/blob/main/ssh/config.yaml),
still use `/addon_configs`; use that mounted prefix with the same ST-MQ folder
name. Locally installed apps use `local_st-mq`; a Git repository uses its
repository identifier. The configuration screen supplies ST-MQ's actual slug
with the current official path. `/share` is the shared import/export mount. The `st-mq` slug preserves installation identity.
Keep private subdirectories at mode `0700` and files at `0600`; use an
appropriately privileged file tool instead of making the database world-readable.

ST-MQ opens only the explicitly selected current database path. It does not
discover or relocate development databases. An incompatible or malformed
database is rejected unchanged. For a clean development start, select a fresh
path and re-import the supported v0.7.5 CSV files if needed. Current-schema
backup/restore remains available; restoration never overwrites an existing file.

Use **Settings → System → Backups** and include **Home Energy** for ordinary recovery.
The manifest requests **cold backup**, so Supervisor stops a running ST-MQ while
capturing its database and starts it again afterward. Acquisition and ST-MQ
control are unavailable during that stop; independent device protection remains
with the devices. Include **Share** separately if its imports/exports also need
backing up. Restore ST-MQ together with its options and private data. Database
exports alone do not include provider tokens or Supervisor options.

For a browser download, use **Recording details → Export database → Download
database**. For **Save local copy**, configure `recording.export_directory` as
`/config/st-mq/exports` (included with the app) or `/share/st-mq` (separate Share
backup). The shared default `"~"` resolves inside the container and is not a
persistent backup location there.

These commands run **inside the ST-MQ container**, where Node and the history
administration script are installed:

```sh
node scripts/history.js summary
node scripts/history.js backup --output /share/st-mq/manual-backup.sqlite
node scripts/history.js export --output /share/st-mq/indoor.csv --signal indoor_temperature
```

The backup command uses SQLite's online backup API and requires a new destination.
From Terminal & SSH, a SQLite client can also inspect the public database or create
a consistent backup with its `.backup` command. Do not copy just the active `.sqlite`
file while ST-MQ is running: recent committed data may be in its `-wal` file.

For manual edits or raw file copies, stop ST-MQ through Home Assistant first and
make a backup. Work on a copy, run `PRAGMA quick_check;`, and retain the original
until the edited copy is verified. Restoring the complete HA app backup is the
usual route; the history CLI can restore a snapshot to a new database path.
Options are owned by Supervisor: edit and save them through app configuration,
or upload the sparse import described above, then choose **Apply reviewed configuration**.
The temporary upload is not a permanent settings file; Supervisor retains the
successfully imported values.

## Moving from an earlier version

Back up the installed app, its options and any original CSV exports before
replacing it. Publishing 0.9.5-dev.1 on `main` makes it available from the default
repository; it does not convert an existing installation's saved options or
database. An app configured with `#H66` needs the default repository source for
this release; publishing a tag does not change that setting.

The 0.7.5 runtime and configuration are not upgrade inputs. Configure the current
version from its current options and use a fresh database, then optionally import
the supported original [0.7.5 CSV files](docs/csv-import.md). Unknown or retired
settings and incompatible development databases are rejected, without automatic
translation or reset. Select a fresh database directory explicitly and retain the
old data; do not delete a database merely to clear a startup error. A matching
current-format backup can still be restored using the backup workflow above.

Review outstanding equipment changes and restoration duties before replacing a
live controller. Keep one command owner, begin evaluation with simulated input,
and commission live integrations and each feature's control permission
separately. Changing an application version does not verify installed equipment
or grant new control authority.

## Home Assistant files and permissions

The [current app format](https://developers.home-assistant.io/docs/apps/configuration/)
still supports `config.json` and `translations/en.yaml`; renaming them is not
required by the change from “add-ons” to “apps”.

| File or directory | Current purpose |
| --- | --- |
| `config.json` | App identity, architectures, startup, ingress, mounts, capabilities, shared defaults and Supervisor option schema. |
| `translations/en.yaml` | English names and descriptions for the app's Configuration form; `configuration` keys follow the schema. There is no `network` section because host networking has no remappable ports. It does not translate the ST-MQ dashboard. |
| `repository.yaml` | Repository name, URL and maintainer shown in the app store. |
| `Dockerfile`, `.dockerignore` | Reproducible application image and build context. Startup runs `node src/main.js`; no `run.sh` is required. |
| `README.md`, `DOCS.md`, `CHANGELOG.md`, `icon.png`, `logo.png` | App store presentation, setup guidance, release history and branding. |
| `integrations/homeassistant/` | Optional MQTT automation generators and the pinned Tuya Local adapter. Install only the integrations you use; installing ST-MQ does not install them into Core. |
| `scripts/test-addon-container.sh`, `test/browser/ingress-smoke.js`, `test/extended/supervisor/` | Isolated deployment, ingress and upstream Supervisor configuration checks. |

The manifest maps writable `app_config` explicitly to ST-MQ's `/config` and
`share:rw` to `/share`.
Current [Supervisor mount handling](https://github.com/home-assistant/supervisor/blob/64ea3be4322537fd5dcfbf620c4dc25490c1f56d/supervisor/docker/app.py)
uses `app_config`; the older `addon_config` name is deprecated. ST-MQ's own
`/config` and stored app directory stay the same; file tools expose them under
their chosen `/app_configs` or `/addon_configs` mount. ST-MQ does not mount
Home Assistant Core's configuration. The historical
`HASS_files/` folder is not part of the installation.

Host networking and `NET_ADMIN` / `NET_RAW` support the optional paired-host
virtual MQTT address; see [pairing](docs/pairing.md#mqtt-address-management).
Home Assistant port remapping does not change listeners in host-network mode.
Direct HTTP uses host port 1234 when enabled. Supervisor assigns an available
ingress port because the manifest declares `ingress_port: 0`; ST-MQ reads that
assignment before opening listeners. The ingress listener accepts only the
Supervisor proxy.

Home Assistant shows the **Home Energy** sidebar entry to administrators, but
`panel_admin` controls visibility only. Every accepted ingress session has full
ST-MQ admin access, including sessions obtained by authenticated Home Assistant
nonadministrators. Family restrictions apply only to direct access with the
family password; ingress does not apply that role. This follows the current
[Core ingress API permissions](https://github.com/home-assistant/core/blob/2026.9.4/homeassistant/components/hassio/websocket_api.py)
and [Supervisor session handling](https://github.com/home-assistant/supervisor/blob/2026.09.3/supervisor/api/ingress.py).

Leave protection mode enabled; neither Docker API access nor unrestricted
host access is needed. Reading and saving ST-MQ's own options uses Supervisor's
self endpoints with its default app role, without management access to other
apps or a Home Assistant Core API token.

## MQTT and optional Home Assistant integrations

For live MQTT input, configure `mqtt.address`, `mqtt.user` and `mqtt.pw` in ST-MQ's
saved options. The default `mqtt://core-mosquitto` targets Home Assistant's
Mosquitto broker app; supply a login allowed by that broker. ST-MQ does not copy
credentials from Home Assistant's MQTT integration. A separate broker needs its
own reachable address. `simulated` and `offline` modes need no broker.

The optional [door publishers](docs/homeassistant-mqtt.md), [BMW CarData feed](docs/bmw-cardata.md)
and [Caravan dehumidifier bridge](docs/caravan-dehumidifier.md) require Home
Assistant Core's MQTT integration connected to the same broker. Source entities
and generated household automations remain private. These bridges are separate
from the ST-MQ app and from its English configuration descriptions.

## Startup and troubleshooting

Use ST-MQ's **Logs** tab or **Settings → System → Logs** to inspect startup errors.
Restart or stop the app from **Settings → Apps → Home Energy**; restarting Home Assistant
Core alone does not restart ST-MQ. If a host port is occupied, resolve the existing
listener before retrying; see [startup](docs/startup.md). A database-format error
requires an explicit fresh path or compatible backup, never deletion by startup.

After saving options, use the review/apply workflow above for supported live
changes, or restart for input/topology and other startup-only settings. If ingress
reports the app is unavailable, first confirm ST-MQ is running and inspect its
startup log. An unavailable Supervisor or invalid ingress assignment blocks
startup; ST-MQ does not guess a fixed port. Port 1234 is deliberately closed
while direct passwords are empty;
use **Open Web UI** through ingress in that case.

## Reproducing deployment checks

```sh
docker build -t st-mq:development .
scripts/test-addon-container.sh st-mq:development
```

The check uses temporary `/data`, `/config` and `/share` mounts, synthetic options,
the actual image startup command, authentication, current-schema persistence, restart and
backup/restore. A separate container verifies direct database access from the
public folder. Networking is disabled. The extended CI workflow defines AMD64
and ARM64 jobs under QEMU. Architecture-specific execution and installed-platform
checks remain separate; see [validation scope](docs/development-validation.md#release-validation-and-known-limits).

Run `bash scripts/test-homeassistant-supervisor.sh` to validate the current
manifest, translations and saved-options behavior against pinned released
Supervisor **2026.09.3**, without starting Supervisor. This check also runs on
pushes and pull requests. See [development validation](docs/development-validation.md#home-assistant-supervisor-contract)
for prerequisites and scope. Neither these fixtures nor
an ordinary Docker run establish a real Supervisor installation, protection
policy, backup/restore, or physical Raspberry Pi operation. A disposable Home
Assistant OS installation is the remaining acceptance environment for those
checks. Running these isolated validators does not install or restart an
existing app.
