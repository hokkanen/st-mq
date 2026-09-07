# Home Assistant add-on development setup

The 0.8.2 application starts with **simulated devices and shadow plans**. Default
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
4. Persistent data is under `/data/st-mq/`, inside the add-on's persistent data
   volume. Include this in backups. The existing `/share` mapping is retained.
5. Import history explicitly with `node scripts/history.js import --db
   /data/st-mq/st-mq.sqlite --file /share/st-mq/st-mq-corrected.csv --kind stmq`,
   then import Easee with `--kind easee`. Input files are never included in the
   application image.
6. Choose `controller.input: offline` to view imported history and rebuild its
   model without device connections. `mqtt` additionally requires verified H66
   installation and `controller.h66_device`; acquisition is read-only. MQTT
   connection fields reuse the existing configuration.
7. Choose `controller.input: providers` for read-only acquisition. Existing
   latitude/longitude and market country enable the public FMI and Elering
   providers without new keys. ENTSO-E remains the primary price source, with
   Elering's own API as automatic backup. FMI is primary for the weather forecast
   and nearby-station outdoor temperature; the existing OpenWeather token enables
   both backup services. These are independent fallback chains. SmartThings
   indoor/garage sensors and Easee are optional. Collection runs every five minutes
   for devices, ten minutes for outdoor temperature, and hourly for prices and
   forecasts. This input sends no equipment commands.
8. In the web contract form, enter an effective date, retailer margin and electricity
   tax in c/kWh excluding VAT, VAT as a percentage, and the transfer tariff. Keep
   the current day/night tariff unless the household contract has actually changed.
   Transfer rates already include VAT. No current tax defaults or historical
   effective dates are inferred. The seasonal alternative is available but is never
   activated merely because a future switching date was discussed.

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
The Home Assistant settings select startup defaults; settings edited in the UI
persist in the database for that input. `active` applies only to simulated devices.
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

The Dockerfile uses an explicit Node 22 Alpine base with a default `BUILD_FROM`, a
finite frontend build and `npm ci`. It does not rely on Supervisor injecting a
base-image argument, and contains no architecture-specific native SQLite addon.
Node's own SQLite and Intl time-zone support are exercised in the container smoke
check. Development has not installed or started this add-on on the owner's HA.

Physical relay/H66 command ownership, controller compatibility, bounded writes,
readback and communication-loss behavior must be verified before a later live
migration. Retain the relay hardware until that migration is demonstrated. Existing
legacy scripts are preserved and gated; see [README](README.md).
