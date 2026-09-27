# ST-MQ

![ST-MQ icon](icon.png)

ST-MQ is a local home-energy controller under development for a Raspberry Pi 5
Home Assistant add-on and standalone Linux. Current behavior is described below
and in the linked feature guides. Audit implementation decisions are recorded in
[the audit ledger](docs/audit/README.md).

The default icon and all three reusable SVG/PNG designs are in
[branding assets](assets/branding/README.md).

The controller provides SQLite history, adaptive thermal learning, complete
preheat/reduction/recovery planning, a monitoring dashboard and H66 readback/control.
**Default startup uses simulated devices in shadow mode.** With live input,
configured transport and active mode, the controller can operate heating and
supported H66 settings. Explicit manual MQTT and timed H66 tests are also available.
Market, weather, MQTT temperature, TeslaMate and Easee acquisition plus dated contract
setup are integrated. Charger 1 accepts any car, using manual battery values until
BMW or Tesla is identified, and can use opt-in cloud Easee schedules or native
OCPP pauses that expire on the charger. Charger 2
is a physical Shelly EVSE with commissioning-gated MQTT control. Tesla and BMW are read-only vehicle feeds for either charger. Heating mode and charging permission are
independent. See [charging controls and estimates](docs/charging.md).
ENTSO-E has a direct Elering backup; FMI supplies temperature
and solar forecasts, with Open-Meteo as backup. Current outdoor temperature uses
FMI station observations, with Open-Meteo estimates as backup. Offline
regressions and a separate opt-in live suite verify the provider paths. See the
[progress log](docs/PROGRESS.md) for actual live-check results and remaining limits.
Commissioning evidence is recorded per integration; see the
[bounded native OCPP checks](docs/audit/OCPP-SETUP.md).

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
growth rate for continuous measurements and accumulated energy. There is no
maximum recording interval: unchanged values extend coverage instead of creating
repeated rows. Room temperatures, settings and equipment states retain every
change; missing reports leave chart and learning gaps. Electricity history stores
three estimated phase-energy increments for property and both physical chargers.
Charger 2 also retains its native measured total; vehicle feeds never supply home
electricity. The database UI separates adaptive measurements from exact history,
full-report feedback, events, learning journals, imports and current state.
Separate property meter checks and completed-session comparisons are diagnostic only. The house learner uses
committed windows and a versioned replay journal. See
[adaptive recording and CSV imports](docs/recording.md), including local MQTT temperature sensors.
Home and Garage equipment uses explicit `shelly:<prefix>` or `mqtt:<state topic>`
connections, with public topic defaults and private broker credentials. See
[MQTT equipment and device setup](docs/mqtt-equipment.md) for garage probes, doors,
Caravan metering, air monitoring, connection checks and timed switch tests.
The [Caravan dehumidifier](docs/caravan-dehumidifier.md) has MQTT controls ready
for its future bridge and records one combined power/fan state. Independent MQTT feeds
remain separate; ST-MQ never guesses a protocol or switches sources automatically.

See [indoor temperatures and sensor changes](docs/temperature-sensors.md) for the
Upstairs, Downstairs and Bedroom average, replacements and moves, and
comfort learning after adjustments to floor circulation thermostats. Record rare
sensor maintenance under **Home → Heating configuration → Home learning → Model inputs →
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

The overall and individual room comfort references are inferred from sustained
occupied normal-temperature plateaus under the house's existing controls.
The shared maximum drop and rise both default to **1.5 °C** around each room's
reference, falling back to the overall reference when needed. References stay
fixed during cooling, recovery and preheating. A
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

The [A01–A11/B12 audit record](docs/audit/README.md) documents the current
implementation, validation and commissioning limits.

`npm run check` runs the routine offline Node tests and production build.
`npm run test:extended` adds recovery stress and real SSH/SQLite transport checks;
`npm run test:all` runs both Node suites. Extended CI runs weekly or manually. Browser
smoke checks and container checks are separate; see
[development validation](docs/development-validation.md) for prerequisites,
commands and the latest checked scope. Provider live checks remain opt-in.

Open **http://127.0.0.1:1234**. The UI labels simulated readings and example prices.
If the port is already in use, follow [startup troubleshooting](docs/startup.md)
to identify the running instance and restart it cleanly.
The public `config.json.options` defaults are
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

Open the **Home** or **Garage** upper summary to find **Heating configuration**
with current state, **Temporary heating override**, Away/Pause controls,
preferences and learning in that order. Preferences are **Savings & comfort**
for Home and **Savings & protection** for Garage. Both display their configured
**Savings preference** as 0–100; zero is conservative, and Pause suspends savings.
Changes to permanent preferences use **Apply configuration**. Equipment is in separate
**Sensors & Equipment** (Home) and **Sensors & More equipment** (Garage) folds.
Garage's two chargers sit directly below its heating summary. Each heat pump has
an overview followed by its detailed readings; the ground-source heat pump also
contains **Adjust heat-pump parameters**. Home shows **Tariff control** directly
above **Recirculation**, separating a request from confirmed equipment state.
Garage shows **Heat-pump mode**, **Heating control** and **Room setting**, keeping
fresh device feedback, a request and the saved external setting distinct.
Connection links end each equipment section. Selection marks sit beside the
button labels. The equipment inventory includes individual room and protection
sensors, tariff relays and native Shelly devices. The Caravan fold groups air
temperature and humidity, energy and dehumidifier controls. Native Mitsubishi
temperatures remain in the heat-pump detail view.
Held changes during Pause show an amber notice even when the sections are closed;
changing a paused Heat control selection opens a confirmation explaining its lifetime.
With live `providers` or `mqtt` input and configured controls, Normal and Reduced
send tariff requests through the controller's executor. **Max preheating** requests
normal tariff operation and circulation, and raises the selected ROOM setting
by the configured maximum boost, capped at the writable ROOM upper limit, with
H66 readback. It needs no separate temperature input. Repeated clicks do not add
further boosts. Leaving Max preheating removes that boost while retaining other
manual parameter choices.
Circulation uses MQTT switch ON/OFF and its own configured run duration whether
paused or not. Clicking Start again starts a full new run; Stop ends it immediately.
Ending Pause or restoring a temporary Heat control action does not shorten the run.
A successful MQTT request confirms broker acknowledgement,
not equipment response. Manual actions are logged, do not change Away/Pause or
enable automatic control, and are unavailable in simulation/offline mode.
Failed delivery may be unconfirmed; restoration remains owed until reconciled.
Enabled buttons mean MQTT is configured; the connection is checked when a test
is sent. Connection failures distinguish an unreachable broker, refused connection,
DNS, login or TLS problems and report that no command was sent. If a connection
fails after publishing begins, check device state before retrying because delivery
is unconfirmed.

**Adjust heat-pump parameters** offers ROOM (`0203`), DHW start (`0212`), DHW stop
(`0208`) and operating-mode (`2201`) changes when the connection and fresh writable
readbacks are ready. The current baseline is saved and restored when the manual
change expires under the Pause rules above.
The UI distinguishes a sent request from device readback and a pending restore.
These are real manual commands with live input, including in shadow mode.

For UI development run `npm start` and `npm run dev` in separate terminals. Vite
proxies `/api` to the backend. `npm run preview` alone does not provide the API.

## Using the chart

The interface remembers the browser's last selected theme, with green dark as
the initial default. The header's sun/moon button changes and saves that choice:
sun switches to light, moon switches to dark. The adjacent fullscreen button
expands the whole dashboard without changing its layout or opening chart view.
Both buttons have tooltips and accessible labels. The chart is directly below
the current readings.

- **Dates:** the default is today, midnight to midnight in **Europe/Helsinki**.
  The first date picker changes the start while keeping the end date, unless
  the new start is after the end; then the end moves to match the start.
  The second picker extends the inclusive range immediately; it cannot precede
  the first date. Its subdued single-day appearance remains clickable.
  **Yesterday – today**, **Today** and **Today – tomorrow** provide quick navigation.
  The small arrows beside these shortcuts shift the window one calendar day
  without changing its length. Both date pickers remain available in chart view.
  In landscape, dates sit at the upper left with selection and Exit at the upper
  right whenever the viewport is wide enough for one row.
  Forecasts and known electricity prices appear only
  inside the selected dates; they never extend the horizontal axis automatically.
- **Views:** the button at the chart's top right shows the active view or series
  and opens a centered explorer. Choose **Views** for searchable, grouped
  comparisons or **All series** for individual signals. Switching modes or
  searching leaves the chart unchanged until you choose a result. Electrical
  power compares property demand and both chargers, with heat-pump and auxiliary
  estimates available. Heating water combines supply, return and target with the
  integral; hot water uses tank temperature and its thresholds. Property
  temperatures keeps all three rooms and both garage probes together. Garage
  combines front/rear temperatures and compressor frequency, with **Pump
  interpreted indoor temperature** available in its legend. Saved inputs,
  coefficients, cycle outcomes and interval-energy evidence have their own views
  with explicit units and evidence descriptions.
  Home and Garage both separate **learning**, **coefficients** and **outcomes**.
  Home keeps four input comparisons and four coefficients with distinct units,
  plus two outcome views. Saved temperatures also includes optional ROOM boost
  and the saved control phase; **Space-heating auxiliary input** remains in
  All series. Garage separates saved temperatures/activity, two coefficient
  comparisons, achieved normal warmth references, held-out cooling error and
  provisional benefit per completed pause and recovery. Its existing electrical
  inputs view stays under Garage. Home benefit is a rolling mean per cycle;
  Garage benefit uses individual completion points, with uncertainty and the
  electricity basis on inspection. Neither is metered savings.
  Caravan power uses each measured energy interval's average kW, with its original
  duration and gaps preserved; recorded kWh remains available in interval energy
  and the explorer.
- **All series:** this explorer mode offers the supported chart projections.
  Search by label, unit or canonical signal name; selecting a result closes the
  explorer and updates the selection button. The centered window also works on
  phones and in fullscreen. It opens in the active chart's mode and remembers
  each mode's search separately. Opening it or switching modes keeps focus on
  the mode button; the on-screen keyboard opens only when you select search.
  **Close**, Escape or clicking outside dismisses
  it and returns focus to the selection button. It includes recorded
  measurements, states, energy, counters, saved learning inputs, replayed
  coefficients and supported calculations, including diagnostics beyond the named
  views. Entries stay discoverable when an installation or selected period has
  no records. One selected series is shown with the global price controls;
  categorical signals use an activity row. Cumulative counters, recording-interval
  energy and completed-session checks retain distinct meanings. This catalogue
  is not every database field: arbitrary JSON, configuration and current-state
  snapshots are not historical measurements.
- **Legend and axes:** each view remembers its own series and activity-row
  choices in this browser. **Save view** explicitly saves the selected view and
  visibility choices; **Reset view** restores its initial comparisons.
  Toggling a legend item keeps the list at its current scroll position.
  Temperature-led views need no left scale; operational views have one declared
  left unit and relevant temperatures on the right. Both electricity prices are
  available in every view; their visibility is remembered globally, including
  across resets. Prices and temperatures share the right scale without artificial
  caps. All-in prices use the historical contract or the nearest known rates;
  point inspection identifies assumed rates and missing prices stay unavailable.
- **Lines and fills:** ordinary left-axis history is solid and right-axis
  temperatures dashed. Future forecasts use dash-dot and electricity prices
  stay dotted. Every plotted
  temperature in °C uses monotone cubic curves, including targets, settings,
  references and temperature differences; humidity is smooth too. This is display
  interpolation only: recorded setting changes, control and learning are unchanged.
  Power, states and model coefficients retain steps. Runtime readings and native
  cumulative counters use individual hollow points, without a connecting line.
  Interval totals and session checks also use larger hollow points with generous
  hover and touch targets; isolated recorded samples remain easy to inspect.
  Point inspection follows the pointer's position on both axes, so another
  series at the same time does not take over the tooltip. Away from point targets,
  hovering still compares readings at the nearest time.
  Artificial display boundaries and held tails are not marked as observations.
  Manual additions retain their distinct markers. Charger 1 and Charger 2
  retain turquoise and purple fills, stacked where their intervals overlap.
  Enabling charger traces in **Phase loading** also shows fills, stacked only
  within the same L1, L2 or L3 phase where overlapping evidence supports it;
  property phases stay reference lines. Different phases are never stacked together.
  Auxiliary is an independent line; it is already included in the whole heat-pump
  estimate. Missing evidence never becomes a fabricated zero or bridged gap.
- **Solar history:** **Solar estimate** shows the latest valid forecast-derived
  estimate known at each historical plotted time, with its original provider
  provenance. A newer forecast never replaces earlier plotted history with
  hindsight values. Its line is solid; **Solar forecast** shows the future outlook
  separately with a dash-dot line.
  The six-hour freshness limit concerns the age of the source forecast evidence;
  it does not restrict the forecast horizon to six hours. Neither series is a
  house radiation measurement.
- **Activity and cursor:** relevant operating states appear in labeled rows below
  the plot. One **Home compressor** row shows stopped, space heating, hot water
  or running with unknown routing. Missing or expired compressor evidence stays
  blank. Every row title expands to explain its evidence, colours, patterns and
  blank intervals. Wide layouts also show a compact colour key beside the title;
  on phones the key stays inside the fold.
  Garage pump power readback and managed pause have separate rows: power is the
  saved native on/off report; managed pause records a savings or timed-off control
  pause, not measured savings or proof of automatic control. Requested reduction,
  **Hot-water circulation request**, **Hot-water circulation feedback** and modeled
  fireplace windows remain separate.
  Open **Legend** to select series and rows for this view. The list scrolls while
  **Reset view** stays visible. In fullscreen, opening the legend temporarily
  hides the indicator strips; closing it restores them. Every activity icon uses
  the same stripe style with its usual active colour, such as Auto for Pump mode
  and space heating for Home compressor. Hover or drag an indicator
  strip to inspect a shared time, including by touch. The cursor appears only in
  the plot and visible strips, leaving titles and gaps clear. Strips move the
  cursor; chart-view plot gestures zoom and pan. Row inspection reports its
  interval and evidence. At long
  ranges, activity occupancy and reduced state samples are explicitly identified.
- **Reading evidence:** open **How to read this view** for line conventions and
  the selected quantities' interpretation. Recorded power reconstructed from
  energy is an interval average, and phase-current equivalents assume 230 V and
  unity power factor. Imported coherent current observations retain their original
  basis. Saved indoor averages retain their original sensor membership. The
  garage pump's interpreted temperature is a diagnostic, not a third independent
  protection sensor. Viewing history sends no equipment commands.
- **Energy cost comparisons:** open this fold below the chart for **Heating**,
  **Charging** and **Fireplace**. Heating starts on **Home** and **Model estimate**;
  a saved **Timing cost** choice is restored. **Home**, **Garage** and **Total**
  select the heating scope. Model estimate sums supported, frozen cycle assessments
  on their Finnish completion dates, including recovery and excluding domestic hot
  water. It reports a selected-period total, not the Learning view's rolling
  €/cycle mean. Home's cycle electricity uses a temperature-dependent heat-pump
  source estimate; it is not a separate meter reading.
  Charging offers **Charger 1**, **Charger 2** and **Total** for timing comparisons.
  Heating's **Timing cost** and Charging compare the cost of included energy at
  its recorded times with the same daily energy at the whole Finnish day's average
  all-in price. Home timing reconstructs heat-pump electricity, including hot water,
  from recorded compressor activity and auxiliary output using the nominal powers
  saved for that time. This differs from Home's cycle electricity estimate. Garage
  timing requires qualified dedicated electrical intervals. Charger electricity
  uses recorded phase or total energy intervals; eligible current snapshots retain
  their 230 V estimate. The visible basis and
  source details identify those estimates and simulation. Missing equipment data
  or dated heat-pump power assumptions leave gaps. Heat-pump power is never
  property consumption minus charger consumption.
  Timing views show **Time included** as a percentage of the selected elapsed time;
  completed-cycle model estimates show assessment counts instead. Heating **Total**
  combines Home and Garage system-time. Combined **Charging** uses **charger-time**:
  one hour on both chargers is two charger-hours, and a 24-hour selection contains 48
  possible charger-hours. Its cost and energy are the sums of Charger 1 and Charger 2;
  missing Charger 2 history remains unknown. Heating includes valid zero-power intervals;
  charging leaves out idle periods at or below 100 W. A low charging
  percentage can therefore mean idle time, missing history, or incomplete prices.
  The full-day average price still includes every hour. Missing readings remain
  unknown, separate from idle time. With no detected charging, no comparison is shown.
  The source mix is weighted by included time, not sample count, energy or
  accuracy. Missing history and all timing periods with incomplete daily prices
  are excluded, without extrapolation. Future hours do not reduce coverage.
  Calculations use the underlying energy and equipment intervals independently
  of chart point reduction and the selected chart view.
  Timing differences are separate from charger session cost estimates, which
  include delivered electricity and expected charging to the target.
  The fold starts closed, like **Recording details**, and stays as you set it
  when the chart refreshes or dates change. The three comparison cards
  align when closed; each details fold expands independently. Timing and cycle
  details expose the included kWh where applicable and the cost operands behind the difference,
  alongside source shares, timestamps and missing-data notes. Shared explanations
  appear in **How these comparisons work**. Missing historical contract rates
  use the nearest known rates with historical spot prices;
  **Assumed rates** includes assumptions affecting the daily average even when
  the device ran during a period with known rates. This comparison does not
  establish savings caused by the controller.
  **Fireplace** estimates the space-heating electricity and cost difference
  with wood priced at zero. It shows a scenario range, evidence status and coverage
  for the selected dates, with any remaining forecast estimate separately. It uses
  a different reference from the other comparisons, so the cards are not summed.
  Unlike frozen cycle assessments, this retrospective estimate can change when
  logged wood or the reconstructible model is corrected.
  Manual wood loads, delayed release, the fitted response and daily savings are
  also available in the Fireplace views. See [fireplace details](docs/fireplace.md).

Chart changes affect the display only. Viewing history neither polls providers
nor sends equipment commands. Large ranges use bounded display resolution,
preserving extremes and missing-data breaks. Power reduction also retains peaks
for the visible charging fills and their property comparison. A display
bucket with too many separate gaps marks its interior unavailable. Interval-energy
values appear as separate marks and never connect across unrecorded time. Dense
activity rows represent recorded occupancy within each display interval. Queries run
in a background worker and recent selections are cached. New energy-audit readings
and finalized session checks invalidate their historical chart responses; unrelated
operational events do not. A newer selection cancels an obsolete request.
For date ranges containing now, temperature, power, phase-current and integral
lines extend their last recorded value to the current time on each status refresh,
even when the history response is cached. Hover text identifies the original
recording time. These display extensions do not add measurements to history or
make old readings fresh for control. Missing/invalid values retain their gaps;
prices, forecasts and equipment-state rows keep their recorded time bounds.
Auxiliary output has a five-minute freshness bound. Learning histories keep the
estimate assessed at the time and never rewrite old points using a later model.

Above the chart, separate **Home** and **Garage** cards show **Heat control**
status. Home has a **Fireplace** button; Garage has a chart button.
Home's upper summary shows the indoor average, outdoor
temperature, heating request and all-in electricity price; Garage's shows its rear
temperature, doors, heating request and the same price. A compact row below Home's
readings shows the next planned heating change and its Finnish local time, or the
current pause, recovery or no-plan state. Shadow and simulated plans are labeled.
The equipment and connections fold headers keep their height when toggled;
small desktop column differences use spacing between sections, with larger
differences retaining their natural height. Each upper summary opens
**Heating configuration**, including manual heating and temporary controls.
Home offers Away/Pause; Garage offers **Pause price control**. Home's **Fireplace**
button opens a window for recording firewood and reviewing recent entries.
**Sensors & Equipment** spans Home's width and contains its readings and equipment controls.
Garage's two expandable chargers sit above **Sensors & More equipment**.
Select the **Doors** status (such as **Both closed**) to operate either door from
a window matching **Fireplace**, with the same illustrated door cards. **Go back**
or **Escape** returns to the dashboard. Each door offers **Open** or **Close**
from its reported state, or **Stop** during movement when supported. Sent requests
stay separate from the reported position; unknown readings and read-only views
cannot operate a door.
Tariff requests remain explicitly unverified when relay readback
is unavailable; stale H66 readings are not presented as current settings.

**Home learning** and **Garage learning** sit in their respective **Heating configuration**,
after temporary controls and savings preferences. Home reports counts
of usable observations and accepted model updates. Missing counts remain unknown.
Each learning summary opens its **calculated outcomes**,
**model inputs** and **current model coefficients** sections. Coefficients show values,
units and fitted/fixed provenance from the existing learning state, without
additional coefficient storage. Historical coefficient chart axes separately
replay the saved journal with its matching algorithm. See the detailed
[learning and control explanation](docs/learning-and-control.md).

**Data & settings** groups electricity consumption, electricity prices, vehicle
telemetry, and temperatures and weather. Each category opens its reading lists,
with source names and availability. Named vehicle feeds and their descriptions
appear directly in Vehicle telemetry.
**Connections & configuration** contains **MQTT**, **Electricity rates**
and **Configuration**. MQTT owns device and vehicle connection details, topics
and packet diagnostics. Electricity consumption separates Easee cloud, local
Easee OCPP and Shelly EVSE. The local connection and charging-control disclosure
sits below the OCPP introduction. Shelly supplies measured three-phase current,
voltage and active power, a total energy counter and session energy; recorded
consumption uses total meter differences. Vehicle feeds do not supply charger
electricity measurements.
On wide screens, Home and **Data & settings** occupy the left column, with Garage
on the right. On narrow screens, the cards appear in this
order: Home, Garage, Data & settings. The event log follows them.
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
caches remain in `STMQ_DATA_DIR` (`/data/st-mq` in HA). Only the explicitly selected
current database is opened; other database paths are never discovered or relocated.
An incompatible database is rejected unchanged. Before v1.0.0, initialize a new
database deliberately and re-import supported v0.7.5 CSVs. `/share/st-mq` remains the exchange
folder for historical CSVs and exported backups. See [SSH access and backups](DOCS.md#ssh-database-access-and-backups).
These databases and supplied CSVs are excluded from Git and Docker contexts.
Keep private configuration outside the repository. Standalone uses the permanent
`secrets.json` described below; Home Assistant owns its saved add-on options.
Historical encrypted configuration is covered by the archival audit in
[secret handling](docs/secret-handling.md); it is not the current configuration workflow.

```sh
npm run history -- import --file /path/to/st-mq.csv --kind stmq
npm run history -- summary
npm run history -- tail --follow
npm run history -- export --output /tmp/indoor.csv --signal indoor_temperature
npm run history -- backup --output /tmp/st-mq-backup.sqlite
npm run history -- restore --input /tmp/st-mq-backup.sqlite --db /tmp/restored.sqlite
STMQ_INPUT=offline npm start
```

Explicitly select a v0.7.5 `st-mq.csv` or `easee.csv` input and its matching kind.
The importer stages bounded batches with SHA-256 provenance and publishes only
a verified complete generation. Interrupted attempts can be retried; publication
IDs remain monotonic across independently completed files.
Importing the same file twice adds no observations. Differently edited source
files retain separate provenance; they are not silently merged into canonical
historical readings. Historical prices stay ex VAT. Missing readings stay null,
zero-current anomalies stay flagged, and commands never become compressor labels.
March–May 2026 is an approximate absence/heating-off annotation excluded from
occupied-model training. Manual counters and annotations can be entered explicitly with their own provenance.
DHW runtime is not added to compressor runtime.

Backups use SQLite's online backup API. Restore to a new path while the target
application is stopped; validate it before changing the configured path. Keep
backups on separate storage. Incompatible or malformed schemas are rejected
before mutation; development databases require a deliberate fresh start. Raw observation queries are bounded to at most 5,000
observations; `/api/history` limits a request to 31 days. The separate `/api/chart`
endpoint accepts inclusive `start`/`end` calendar dates and either a named `view`
from the shared view catalogue or a `left` projection key for an individual series.
Supplying both selectors is rejected. A named view fetches its declared
quantities, temperatures and recorded state rows together. The `points` resolution
is 100–2,000 time buckets per series. It accepts at most
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
| `STMQ_API_TOKEN` | Admin password; overrides `controller.web_token`; at least 24 characters for direct network access |
| `STMQ_FAMILY_API_TOKEN` | Optional family password; overrides `controller.web_family_token`; distinct from admin and at least 24 characters for direct network access |
| `STMQ_CONFIG` | Standalone private override JSON; defaults to `$XDG_CONFIG_HOME/st-mq/secrets.json`, or `~/.config/st-mq/secrets.json`. In the add-on, overrides only the initial/fallback Supervisor export path. |
| `STMQ_MAX_DROP_C` | Occupied preferred drop; overrides `controller.max_drop_c` (default 1.5°C) |
| `STMQ_H66_DEVICE` | Exact H66 topic prefix; enables H66 alongside a configured MQTT broker |
| `STMQ_H66_VERIFICATION` | Optional JSON path with verified register scaling/evidence |

Home Assistant ingress grants full admin access using the existing Home Assistant
login. Optional direct
add-on access on port 1234 is enabled only with a valid `controller.web_token`;
clearing both web tokens and applying configuration disables direct access while
ingress remains available. Standalone loopback access permits an empty admin
token when family access is disabled; listening beyond loopback requires a token
of at least 24 characters. Family access requires a separate admin password. Use a
trusted local network or an authenticated HTTPS reverse proxy for remote direct
access. Credentials are never returned in API responses. A direct-access browser
keeps its entered password in session storage for its tab. The password prompt
includes an eye button inside the password field to show or hide the entry.
The **Configuration** section shows the current role and provides **Log out**
for password-based access. Logging out returns to the
password prompt without stopping device operations already requested. Ingress
shows admin access through Home Assistant; use Home Assistant to log out there.

Set the optional `controller.web_family_token` in the existing private
configuration to enable the family login, for example on a shared fridge screen.
One password field accepts either credential and selects its role. Family can
read every page, setting, chart and diagnostic, with credentials still concealed.
Family can perform only these writes:

- Record firewood and remove any entry within 15 minutes of its being recorded.
- Start and stop DHWR circulation.
- Set, change or cancel Away and home/garage Pause, and use temporary Home
  Normal/Reduction/Preheat and Garage Normal/protected Off controls, including
  while Away or Pause is active. Existing expiry, restoration and freeze
  protection rules still apply; Garage freeze protection can override Off while
  paused.
- Open, close and stop configured garage doors where supported.
- Use all EV charging card controls, including persistent automatic charging and
  charger priority choices and changes scoped to the current physical session.

All other writes, exports and downloads require admin. This includes native
heat-pump parameters, the durable Garage temperature target, device tests,
maintenance, pairing and configuration application. EV installation settings,
commissioning, integration credentials and electrical limits remain admin-only.
The server enforces the split for API calls as well as dashboard buttons; newly
added write actions are admin-only unless explicitly permitted for family.

MQTT reuses the existing broker address/user/password and subscribes to
`<device>/HP/#` and configured indoor/garage temperature topics alongside online providers. Supported active control and
explicit manual tests can publish SET requests. Plain H66 values lack a source
measurement timestamp: non-retained receipt time is labeled as the communication
freshness basis, with the source timestamp still unknown. Retained, duplicate and
invalid messages are handled explicitly. A documented C60 profile does not prove
installed-device semantics. See [learning and H66 control](docs/learning-and-control.md).

Start live collection in the default heating shadow mode with:

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
Freezing protection tracks separate local heat reserves for pipes and stored
liquids, using a water-filled copper pipe as the reference. **Savings & protection** shows
the temperature margin, reference dimensions, heat-transfer estimate and fixed
safety factor. Cooling and recovery follow measured air temperature continuously;
there is no fixed refill timer. An open door blocks a new savings pause below
2°C outside; an existing pause is reassessed against measured protection.
Savings pauses have a one-hour planned minimum and no fixed maximum; local
temperatures, forecast pipe reserve, uncertainty, economics and available forecast
coverage determine their duration. Garage's 0–100 **Savings preference** changes
the minimum estimated benefit and the fraction of the best benefit a shorter
pause must retain. The default 50 requires more than €0.50 and retains at least
80% of the best benefit; 0 requires more than €0.75 and retains 60%, while 100
requires more than €0.25 and chooses the greatest benefit. These use the shared
€0.50 baseline and are engineering policy, not learned optimal thresholds.
Protection and recovery requirements remain independent of the preference.
The Pill's short renewable OFF permission
still restores heating on communication loss without limiting the total pause. See
[protection parameters](docs/garage-protection-defaults.md) for assumptions and
reporting/restoration deadlines.
The `shelly-cn105` Pill integration supports native controls and commissioned
selective pause leases. **Room setting** retains your chosen target down to 5°C
until you change it, including after restart,
using the independent Garage rear sensor and the Pill's external temperature
feature: ST-MQ selects native 17°C heating and the reported external value adds
`17 − room setting` (+12°C for a 5°C target). Each enable or renewal requires
fresh ON, HEAT and 17°C readbacks; a failed check stops renewals and the existing
lease expires. Lost, unaccepted renewals retry when fresh driver evidence and a
new challenge prove the earlier request can no longer take effect; the original
90-second sensor deadline remains unchanged. Driver
capability and its local feature flag are required; economic pauses still need
independently verified baseline and restoration evidence. Provider input in shadow mode observes
and plans; active mode can use a configured command transport.

| Data | Primary → backup | Normal collection interval |
| --- | --- | --- |
| Electricity prices | ENTSO-E → Elering's own public API | 1 hour; 15-minute retry when next-day horizon is missing |
| Temperature and solar forecast | FMI HARMONIE → Open-Meteo ICON Seamless | 30 minutes |
| Outdoor temperature | FMI nearby station → Open-Meteo model estimate | Every 5 minutes |
| Indoor temperatures | Configured local MQTT room sensors | 70-minute maximum reporting interval plus five minutes of grace |
| Garage temperatures | One configured Shelly or MQTT connection | Shelly polled every 30 seconds; either connection expires after two minutes |
| Property/charger electrical observations | Easee SignalR stream → REST backup | Complete cached snapshots sampled every 15 seconds; REST reconciliation every 15 minutes |
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

Current outdoor temperature uses a fresh **FMI nearby station** reading, with an
**Open-Meteo model estimate** as backup. Source priority takes precedence over a
slightly newer backup timestamp. H66 outdoor readings are excluded from outdoor
control, learning and new recorded temperature history. FMI selects the nearest fresh station among up to three
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

One Easee stream serves the configured Charger 1 and Equalizer. It subscribes to
their current state and subsequent observations, using the same persisted tokens
as REST. Missing required stream readings use batched REST backup at the normal
acquisition cadence; healthy streaming keeps a 15-minute REST reconciliation.
Cloud schedules and charger commissioning use REST. With native OCPP active,
authorization and economic pause commands use the local connection instead.
Multiple Easee chargers are not added by this transport change.

Easee readings retain original source ages. Reported active power is integrated
between sampled snapshots and allocated to three estimated phase energies; raw currents and
voltages remain acquisition-only. The property cumulative-import counter and the
finalized Charger 1 / Charger 2 session references support diagnostics without
correcting or calibrating those estimates. Charger lifetime counters are not retained.
Stream loss and restart break energy continuity explicitly; reconnecting does not
fill missing intervals or make cached device values fresh. Provider diagnostics
name the live stream and REST backup while retaining reading-quality warnings.
Charger voltage terminal mapping requires explicit verification before voltage
weights are used. Easee acquisition can refresh authentication tokens. Separately
enabling **Automatic charging** in the dashboard permits
automatic scheduling writes, including while heating is in monitoring or shadow
mode; it is off by default. Automatic charging and shared charger priority are
saved UI choices, retained across restart and unplugging for the same equipment.
The four shared and vehicle-specific ready-by and battery defaults are
configuration-owned; **Save for this session** cannot replace them. **Charge now**
releases economic scheduling for the current connection even with Automatic
charging OFF, while preserving native device and vehicle constraints.
Cloud delayed starts and native OCPP control are exclusive. Native OCPP setup is
managed by ST-MQ, with a stable shared address in paired mode. Opt-in
`plug-and-charge` authorization supports RFID-free starts; economic pauses use
only expiring 0 A transaction profiles and release to the existing charger and
Equalizer limits. Cloud fallback supplies readings, not a second active
scheduler. Normal Ctrl+C or service stop requests cloud handback; paired handover
keeps OCPP active. **A crash or power loss can leave charging waiting for ST-MQ
approval.** Restart ST-MQ or disable Direct OCPP through Easee configuration;
autonomous pause expiry does not restore cloud authorization. See [local setup and verified limits](docs/charging-easee.md#direct-local-ocpp-telemetry-firmware-344-or-later).
Charger 2 supports verified EVSE start/stop and current limits, with control disabled until commissioned. See [charging](docs/charging.md) and
[recording configuration and limitations](docs/recording.md).

Optional [vehicle feeds and physical Charger 2](docs/recording.md#charger-2-physical-capture-and-vehicle-feeds)
use the existing MQTT broker. TeslaMate supplies read-only vehicle identity, SoC
and native constraints for either physical charger. Only the physical Shelly
meter records new C2 home energy. See [commissioning](docs/charging-provider-capabilities.md)
for the disabled-by-default device profile and unverified controller-loss behavior.

Normal `npm test` and `npm run check` stay offline. To verify current service access
and the configured keys explicitly, use the [bounded live test suite](docs/live-testing.md):

```sh
npm run test:live
npm run test:live -- --services fmi-forecast,fmi-observation
```

Each primary and backup is checked separately, so a working fallback cannot hide
a rejected key. The suite uses no MQTT and sends no equipment commands.

## Permanent configuration and prices

`config.json` is public: its `options` object contains shared application
defaults, including standard MQTT topics and equipment definitions. Its metadata
and `schema` describe the Home Assistant add-on. Keep installation credentials,
private identifiers and your own overrides in `secrets.json`, using a **plain JSON
options object** without the manifest's outer `options` wrapper. Despite its name,
this file can also hold non-secret choices such as Garage enablement and approval.

Keep `secrets.json` small: include only the fields you need to supply or override,
with related fields under their existing section. Do not copy entire default
sections or repeat unchanged MQTT topics. Shared defaults can evolve without
adding fields to your file. See the [configuration guide](docs/configuration.md)
for the section map, a minimal Garage example and rules for adding settings.

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
disable direct add-on access, set
`"controller": { "web_token": "", "web_family_token": "" }` and apply.
On Ubuntu, removing a key from the permanent file restores the public default
on the next application. Invalid values reject the change; no private values are
included in validation errors or status responses.

The button is at **Data & settings → Connections & configuration → Configuration →
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

`recording.annual_budget_gb` defaults to `10`. There is no maximum recording
interval; the retired `max_interval_minutes` option is rejected. Acquisition
intervals and source expiry have separate options;
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

`controller.max_drop_c` and `controller.max_rise_c` both default to 1.5°C around
each room's learned occupied reference, with the overall reference as fallback.
**Overall comfort reference** and expandable **Room references & limits** show
these values. The allowances are shared across rooms and do not constrain Away
operation; savings preference never widens them.
`controller.preheat_room_boost_c` defaults to 5°C above the ROOM setting
captured before preheat, capped at the device maximum. It changes heat-pump demand,
not the room-air comfort reference. `controller.recovery_hold_minutes` defaults to
60: space heating resumes while DHWR remains suppressed and DHW settings remain
reduced. AUX stays restricted during the same interval when
`controller.recovery_compressor_only` is enabled; room-comfort fallback can restore
AUX earlier. The deadline is fixed when reduction ends and survives restarts.
Normal DHW settings and circulation eligibility return at expiry. To restore them
earlier, pause price control; this selects Normal heating and restores the captured
native settings. Start a timed circulation run separately if needed.
`controller.input` and `controller.mode` are also configuration-owned.

The optional `electricity.effective_date` is a Finnish calendar date. First-use
rates begin today if no date is supplied; subsequent changes begin when loaded.
Rates, transfer amounts and VAT are saved per period with an explicit tax basis
so future changes preserve historical calculations. Missing tax basis is not
interpreted as an older native representation. Explicit dated VAT-inclusive
tariff facts remain valid. Unstarted scheduled changes can be revised in options.
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
history; the chart keeps requested circulation and recorded on/off feedback
in separately labeled activity rows. See
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
live commissioning. [The v0.7.5 CSV reference](docs/LEGACY.md) describes the only
supported historical import boundary; development databases and configurations
are not migrated.

Firewood loads and mistaken-entry corrections are described in
[Fireplace logging](docs/fireplace.md). The [model reconstruction and versioning
contract](docs/reconstruction-and-versioning.md) defines the retained replay scope.
