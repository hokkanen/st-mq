# Home Assistant add-on setup

The 0.9.0 application starts with **simulated devices and shadow plans**. Default
startup launches no live controller or provider. Active MQTT control is available
when selected in configuration. See [learning and control](docs/learning-and-control.md)
for the algorithm, native-setting restoration and equipment testing limits.

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
6. Choose `controller.input: offline` to view imported history without device
   connections. Choose `providers` or `mqtt` for live temperatures and prices.
   Both support active legacy MQTT relay control. Set `controller.mode: active`
   to operate heating; `shadow` calculates plans and `monitoring` observes.
   Retain the existing MQTT connection fields. The controller uses the existing
   `from_stmq/heat/action` relay integration; it does not replace that automation.
7. Add `controller.h66_device` when H66 arrives. Both live inputs then subscribe
   to C60 telemetry and request snapshots; active mode additionally uses the four
   documented settings. Native baselines are read before each cycle. Optional
   `controller.h66_verification_file` overrides documented engineering-unit scaling.
   A missing gateway still permits conservative tariff reduction, without ROOM
   preheat or claimed compressor-only protection. The Data & learning panel shows
   the connection, current readings, native settings and model evidence.

   Existing coordinates and market country enable FMI, Open-Meteo and Elering
   without new keys. ENTSO-E is primary for prices and Elering is the backup.
   Temperature and global radiation forecasts use FMI first, then Open-Meteo
   ICON Seamless. Missing FMI radiation can use Open-Meteo while retaining FMI
   temperature. Radiation includes cloud effects and uses W/m². Current outdoor
   temperature uses H66 first, then FMI, then an Open-Meteo model estimate. Device
   collection runs every five minutes, outdoor temperature every ten minutes,
   prices/forecasts hourly and H66 snapshot requests every minute.
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
shortcuts keep both observations and forecasts within the selected dates. The **Left axis** drawer offers Power, phase currents, live heating integral,
solar radiation and all four historical learning metrics. Temperatures and prices
remain available on the right. Whole-house and EV power estimates use recorded
phase-energy increments divided by their actual intervals. Equivalent chart
currents assume 230 V and unity power factor; older current-only history uses
the nominal 230 V power estimate. H66 AUX power is a red fill derived from the
configured rated power (9 kW by default), with EV fill drawn above it. Compressor
space heating is yellow, hot-water heating blue, DHWR brown and heat-off requests
use a light crossed hatch. Every series is initially visible except DHWR; saved
legend choices persist. A separate strip shows observed native operating mode.

The chart's daily HP and EV price-timing comparisons hold the included daily
energy fixed and compare its cost with each day's duration-weighted average
all-in price. Heat pump appears on the left and charger on the right, with a
shared explanation below; narrow screens stack the results. Underlined labels
open explanations on hover, keyboard focus or tap. Escape or an outside tap
closes the explanation.

Each comparison identifies its energy basis. Heat-pump electricity is estimated
from recorded compressor activity and auxiliary output using dated nominal
compressor, circulation and auxiliary power assumptions. Charger electricity
uses recorded phase-energy intervals, with a 230 V phase-current estimate for
older current-only history. Simulation is identified separately. The
included-time mix is duration-weighted, not a percentage of samples, energy or
accuracy. Auxiliary consumption remains a nominal estimate even when its output
is observed. Historical calculations use saved equipment readings and assumptions;
missing inputs or dated power assumptions leave gaps, and current sensors or
model predictions never fill them. Source details report the contributing input
times; these are not a claim of continuous observations between those times.

Time included is the fraction of selected elapsed time used in the comparison,
including valid zero-power intervals. For today it ends at
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
operation without price reductions and restores owned native settings. `active`
operates real configured MQTT equipment for either live input.
The house comfort reference is inferred; preferred drop defaults to 1 °C.
Unsupported warm-weather temperature plateaus are excluded from new reference
candidates. Cached provider readings keep their source timestamps through outages
and restarts. FMI forecast publication, model analysis and valid times are stored
separately. The Open-Meteo forecast records fetch time separately because its
JSON response does not supply a documented issuance timestamp. Missing prices and
forecast intervals remain gaps; tomorrow's prices appear only when published.

The outdoor card labels **H66 outdoor sensor**, **FMI nearby station**, or
**Open-Meteo model estimate** in that priority order. H66 register `0007` supplies
the house sensor reading when fresh. The station and model fallback describe the
surrounding area. Missing or stale H66 readings fall back automatically; a fresh
H66 reading regains priority. With valid configured coordinates, this chain owns
outdoor temperature and an optional SmartThings outdoor sensor does not overwrite
it. FMI requires a fresh station reading within 50 km. Open-Meteo needs no key or
registration for noncommercial use within the free API limits; no weather token
setting is needed. **Connection & provider details** names each selected provider and shows
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

The controller owns tariff commands and temporary native changes. Broker delivery
is distinguished from native register readback and physical compressor activity.
The documented C60 mapping and mocked tests do not establish installed relay or
firmware behavior; use the timed device tests to check the installed integration.
Original ROOM, DHW start/stop and operating mode are restored after reduction.
Restoration needs the running application and connection; there is no documented
H66 device-side expiry. Compressor-only reduction can skip the native 14-day
high-temperature water cycle; this is an intended, accepted design risk.
See [learning and control](docs/learning-and-control.md) for the complete details.

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
