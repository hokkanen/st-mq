# Home Assistant add-on setup

The 0.8.3 application starts with **simulated devices and shadow plans**. Default
startup launches no live controller or provider. Implementation is not production commissioned;
see [progress and remaining work](docs/PROGRESS.md).

1. Build/install ST-MQ through the repository's existing add-on mechanism on
   `aarch64` (Raspberry Pi 5) or `amd64`.
2. In the add-on configuration, set `controller.web_token` to a private token of
   at least 24 characters. It protects household data and settings. Leave
   `controller.input: simulated` and `controller.mode: shadow` for initial review.
3. Start the add-on and open the web UI on its mapped port (default 1234). Enter
   that token in the browser. The **Home Energy** UI clearly labels simulation.
   Each page load starts in the green dark theme; the header button switches to
   the light theme for the current page.
4. The working database is under `/config/st-mq/`, in Home Assistant's public
   add-on folder. Terminal & SSH exposes it under
   `/addon_configs/<repository-id>_st-mq/st-mq/`. Private provider token caches stay
   in `/data/st-mq/`. Both are included in the add-on backup; `/share` remains
   available for imports/exports. See the path and backup instructions below.
5. Import history explicitly with `node scripts/history.js import --db
   /config/st-mq/st-mq.sqlite --file /share/st-mq/st-mq-corrected.csv --kind stmq`,
   then import Easee with `--kind easee`. Input files are never included in the
   application image.
6. Choose `controller.input: offline` to view imported history and rebuild its
   model without device connections. `mqtt` additionally requires verified H66
   installation and `controller.h66_device`; acquisition is read-only and runs
   alongside the online providers. Optional `controller.h66_verification_file`
   names a verified register-scaling file, relative to `/config` or absolute.
   MQTT connection fields reuse the existing configuration.
7. Choose `controller.input: providers` for read-only acquisition. Existing
   latitude/longitude and market country enable the public FMI and Elering
   providers without new keys. ENTSO-E remains the primary price source, with
   Elering's own API as automatic backup. FMI is primary for the weather forecast
   and nearby-station outdoor temperature; the existing OpenWeather token enables
   both backup services. These are independent fallback chains. SmartThings
   indoor/garage sensors and Easee are optional. Collection runs every five minutes
   for devices, ten minutes for outdoor temperature, and hourly for prices and
   forecasts. This input sends no equipment commands.
8. Configure `electricity` in add-on options. Every monetary field explicitly
   **excludes VAT**; `vat_percent` applies VAT once to spot, margin, tax and transfer.
   Defaults are margin **0.33 c/kWh ex VAT**, tax **2.325 c/kWh ex VAT**, and
   **25.5% VAT**. These produce 0.41415 and 2.917875 c/kWh including VAT.
   Transfer defaults are stored excluding VAT and yield day/night **3.34/1.96**,
   seasonal winter daytime/other **4.17/2.07 c/kWh including VAT**. Day/night stays
   selected. All four amounts and the tariff are configurable.
9. Set the occupied preferred drop with `controller.max_drop_c` (default **1°C**).
   It does not constrain away cooling. Permanent settings are reported in the UI;
   change them in options and restart. Old browser-saved values cannot override
   these settings. `temp_to_hours` is no longer used; remove it from saved add-on
   options if an upgrade still displays the old key.

The optional `electricity.effective_date` schedules rates at Finnish midnight.
Without a date, first-use rates start today; later rate changes start when loaded.
Previous rate periods retain their VAT and transfer values. Future periods can be
corrected before they start. Present-day defaults do not manufacture historical
rate coverage. Day/night applies 07:00–22:00 versus other times; seasonal winter
daytime applies November–March, Monday–Saturday 07:00–22:00.

The main chart defaults to today's complete Finnish calendar day. Choose a start
date to view one day; check **End date** to enable an inclusive date range. Date
changes apply automatically. **Yesterday – today**, **Today**, **Today – tomorrow**
shortcuts keep both observations and forecasts within the selected dates. The
**Left axis** selector chooses combined power, phase currents or heating integral;
temperatures and prices remain available on the right. Power is an estimate from
three phase currents at nominal 230 V, not metered active power or energy. All-in
price is initially visible; Spot price and DHWR are initially hidden and can be
enabled in the legend. Historical all-in prices need dated contract coverage.

Heat Off shading records reduction requests; DHWR records ten-minute pulse
requests. Aux Heat requires actual timestamped auxiliary-output observations, and
heating integral requires compatible readings. There is no reconstruction of old
auxiliary episodes from dated runtime counters. Until H66 supplies verified
observations, those series may be empty. Chart interaction reads stored data and
cached outlooks; it does not issue provider requests or equipment commands.
See [the chart controls and data limits](README.md#using-the-chart) for details.

A blank network-access token prevents startup with a clear configuration error.
Home Assistant options own permanent settings. The **Away until** and **Pause
until** controls use Finnish time even when the remote browser is in another
timezone. Apply changes saves them together; **Home now** and **Resume now** cancel
them independently. They persist in the database and expire at their deadlines,
including after a restart. Nonexistent or repeated clock-change times require
another picker time; the API also accepts an explicit UTC offset.

Away removes occupied drop penalties and compares predicted cost, including
recovery and auxiliary heating, with continuous native operation. It restores
occupied requirements when the return falls within the available forecast horizon.
Data/model confidence requirements still apply. Pause requests normal native
operation without price reductions. `active` applies only to simulated devices.
The house comfort reference is inferred; preferred drop defaults to 1 °C.
Unsupported warm-weather temperature plateaus are excluded from new reference
candidates. Cached provider readings keep their source timestamps through outages
and restarts. FMI forecast publication, model analysis and valid times are stored
separately. The OpenWeather forecast records fetch time separately because its
JSON response does not supply a documented issuance timestamp. Missing prices and
forecast intervals remain gaps; tomorrow's prices appear only when published.

The outdoor card labels **FMI nearby station** or **OpenWeather area estimate**;
neither establishes the temperature at the house itself. With valid configured
coordinates, this selected chain owns outdoor temperature and an optional
SmartThings outdoor sensor does not overwrite it. FMI requires a fresh station
reading within 50 km. **Data connections** names each selected provider and shows
**Using backup**, a concise primary error and the next scheduled primary retry.
Per-source retries are bounded, honor rate limits and persist through restarts.

Normal automated tests stay offline. The separate [live testing section](docs/live-testing.md)
checks the configured APIs and keys without starting the controller or connecting
to MQTT. From a repository checkout, run `npm run test:live`, or select services
with `npm run test:live -- --services fmi-forecast,fmi-observation`. See the
[progress log](docs/PROGRESS.md) for actual live results. Successful API checks do
not commission physical control or establish Raspberry Pi/Home Assistant runtime;
the x86 container checks cover a different deployment environment.

The Dockerfile uses an explicit Node 22.23.2 Alpine base, a finite frontend build
and `npm ci`. Legacy Supervisor `BUILD_FROM` injection cannot replace Node with an
incompatible base. It contains no architecture-specific native SQLite addon.
Node's own SQLite and Intl time-zone support are exercised in the container smoke
check. Development has not installed or started this add-on on the owner's HA.

Physical relay/H66 command ownership, controller compatibility, bounded writes,
readback and communication-loss behavior must be verified before a later live
migration. Retain the relay hardware until that migration is demonstrated. Existing
legacy scripts are preserved and gated; see [README](README.md).

## SSH database access and backups

The folder arrangement follows Home Assistant's [public add-on configuration
support](https://developers.home-assistant.io/docs/apps/configuration/#add-on-advanced-options).
Unlike `/share` alone, this folder is included in an add-on backup.

| Purpose | Inside ST-MQ | In Terminal & SSH |
| --- | --- | --- |
| Active household database | `/config/st-mq/st-mq.sqlite` | `/addon_configs/<repository-id>_st-mq/st-mq/st-mq.sqlite` |
| Simulation database | `/config/st-mq/simulation.sqlite` | Same public folder, `simulation.sqlite` |
| Options and provider tokens | `/data/options.json`, `/data/st-mq/` | Private to ST-MQ |
| CSV imports and exported backups | `/share/st-mq/` | `/share/st-mq/` |

Find the installation folder with `ls -d /addon_configs/*_st-mq` in a current
Terminal & SSH add-on. Locally installed add-ons use `local_st-mq`; a Git repository
uses its repository identifier. The old `/root/share` spelling was a terminal
convenience; `/share` is the shared mount. Add-on metadata keeps the `st-mq` slug so
upgrades keep the installation identity.

On upgrade, an existing selected database in `/data/st-mq/` is copied consistently
with SQLite's backup API to the new public folder. The old database is retained.
An already existing public database always wins; it is never replaced with the
old copy. A failed copy cannot become an empty authoritative database. The
migration occurs for each database when its input mode is first started.

Use Home Assistant's add-on backup for ordinary recovery. The manifest requests
**cold backup**, so Supervisor stops ST-MQ while capturing its database and starts
it again afterward. Include the Share folder separately if its imports/exports
also need backing up.

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
until the edited copy is verified. Restoring the complete HA add-on backup is the
usual route; the history CLI can restore a snapshot to a new database path.
Options are owned by Supervisor: edit them through add-on configuration, rather
than changing `/data/options.json` inside a running container.

`config.json`, `translations/en.yaml`, `repository.yaml`, `Dockerfile` and this
document are the maintained HA-specific files. `HASS_files/` is an old empty local
folder; no required installation helpers live there. The manifest keeps the
compatible `addon_config` mapping name, also called `app_config` by newer HA.

## Reproducing deployment checks

```sh
docker build -t st-mq:development .
scripts/test-addon-container.sh st-mq:development
```

The check uses temporary `/data`, `/config` and `/share` mounts, synthetic options,
the actual image startup command, authentication, database migration, restart and
backup/restore. A separate container verifies direct database access from the
public folder. Networking is disabled. CI builds and runs this for AMD64 and
ARM64 under QEMU; local x86 results alone do not prove installation on a physical
Raspberry Pi or the owner's Supervisor.
