# ST-MQ

![ST-MQ icon](icon.png)

ST-MQ is a local home-energy controller under development for a Raspberry Pi 5
Home Assistant add-on and standalone Linux. The authoritative project brief is
`CODEX/ST-MQ-Codex-handoff.md`; implementation status and remaining work are in
[docs/PROGRESS.md](docs/PROGRESS.md).

The default icon and all three reusable SVG/PNG designs are in
[branding assets](assets/branding/README.md).

The controller provides SQLite history, adaptive thermal learning, complete
preheat/reduction/recovery planning, a monitoring dashboard and H66 readback/control.
**Default startup uses simulated devices in shadow mode.** With live input,
configured transport and active mode, the controller can operate heating and
supported H66 settings. Explicit manual MQTT and timed H66 tests are also available.
Read-only market, weather, MQTT temperature, TeslaMate and Easee providers plus dated contract
setup are integrated. ENTSO-E has a direct Elering backup; FMI supplies temperature
and solar forecasts, with Open-Meteo as backup. Current outdoor temperature uses
the H66 sensor first, then FMI station observations, then Open-Meteo estimates. Offline
regressions and a separate opt-in live suite verify the provider paths. See the
[progress log](docs/PROGRESS.md) for actual live-check results and remaining limits.
Physical equipment control has not been commissioned.

An optional [read-only LAN replica](docs/replication.md) keeps a second computer's
SQLite history synchronized over SSH. It serves charts through primary outages,
catches up after replica outages, and verifies each snapshot before publication.
The replica never acquires data or controls equipment. Replication is disabled by
default and requires configuring the two computers.

Optional [paired operation](docs/pairing.md) adds manual handover and force
promotion, a managed MQTT virtual IP, and protected recovery of missing history.
The dashboard shows each computer's role, synchronization and verification
status, and the explicit recovery controls. There is no automatic failover.

An independent recording optimizer targets a configurable **10 GB/year** rolling
growth rate with a **five-minute maximum interval when fresh measurements exist**.
Periodic indoor temperatures store changes and compact report coverage instead
of forced equal-value rows; missing reports leave chart and learning gaps.
Electricity history stores three estimated phase-energy increments for Easee and
property import, plus one total-energy increment for TeslaMate portable charging.
Meter readings and completed-session comparisons are diagnostic only. The house learner uses
committed windows and a versioned replay journal. See
[adaptive recording and migration](docs/recording.md), including local MQTT temperature sensors.
Home and Garage equipment uses explicit `shelly:<prefix>` or `mqtt:<state topic>`
connections, with public topic defaults and private broker credentials. See
[MQTT equipment and device setup](docs/mqtt-equipment.md) for garage probes, doors,
Caravan metering, connection checks and timed switch tests. Independent MQTT feeds
remain separate; ST-MQ never guesses a protocol or switches sources automatically.

See [indoor temperatures and sensor changes](docs/temperature-sensors.md) for the
Upstairs, Downstairs and Bedroom average, replacements and moves, and
comfort learning after adjustments to floor circulation thermostats. Record rare
sensor maintenance under **House model → Explore learning → Model inputs →
Average indoor → Sensor changes**, or **Outdoor temperature → Sensor changes**
for the outdoor sensor. Recording requires confirmation; **Reason** describes the
history and does not change the model's response. **Revert and relearn** undoes a
mistaken entry by rebuilding from recorded history while heating control remains
available. Reverted entries stay visible in the change history.

The [SmartThings temperature installation guide](docs/smartthings-temperature-rule.md)
explains why Fibaro smoke sensors need the modified driver for genuine repeated
reports, how to build/install it, configure forwarding and report deadlines, and
verify or roll back an installation. The complete small driver package, pinned
upstream source reference and exact reconstruction patch are kept in st-mq.

The comfort reference is inferred from sustained occupied normal-temperature
plateaus under the house's existing controls. The preferred maximum drop defaults
to **1 °C**. References stay fixed during cooling, recovery and preheating. A
missing reference keeps the requested heating mode normal. Initial model estimates
retain uncertainty and limit the duration and cost of learning trials.
A provisional historical reference is not automatically applied to the live house.
Warm-weather plateaus without credible heating evidence are excluded from new
reference candidates, so passive summer warmth does not establish a heating target.

## Run locally

Use Node.js **22.19 or newer** (Node 22 LTS is the container baseline). SQLite is
built into Node; Node 22 emits its experimental-feature warning. No GPU or paid
model service is used.

```sh
npm ci
npm test
npm run build
npm start
```

Open **http://127.0.0.1:1234**. The UI labels simulated readings and example prices.
If the port is already in use, follow [startup troubleshooting](docs/startup.md)
to identify the running instance and restart it cleanly.
`node scheduler.js` also starts the safe application unless the separate legacy
live gate is explicitly enabled. The public `config.json.options` defaults are
overridden by the permanent private `~/.config/st-mq/secrets.json` file (or
`$XDG_CONFIG_HOME/st-mq/secrets.json`). Without an explicit input selection the application uses simulation.
Simulation and offline modes do not connect to providers. The server serves the completed UI build; it does not
rebuild historical CSVs or run a permanent Vite build watcher.

The Home Energy UI has monitoring, shadow and active modes, combined
history and price/weather outlooks, requested/actual state, stale-data indication, learning
health, explicit occupancy and timed normal-heating overrides. The default 21 °C
**demo** target is confined to simulation, not inferred as the real house's target.
Away/Pause deadlines persist. Monitoring and shadow do not automatically apply
the heating schedule; explicit manual changes still carry restoration obligations.
**Away until** removes the occupied temperature-drop requirement until the chosen
return time. The planner compares cost with continuous native operation, including
recovery and auxiliary energy. Occupied requirements resume at the return time
within the available forecast horizon; forecasts are never invented beyond it.
The existing evidence/freshness gates still apply. **Pause until** first changes the
automatic schedule to normal heating. Heating modes and native parameters
selected afterwards are held until the pause ends or
**Resume now** is selected. Their previous settings are then restored and automatic
scheduling resumes if enabled. Applying a new pause deadline starts again from
normal heating. Outside Pause, all these manual changes revert on the next
controller update, normally within one minute, with a one-minute expiry as a
fallback. Repeated edits retain the original restoration values. Pause deadlines
survive restarts; manually held equipment settings retain the existing restart
and connection-loss restoration rules. Both temporary controls use Finnish time
and can be cancelled independently.
Live active mode applies the plan; monitoring and shadow show it without automatic
equipment commands.

Under **Home & heating → Home heating**, **Heating configuration** contains
the manual heating buttons. Home and Garage share the same expanded layout:
heating controls, equipment and temperatures, then Away/Pause. Each heat pump has
an overview followed by its detailed readings; the ground-source heat pump also
contains **Adjust heat-pump parameters**. **Garage settings** ends Garage's heating
configuration, and connection links end each equipment section. Selection marks sit beside the
button labels. The equipment inventory includes individual room and protection
sensors, native heat-pump temperatures, tariff relays and legacy Shelly devices.
Held changes during Pause show an amber notice even when the sections are closed;
changing a paused heating setting opens a confirmation explaining its lifetime.
With live `providers` or `mqtt` input and configured controls, Normal and Reduced
send tariff requests through the controller's executor. **Max preheating** requests
normal tariff operation and circulation, and raises the selected ROOM setting
by the configured maximum boost, capped at the writable ROOM upper limit, with
H66 readback. It needs no separate temperature input. Repeated clicks do not add
further boosts. Leaving Max preheating removes that boost while retaining other
manual parameter choices.
Circulation uses MQTT switch ON/OFF and its own configured run duration whether
paused or not. Clicking Start again starts a full new run; Stop ends it immediately.
Ending Pause or restoring manual heating parameters does not shorten the run.
A successful MQTT request confirms broker acknowledgement,
not equipment response. Manual actions are logged, do not change Away/Pause or
enable automatic control, and are unavailable in simulation/offline mode.
Failed delivery may be unconfirmed; restoration remains owed until reconciled.
Enabled buttons mean MQTT is configured; the connection is checked when a test
is sent. Connection failures distinguish an unreachable broker, refused connection,
DNS, login or TLS problems and report that no command was sent. If a connection
fails after publishing begins, check device state before retrying because delivery
is unconfirmed.

**Test H66 controls** offers timed ROOM (`0203`), DHW start (`0212`), DHW stop
(`0208`) and operating-mode (`2201`) tests when the connection and fresh writable
readbacks are ready. The current baseline is saved and restored after expiry.
The UI distinguishes a sent request from device readback and a pending restore.
These are real manual commands with live input, including in shadow mode.

For UI development run `npm start` and `npm run dev` in separate terminals. Vite
proxies `/api` to the backend. `npm run preview` alone does not provide the API.

## Using the chart

The interface remembers the browser's last selected theme, with green dark as
the initial default. The header's **Light theme / Dark theme** button changes
and saves that choice. The chart is directly below the current readings.

- **Dates:** the default is today, midnight to midnight in **Europe/Helsinki**.
  Choose **Start date** to view a single day immediately; the greyed-out end date
  follows it.
  Check **End date** to select a range of inclusive Finnish calendar days, including
  daylight-saving changes, then click **Show dates** to apply the selection.
  **Yesterday – today**, **Today** and **Today – tomorrow** provide quick navigation
  and set the end-date checkbox accordingly. The small arrows outside these
  shortcuts shift the shown window one calendar day back or forward without
  changing its length. To see tomorrow alone, leave End date unchecked and choose
  tomorrow as Start date.
  Forecasts and known electricity prices appear only
  inside the selected dates; they never extend the horizontal axis automatically.
- **Left axis:** **Power** shows combined property power as a line, estimated
  auxiliary power as a red fill and charger power as a fill over it. Fills overlap
  from zero; they are not stacked. **Phase currents** shows the three property phase lines
  in amperes with corresponding charger fills. **Phase energy per interval** shows
  the three saved kWh increments per device. The drawer groups all retained H66
  parameters, control, weather and learning series.
  **All home temperatures** is the sole **Home temperatures** drawer option;
  it shows Upstairs, Bedroom and Downstairs on the left with the two air-temperature
  scales synchronized. Garage remains available on the right axis. **Heating integral** selects the integral instead. Four **Learning** choices show profit after recovery, profit
  with observed auxiliary recovery, recovery cost prediction error and learned
  normal indoor temperature. **Solar radiation** shows archived and future FMI
  forecasts in W/m², not a solar sensor. Only that group's legend items appear.
  New property/charger power comes from phase-energy increments divided by their
  actual intervals. Equivalent chart currents assume 230 V and unity power factor;
  they are not the acquired current snapshots. Older current-only history retains
  its `230 × (L1 + L2 + L3) / 1000` estimate. Neither path measures heat-pump consumption.
- **Right axis:** **Average indoor**, Garage, outdoor temperature and electricity prices
  stay available with every left-axis selection, retaining their existing colours.
  Average indoor is the same configured sensor average used by the house model,
  with equal contributions from Upstairs, Bedroom and Downstairs when all three
  are configured with default weights. Saved inputs retain their original sensor
  membership; imported learning keeps its original Upstairs measurement.
  Select **All home temperatures** to compare the rooms. Outdoor stays blue,
  Average indoor green, Upstairs terracotta, Downstairs amber and Bedroom violet.
  The dashed outdoor continuation is forecast. All-in and **Spot price** start visible; spot excludes VAT and other
  charges. Explicit saved legend choices are preserved. All-in prices combine
  historical spot prices with the contract rates for that date, or the nearest
  known rates when the date is uncovered. An **Assumed rates** explanation identifies these assumptions;
  missing spot prices stay unavailable.
- **Shading:** crosshatched **Heat Off** represents requested reduction; yellow
  **Compressor · house** and blue **Compressor · hot water** require concurrent
  compressor/routing readbacks. Brown **DHWR** marks requested circulation runs with their recorded duration
  and starts hidden. A separate **Pump mode** strip shows categorical H66 readback.
  Unknown or stale operation leaves gaps. Dated runtime counters cannot identify
  individual auxiliary episodes.
- **Energy cost comparisons:** open this fold below the chart. Heating and Charging compare each device's cost of
  included energy at the recorded timestamps with the same daily energy at the
  whole Finnish day's average all-in price. Heat-pump electricity is reconstructed
  from recorded compressor activity and auxiliary output using the nominal powers
  saved for that time. Charger electricity uses recorded phase-energy intervals;
  older current-only history retains its 230 V estimate. The visible basis and
  source details identify those estimates and simulation. Missing equipment data
  or dated heat-pump power assumptions leave gaps. Heat-pump power is never
  property consumption minus charger consumption.
  Both **Heating** and **Charging** show **Time included** as a percentage of
  the selected elapsed time. Heating includes valid zero-power intervals;
  charging leaves out idle periods at or below 100 W. For example, one included
  hour in a 24-hour selection is 4%, regardless of device. A low charging
  percentage can therefore mean idle time, missing history, or incomplete prices.
  The full-day average price still includes every hour. Missing readings remain
  unknown, separate from idle time. With no detected charging, no comparison is shown.
  The source mix is weighted by included time, not sample count, energy or
  accuracy. Missing history and charging periods with incomplete daily prices
  are excluded, without extrapolation. Future hours do not reduce coverage.
  Calculations use the underlying energy and equipment intervals independently
  of chart point reduction and the selected left axis.
  The fold starts closed, like **Recording details**, and stays as you set it
  when the chart refreshes or dates change. The **Heating** and **Charging** boxes
  align when closed; each details fold expands independently. They show source
  shares, timestamps and short notes about missing data. Shared explanations come last, in a
  centered column. Missing historical contract rates
  use the nearest known rates with historical spot prices;
  **Assumed rates** includes assumptions affecting the daily average even when
  the device ran during a period with known rates. This comparison does not
  establish savings caused by the controller.
  A third **Firewood** box estimates space-heating electricity and cost avoided
  with wood priced at zero. It shows a scenario range, evidence status and coverage
  for the selected dates, with any remaining forecast estimate separately. It uses
  a different reference from the timing comparisons, so the cards are not summed.
  Manual wood loads, delayed release, the fitted response and daily savings are
  also available in the left-axis drawer. See [fireplace details](docs/fireplace.md).

Chart changes affect the display only. Viewing history neither polls providers
nor sends equipment commands. Large ranges use bounded display resolution,
preserving extremes and missing-data breaks; dense shading represents recorded
activity within each display interval. Queries run in a background worker and
recent selections are cached. A newer selection cancels an obsolete request.
For date ranges containing now, temperature, power, phase-current and integral
lines extend their last recorded value to the current time on each status refresh,
even when the history response is cached. Hover text identifies the original
recording time. These display extensions do not add measurements to history or
make old readings fresh for control. Missing/invalid values retain their gaps;
prices, forecasts and equipment-state shading keep their recorded time bounds.
Auxiliary output has a five-minute freshness bound. Learning histories keep the
estimate assessed at the time and never rewrite old points using a later model.

Below the chart, **Home & heating** shows the heating decision, price control,
comfort reference, occupied drop limit and recirculation request, together with
the heat-pump mode and DHW target range. **Away & pause** contains temporary
controls inside **Home heating**, alongside H66 readings, parameters and manual
heating controls. **Garage heating** opens garage readings and controls.
Tariff requests remain explicitly unverified when relay readback
is unavailable; stale H66 readings are not presented as current settings.

**House model** gives a short learning status and the reported counts of usable
observations and accepted model updates. Missing counts remain unknown.
**Explore learning** opens separate sections for the **four calculated outcomes**,
**model inputs** and **current model coefficients**. Coefficients show values,
units and fitted/fixed provenance from the existing learning state, without
additional storage or reconstructed historical coefficient traces. See the detailed
[learning and control explanation](docs/learning-and-control.md).

**Data & settings** shows a compact provider-health overview. **Connections &
settings** opens each provider's data series and details, **Electricity rates**
and **Configuration**. **Electricity consumption · Easee, Teslamate** groups
property import, Charger 1 and Charger 2 in both the source overview and the
connection details. Easee and TeslaMate keep separate acquisition diagnostics;
Charger 2 lists total power, estimated interval energy and its session check.
On wide screens, the home card sits beside the stacked
model and data cards, with both columns aligned when closed. The three cards stack
on narrow screens; the event log follows them.
**Recording details** lists achieved recording intervals, learned thresholds,
freshness and storage growth independently of model importance. **Meter accuracy
checks** shows the latest property-meter comparison and Charger 1 / Charger 2 session
averages without correcting history or training/calibrating the house model.

## Persistence and historical data

Standalone databases are in `var/`; Home Assistant uses `/config/st-mq/` in the
public add-on folder, accessible through SSH under
`/addon_configs/<repository-id>_st-mq/st-mq/`. Simulation
uses `simulation.sqlite`; real/offline household history uses `st-mq.sqlite`.
Override the database directory with `STMQ_DATABASE_DIR`. Private provider token
caches remain in `STMQ_DATA_DIR` (`/data/st-mq` in HA). Existing HA databases migrate
through SQLite's backup API to the public folder; the original is retained and an
existing destination is never overwritten. `/share/st-mq` remains the exchange
folder for historical CSVs and exported backups. See [SSH access and backups](DOCS.md#ssh-database-access-and-backups).
These databases and supplied CSVs are excluded from Git and Docker contexts.
Keep private configuration outside the repository. Standalone uses the permanent
`secrets.json` described below; Home Assistant owns its saved add-on options.
Historical encrypted configuration is covered by the archival audit in
[secret handling](docs/secret-handling.md); it is not the current configuration workflow.

```sh
npm run history -- import
npm run history -- summary
npm run history -- tail --follow
npm run history -- export --output /tmp/indoor.csv --signal indoor_temperature
npm run history -- backup --output /tmp/st-mq-backup.sqlite
npm run history -- restore --input /tmp/st-mq-backup.sqlite --db /tmp/restored.sqlite
STMQ_INPUT=offline npm start
```

Import defaults to the two supplied `CODEX` CSVs, with streaming batches,
SHA-256 provenance, interruption recovery and idempotence across file paths.
Importing the same file twice adds no observations. Differently edited source
files retain separate provenance; they are not silently merged into canonical
historical readings. Historical prices stay ex VAT. Missing readings stay null,
zero-current anomalies stay flagged, and commands never become compressor labels.
March–May 2026 is an approximate absence/heating-off annotation excluded from
occupied-model training. All 84 dated handoff counters are preserved; DHW runtime
is not added to compressor runtime.

Backups use SQLite's online backup API. Restore to a new path while the target
application is stopped; validate it before changing the configured path. Keep
backups on separate storage. Schema upgrades run transactionally; newer unknown
schemas are rejected. Raw observation queries are bounded to at most 5,000
observations; `/api/history` limits a request to 31 days. The separate `/api/chart`
endpoint accepts inclusive `start`/`end` calendar dates and left-axis keys from
the shared catalogue, including `power`, `phases`, `phase_energy`, `integral`,
`solar_radiation`, individual H66 signals and the four `learning_*` signals,
and a `points` resolution of 100–2,000 time buckets per series. It accepts at most
3,660 calendar days and summarizes the full selected history into bounded drawing
data. Source history is retained; there
is no automatic deletion policy in this stage. Monitor disk growth and archive
through tested backups/export.

```sh
npm run history -- counter --signal auxiliary_6kw_runtime --value 447 --date 2026-09-06
npm run history -- annotate --kind absence --from 2026-03-01T00:00:00+02:00 --to 2026-06-01T00:00:00+03:00 --note 'Approximate heating-off absence'
node scripts/benchmark-history.js var/st-mq.sqlite
```

## Connections and access

| Variable | Default / purpose |
| --- | --- |
| `STMQ_INPUT` | `simulated`; also `offline`, `mqtt`, or `providers` |
| `STMQ_MODE` | `shadow`; also `monitoring`, or `active` with supported live transport or simulation |
| `STMQ_DATA_DIR` | `./var`, or `/data/st-mq` in the add-on |
| `STMQ_DATABASE_DIR` | Same as data directory on Linux; `/config/st-mq` in HA |
| `STMQ_PORT` | `1234` |
| `STMQ_HOST` | `127.0.0.1` on standalone; optional add-on direct access listens on `0.0.0.0` |
| `STMQ_API_TOKEN` | Overrides `controller.web_token`; at least 24 characters for direct network access |
| `STMQ_CONFIG` | Standalone private override JSON; defaults to `$XDG_CONFIG_HOME/st-mq/secrets.json`, or `~/.config/st-mq/secrets.json`. In the add-on, overrides only the initial/fallback Supervisor export path. |
| `STMQ_MAX_DROP_C` | Occupied preferred drop; overrides `controller.max_drop_c` (default 1°C) |
| `STMQ_H66_DEVICE` | Exact H66 topic prefix; enables H66 alongside a configured MQTT broker |
| `STMQ_H66_VERIFICATION` | Optional JSON path with verified register scaling/evidence |

Home Assistant ingress uses the existing Home Assistant login. Optional direct
add-on access on port 1234 is enabled only with a valid `controller.web_token`;
clearing that token and applying configuration disables direct access while
ingress remains available. Standalone loopback access permits an empty token;
listening beyond loopback requires a token of at least 24 characters. Use a
trusted local network or an authenticated HTTPS reverse proxy for remote direct
access. Credentials are never returned in API responses. A direct-access browser
keeps its entered token in session storage for its tab. The **Configuration**
section shows the current access state.

MQTT reuses the existing broker address/user/password and subscribes to
`<device>/HP/#` and configured indoor/garage temperature topics alongside online providers. Supported active control and
explicit manual tests can publish SET requests. Plain H66 values lack a source
measurement timestamp: non-retained receipt time is labeled as the communication
freshness basis, with the source timestamp still unknown. Retained, duplicate and
invalid messages are handled explicitly. A documented C60 profile does not prove
installed-device semantics. See [learning and H66 control](docs/learning-and-control.md).

Start read-only collection with:

```sh
STMQ_INPUT=providers npm start
```

This reuses `geoloc`, `entsoe`, `mqtt` and `easee` connection fields from
the existing options JSON. FMI, Open-Meteo and Elering need no API key or additional
provider configuration. Weather uses the configured latitude/longitude;
Elering uses the market country (FI, EE, LV or LT), or a matching explicit ENTSO-E
bidding zone. Indoor and garage temperatures arrive on configured local MQTT topics
in both `providers` and `mqtt` input modes. Smoke channel 1 is Upstairs, channel 2
is Bedroom and channel 3 is Downstairs. These three MQTT sensors are the indoor
inputs; there is no H66 indoor sensor or fallback. Garage rear/front protection
and learned scheduling are independent of Home; see [Garage heating](docs/garage.md).
The Pill integration remains provisional and read-only until its actual contract
and commissioning are available. Provider input in shadow mode observes
and plans; active mode can use a configured command transport.

| Data | Primary → backup | Normal collection interval |
| --- | --- | --- |
| Electricity prices | ENTSO-E → Elering's own public API | 1 hour; 15-minute retry when next-day horizon is missing |
| Temperature and solar forecast | FMI HARMONIE → Open-Meteo ICON Seamless | 30 minutes |
| Outdoor temperature | H66 outdoor sensor → FMI nearby station → Open-Meteo model estimate | H66 messages; weather every 5 minutes |
| Indoor temperatures | Configured local MQTT room sensors | 70-minute maximum reporting interval plus five minutes of grace |
| Garage temperatures | One configured Shelly or MQTT connection | Shelly polled every 30 seconds; either connection expires after two minutes |
| Property/charger electrical observations | Easee REST | 15 seconds, one batched request per device |
| Portable-charger total energy | TeslaMate MQTT | Changed fields and live health; integration checked every 5 seconds |

These are collection schedules, not guarantees that each provider publishes a new
measurement that often. FMI and Open-Meteo forecasts use hourly valid times.
Market prices retain each actual hourly or
quarter-hour delivery interval. The recorder saves changed observations adaptively
and deduplicates unchanged forecast/market payloads while preserving acquisition
references. Source timestamps remain separate from receipt time. Successful device downloads count even when values have not changed
or source timestamps are old. Reading-quality warnings remain visible without
slowing the configured collection cadence; failed or malformed downloads still
back off. Restarts preserve the last result and retry details.

Market fallback starts on a failed request, missing current price, or incomplete
current-day coverage. Tomorrow being unpublished is normal; it shortens the next
scheduled check to the configured retry interval without forcing a backup request.
Elering is contacted directly, with validated currency,
VAT and terminal-interval semantics; no intermediary service is used. Neither
source fills missing prices or extends them past the published horizon. See
[the Elering verification evidence](test/fixtures/market-elering-evidence.md).

Temperature and solar forecasts use FMI first and Open-Meteo ICON Seamless as
backup. Missing FMI solar intervals can use Open-Meteo radiation while keeping
available FMI temperatures; each solar value retains its provider provenance.
Solar radiation is global shortwave radiation on a horizontal surface in W/m²,
including cloud effects. Open-Meteo's hourly radiation averages the preceding hour
and is aligned to that interval rather than shifted into the next hour.

Current outdoor temperature uses a fresh **H66 outdoor sensor** reading (register
`0007`) first, then a fresh **FMI nearby station** reading, then an **Open-Meteo
model estimate**. Source priority takes precedence over a slightly newer backup
timestamp. Missing or stale H66 readings fall back automatically and fresh H66
readings regain priority. FMI selects the nearest fresh station among up to three
returned candidates within 50 km. The station and model estimate describe the
surrounding area. Weather forecasts and current-temperature acquisition are
independent; an unavailable station therefore does not discard a good FMI forecast.

[Open-Meteo](https://open-meteo.com/en/docs/dwd-api) supplies DWD ICON forecasts
without registration or a key for noncommercial use within the free API limits.
The application requests ICON Seamless explicitly to use a forecast system
independent of FMI. Current Open-Meteo weather is modeled, not a sensor observation.

**Data connections** shows the selected provider, **Using backup** when applicable,
and the primary provider's next retry. Requests are bounded and failures back off
per source, respecting rate-limit delays through restarts. One failed primary
cannot cause rapid repeated calls while a backup works. Outages retain cached data
with its original age; restart or refresh does not make old data fresh. FMI model
publication, analysis and forecast-valid times are separate. Open-Meteo does not
supply a documented forecast issuance timestamp, so that field remains unknown;
its generation duration is not treated as an issuance time.
Still-fresh near-term forecast blocks retain their original snapshot provenance.

Easee readings retain original source ages. Reported active power is integrated
between polls and allocated to three estimated phase energies; raw currents and
voltages remain acquisition-only. The property cumulative-import counter and the
finalized Charger 1 / Charger 2 session references support diagnostics without
correcting or calibrating those estimates. Charger lifetime counters are not retained.
Charger voltage terminal mapping requires explicit verification before voltage
weights are used. Easee authentication can refresh tokens; it does not change
charging settings. See [recording configuration and limitations](docs/recording.md).

Optional [TeslaMate capture](docs/recording.md#teslamate-portable-charger-capture)
uses the existing MQTT broker and the exact `Home` geofence. It records total kWh
from charging power, with no phase-current series or PostgreSQL connection.
Fresh property-power checks suppress impossible overlaps; physical connector
identity remains ambiguous in some cases, with an explicit Easee assignment
available to guarantee that charger 2 is not counted for a known Easee session.

Normal `npm test` and `npm run check` stay offline. To verify current service access
and the configured keys explicitly, use the [bounded live test suite](docs/live-testing.md):

```sh
npm run test:live
npm run test:live -- --services fmi-forecast,fmi-observation
```

Each primary and backup is checked separately, so a working fallback cannot hide
a rejected key. The suite uses no MQTT and sends no equipment commands.

## Permanent configuration and prices

`config.json` is public: its `options` object is the common application defaults,
and its metadata and `schema` describe the Home Assistant add-on. Put permanent
private overrides in a **plain JSON options object**, without the manifest's
outer `options` wrapper. A small file is expected; it need not repeat defaults.

On Ubuntu, edit `~/.config/st-mq/secrets.json` (or
`$XDG_CONFIG_HOME/st-mq/secrets.json`). `STMQ_CONFIG` selects another private file,
for example `/etc/st-mq/secrets.json` for a service account. Keep the directory
owner-only (`chmod 700`) and the file owner-readable/writable (`chmod 600`), and
ensure the account running ST-MQ can read it. This file is permanent: every start
and **Apply configuration** merges it over `config.json.options`, and never
deletes it. Environment overrides take precedence. The UI displays the actual
paths used by the running instance.

In Home Assistant, edit and **save** add-on options, then choose **Apply
configuration** in ST-MQ. The button fetches the freshly saved Supervisor options;
it does not depend on the startup export in `/data/options.json`. For an import,
upload a sparse `secrets.json` using SSH to the exact add-on configuration path
shown in ST-MQ, normally `/addon_configs/<actual-add-on-slug>/secrets.json`.
ST-MQ sees this as `/config/secrets.json`. Apply reads the fresh saved options,
merges the uploaded values, saves the result in Home Assistant, and applies the
supported settings. The uploaded file is removed only after successful import
and application. A failed import keeps it for correction; if cleanup alone fails,
the UI reports that the applied file needs manual removal. Home Assistant keeps
the imported values after the upload is removed. See [Home Assistant setup](DOCS.md).

Supervisor remains authoritative in the add-on, including when `STMQ_CONFIG`
selects an alternative startup export for tooling. Existing Home Assistant
`!secret` references are resolved for runtime use; saving an import follows
Supervisor's normal behavior of storing the resolved values. Uploaded JSON must
contain actual values. Home Assistant rejects explicit `null`, including for
optional fields; use an empty string for optional text, or remove the field in
Home Assistant's settings. Ubuntu supports `null` for optional fields.

Objects merge recursively. Missing keys retain the lower layer's value, arrays
replace the lower layer's whole array, and explicit empty values clear fields
where that field permits an empty value. For example, omitting a saved MQTT
password preserves it during an HA import; providing `"pw": ""` clears it. To
disable direct add-on access, set `"controller": { "web_token": "" }` and apply.
On Ubuntu, removing a key from the permanent file restores the public default
on the next application. Invalid values reject the change; no private values are
included in validation errors or status responses.

The button is at **Data & settings → Connections & settings → Configuration →
Apply configuration**. **Applies without restart** covers price-control mode,
comfort limits, learning settings, electricity rates, recording interval, storage
budget, and the direct-access token. With live input it also covers provider
connections, location, sensor topics, polling intervals, H66 device selection and
its verification file. Token changes take effect immediately; direct-access tabs
may need to enter the new token. Home Assistant ingress keeps using HA login.
**Requires restart** covers input mode, web address/port, data and database
locations, and environment variables. Changing one of these rejects the whole
application of settings; restart to use such changes. Finish ongoing equipment
tests and setting changes first. Owned equipment settings are restored before
reconnecting; pending restoration blocks the update until equipment is available.
An in-progress automatic heating cycle ends, while Away/Pause deadlines and
learning history remain. Startup environment overrides still apply.

The dashboard reports the active values; Away/Pause and explicit timed tests are
temporary controls. Configuration takes precedence over old browser-saved
mode/drop settings. `temp_to_hours` is obsolete and has been removed.

`recording.max_interval_minutes` defaults to `5` and
`recording.annual_budget_gb` to `10`. Acquisition intervals have separate options;
the complete example and local MQTT sensor payloads are in
[docs/recording.md](docs/recording.md). A storage target is not a calendar quota or
an automatic deletion policy.

All monetary options under `electricity` are **c/kWh excluding VAT**. VAT is entered
as a percentage and applied once to spot, margin, tax and transfer. Default values:

| Option | Excluding VAT | Including 25.5% VAT |
| --- | ---: | ---: |
| `margin_ct_per_kwh_ex_vat` | 0.33 | 0.41415 |
| `tax_ct_per_kwh_ex_vat` | 2.325 | 2.917875 |
| `day_transfer_ct_per_kwh_ex_vat` | 2.66 | 3.3383 |
| `night_transfer_ct_per_kwh_ex_vat` | 1.56 | 1.9578 |
| `winter_day_transfer_ct_per_kwh_ex_vat` | 3.32 | 4.1666 |
| `other_transfer_ct_per_kwh_ex_vat` | 1.65 | 2.07075 |

The numeric VAT-exclusive defaults are in `config.json`. `vat_percent` defaults to `25.5`; `transfer_tariff` defaults to
`day-night`. Daytime is 07:00–22:00 Finnish time. Seasonal winter daytime is
November–March, Monday–Saturday 07:00–22:00; Sundays and all other times use the
lower seasonal rate. Seasonal is available but is not activated automatically.

`controller.max_drop_c` defaults to 1°C for occupied operation; it does not constrain
away cooling. The comfort reference remains learned from native occupied operation.
`controller.input` and `controller.mode` are also configuration-owned.

The optional `electricity.effective_date` is a Finnish calendar date. First-use
rates begin today if no date is supplied; subsequent changes begin when loaded.
Rates, transfer amounts and VAT are saved per period so future changes preserve
historical calculations. Unstarted scheduled changes can be revised in options.
For chart history and timing comparisons, missing historical contract periods
use the nearest known rates while preserving historical spot prices. If only
today's rates are known, those rates apply to earlier readings. The historical
local time determines the day/night or seasonal transfer rate. These price
assumptions are labelled in the interface; known dated rates remain unchanged.
Simulation prices remain labelled synthetic and independent of the household
contract.

## Learning and control limits

The adaptive model fits bounded chronological temperature samples and checks
later trajectories against the previous model and temperature persistence.
Historical work runs separately from the control loop. Initial estimates support
bounded learning trials, with explicit energy uncertainty and cost budgets.
Cycle assessments include full recovery and remaining reserve; incomplete cycles
do not enter profit or prediction-error averages. Estimated electricity and the
planned shorter-reduction comparison reference do not establish actual bill savings.

Live H66 control captures and restores existing ROOM/DHW/mode baselines, checks
readback and retains restoration obligations through restarts. A1/A2 and native
hysteresis are configured prediction inputs, not values read from integral
register `8105`. The configured defaults are A2 −990 and auxiliary hysteresis
30 °C. Public configuration also supplies A1 −100 and compressor hysteresis
10 °C; these configured thresholds do not establish observed native readings. The DHW stop
register `0208` is not a physical compressor temperature cap.

DHWR uses explicit MQTT ON/OFF switch commands. ST-MQ owns the run timer, configured
with `controller.dhwr_duration_minutes` (default 10; 1–60 minutes), and saves pending
OFF commands for restart recovery. The default equipment entry listens for measured
watts on `stmq/home/dhwr/status/power`, forwarded by a SmartThings Rule. It shows the last
reported watts and timestamp without inferring relay state or recording power
history; chart shading continues to show requested circulation. See
[DHWR setup and Rule template](docs/dhwr-mqtt.md) and the
[custom MQTT topic migration](docs/mqtt-topics.md).
The native periodic hygiene cycle remains unchanged, with an explicitly accepted
possibility of delayed auxiliary availability during temporary control. No claim
of a verified hygiene outcome or commissioned hardware follows from the tests.
Read [the full assumptions and limits](docs/learning-and-control.md) before interpreting
cycle metrics. No battery dispatch is implemented.

## Deployment paths

See [Home Assistant setup](DOCS.md). A local container build needs no `BUILD_FROM`
argument:

```sh
docker build -t st-mq:development .
```

The same Node core and SQLite schema run in both targets. The container supports
`amd64` and `aarch64`; this development host validates x86 execution only. CI
builds and runs the isolated mounted add-on smoke check for both architectures.
Run `scripts/test-addon-container.sh st-mq:development` to check a local image.
[deploy/st-mq.service](deploy/st-mq.service)
is an example standalone systemd unit to adapt to an installation; it has not been
installed or enabled by development. Stop the old command owner before any future
live migration. [Legacy documentation](docs/LEGACY.md) is retained for reference.

Firewood loads and mistaken-entry corrections are described in
[Fireplace logging](docs/fireplace.md). The [model reconstruction and versioning
contract](docs/reconstruction-and-versioning.md) defines the retained replay scope.
