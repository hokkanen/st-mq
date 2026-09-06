# Home Assistant add-on development setup

The 0.8.0 application starts with **simulated devices and shadow plans**. Default
startup launches no live controller or provider. Implementation is not production commissioned;
see [progress and remaining work](docs/PROGRESS.md).

1. Build/install ST-MQ through the repository's existing add-on mechanism on
   `aarch64` (Raspberry Pi 5) or `amd64`.
2. In the add-on configuration, set `controller.web_token` to a private token of
   at least 24 characters. It protects household data and settings. Leave
   `controller.input: simulated` and `controller.mode: shadow` for initial review.
3. Start the add-on and open the web UI on its mapped port (default 1234). Enter
   that token in the browser. The UI clearly labels simulation.
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
7. The provider stage adds `controller.input: providers` for read-only acquisition
   from configured services. Reuse existing geolocation, ENTSO-E and OpenWeather
   connection fields; SmartThings indoor/outdoor sensors and Easee are optional.
   Device acquisition runs every five minutes, while market/weather refresh hourly.
   This selects external reads and authentication, and enables no equipment writes.
   Offline integration checks pass; start with the simulated review
   path above. Development has not used the owner's API credentials.
8. In the web contract form, enter an effective date, retailer margin and electricity
   tax in c/kWh excluding VAT, VAT as a percentage, and the transfer tariff. Keep
   the current day/night tariff unless the household contract has actually changed.
   Transfer rates already include VAT. No current tax defaults or historical
   effective dates are inferred. The seasonal alternative is available but is never
   activated merely because a future switching date was discussed.

A blank network-access token prevents startup with a clear configuration error.
The Home Assistant settings select startup defaults; settings edited in the UI
persist in the database for that input. `active` applies only to simulated devices.
The house comfort reference is inferred; preferred drop defaults to 1 °C.
Unsupported warm-weather temperature plateaus are excluded from new reference
candidates. Cached provider readings keep their source timestamps through outages
and restarts. The OpenWeather forecast records fetch time separately because its
JSON response does not supply a documented issuance timestamp.

Elering fallback awaits vetted interval/VAT semantics for the specific endpoint;
this is a developer integration limitation, not an additional household setup
question. The ENTSO-E provider does not require those settings. The provider stage
has offline protocol fixtures; real API access, token behavior and Raspberry Pi
runtime still need commissioning. The current x86 container checks do not establish
behavior on the owner's Home Assistant installation.

The Dockerfile uses an explicit Node 22 Alpine base with a default `BUILD_FROM`, a
finite frontend build and `npm ci`. It does not rely on Supervisor injecting a
base-image argument, and contains no architecture-specific native SQLite addon.
Node's own SQLite and Intl time-zone support are exercised in the container smoke
check. Development has not installed or started this add-on on the owner's HA.

Physical relay/H66 command ownership, controller compatibility, bounded writes,
readback and communication-loss behavior must be verified before a later live
migration. Retain the relay hardware until that migration is demonstrated. Existing
legacy scripts are preserved and gated; see [README](README.md).
