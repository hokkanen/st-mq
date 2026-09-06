# Home Assistant add-on development setup

The 0.8.0 application starts with **simulated devices and shadow plans**. No live
controller or provider is launched. Implementation is not production commissioned;
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

A blank network-access token prevents startup with a clear configuration error.
The Home Assistant settings select startup defaults; settings edited in the UI
persist in the database for that input. `active` applies only to simulated devices.
The house comfort reference is inferred; preferred drop defaults to 1 °C.

The Dockerfile uses an explicit Node 22 Alpine base with a default `BUILD_FROM`, a
finite frontend build and `npm ci`. It does not rely on Supervisor injecting a
base-image argument, and contains no architecture-specific native SQLite addon.
Node's own SQLite and Intl time-zone support are exercised in the container smoke
check. Development has not installed or started this add-on on the owner's HA.

Physical relay/H66 command ownership, controller compatibility, bounded writes,
readback and communication-loss behavior must be verified before a later live
migration. Retain the relay hardware until that migration is demonstrated. Existing
legacy scripts are preserved and gated; see [README](README.md).
