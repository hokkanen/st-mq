# Standalone startup and troubleshooting

For Home Assistant installation and saved app options, see [the setup guide](../DOCS.md).
The shell commands below are for standalone Linux. In Home Assistant, start,
stop and restart ST-MQ through **Settings → Apps → Home Energy** and read its **Logs**
tab. Restarting Home Assistant Core alone does not restart the ST-MQ app.

## Run locally

Use Node.js 22.19 or newer. The container baseline is Node 22; CI also checks
Node 24. SQLite is built into Node. From the repository root:

```sh
npm ci
npm run build
npm start
```

Open `http://127.0.0.1:1234`. Without an explicit input selection, startup uses
simulated devices with Home heating paused. Simulation and offline input do not
connect to providers. Live acquisition uses `STMQ_INPUT=providers`; choosing an
input does not grant automation permission. Configure each integration and
feature's authority separately before operating equipment.

For UI development, run `npm start` and `npm run dev` in separate terminals.
Vite proxies `/api` to the backend; `npm run preview` alone does not provide it.
The normal server serves the completed UI build.

## Moving from an earlier version

`main` includes the H66 development work. To evaluate the published development
prerelease in a separate checkout, select its tag explicitly:

```sh
git clone --branch v0.9.5-dev.1 https://github.com/hokkanen/st-mq.git st-mq-dev
cd st-mq-dev
npm ci
npm run build
```

Keep existing installation configuration, databases and original CSV exports
outside this checkout. The current version accepts only its current configuration
and database formats; it does not translate 0.7.5 settings or migrate earlier
development databases. Review [configuration](configuration.md), select a fresh
database directory explicitly when needed, and use [CSV import](csv-import.md)
only for the two supported 0.7.5 exports. Incompatible databases remain unchanged.
Current-format backup/restore and restart remain supported.

Begin with simulated input and separate data/database paths when evaluating
alongside an existing installation, as shown in the isolated-start example below.
Before replacing a live controller, retain its backups and resolve outstanding
equipment changes and restoration duties. Stop the previous command owner and
commission the replacement's live integrations and feature permissions explicitly.

## Environment and private configuration

Public defaults are in `config.json.options`; the sparse private file overrides
them. Keep private files outside the checkout, with file mode `0600` and directory
mode `0700`. See [configuration](configuration.md) for ownership, review/apply,
electricity rates and the admin/family access policy.

| Variable | Default / purpose |
| --- | --- |
| `STMQ_INPUT` | `simulated`; also `offline`, `mqtt`, or `providers` |
| `STMQ_DATA_DIR` | `./var`, or `/data/st-mq` in the app |
| `STMQ_DATABASE_DIR` | Same as data directory on Linux; `/config/st-mq` in HA |
| `STMQ_PORT` | `1234` |
| `STMQ_HOST` | `127.0.0.1` on standalone; optional app direct access listens on `0.0.0.0` |
| `STMQ_API_TOKEN` | Admin password; overrides `controller.web_token`; at least 24 characters for direct network access |
| `STMQ_FAMILY_API_TOKEN` | Optional family password; overrides `controller.web_family_token`; distinct from admin and at least 24 characters for direct network access |
| `STMQ_CONFIG` | Standalone private override JSON; defaults to `$XDG_CONFIG_HOME/st-mq/secrets.json`, or `~/.config/st-mq/secrets.json`. In the app, overrides only the initial/fallback Supervisor export path. |
| `STMQ_MAX_DROP_C` | Occupied preferred drop; overrides `controller.max_drop_c` (default 1.5°C) |
| `STMQ_H66_DEVICE` | Exact H66 topic prefix; enables H66 alongside a configured MQTT broker |
| `STMQ_H66_VERIFICATION` | Optional JSON path with verified register scaling/evidence |

[deploy/st-mq.service](../deploy/st-mq.service) is a standalone systemd example.
Adapt its paths and service account before installing it. Stop the previous
command owner before commissioning a replacement instance.

## An occupied web port

`STMQ_INPUT=providers npm start` runs a new ST-MQ process. It does not replace an
instance already running in another terminal or as a service. The default web
address is `127.0.0.1:1234`; `STMQ_INPUT` selects data acquisition and does not
change that address.

If startup reports `EADDRINUSE`, another process already owns the requested
address and port. Inspect the owner before changing anything:

```sh
ss -ltnp 'sport = :1234'
```

If it is your existing ST-MQ instance, use its dashboard or stop it cleanly before
restarting. Use Ctrl-C in its original terminal. For a service, restart the unit
that owns that process. For an identified detached ST-MQ process, send `SIGTERM`
and wait for it to exit before starting again. Graceful shutdown closes MQTT and
reconciles temporary equipment restoration owned by the instance. Ordinary
stop/restart preserves native Easee OCPP configuration and outstanding charger
restrictions; only explicit integration changes request cloud handback. Avoid
`kill -9`.
Do not stop an unfamiliar process or a separate production installation.

ST-MQ checks its web listeners before constructing the controller, opening device
MQTT connections, starting provider requests or running the first control tick.
A failed bind exits with status 1 and identifies the address and configuration
setting. The existing process is left running. HTTP API requests return status 503 until
the new instance has completed startup. This port check does not replace the
controller authority protection used by instances on different hosts or ports.

If a different application intentionally owns port 1234, set `STMQ_PORT` to an
available port for the single ST-MQ instance. For an additional isolated UI or
simulation, use simulated input and a separate storage directory as well:

```sh
STMQ_INPUT=simulated STMQ_PORT=1235 STMQ_DATA_DIR=/tmp/st-mq-demo \
  STMQ_DATABASE_DIR=/tmp/st-mq-demo npm start
```

Do not work around a duplicate live controller by changing only its port.

The Home Assistant app uses host networking, so its listeners share the host's
port space. The manifest declares `ingress_port: 0`; Supervisor assigns an
available port and ST-MQ retrieves it before binding. No manual ingress port
setup is needed. If Supervisor cannot provide a valid assignment, startup fails
with an actionable error instead of choosing a fixed port. `STMQ_INGRESS_PORT`
is an explicit override for isolated container fixtures and custom deployments.

Direct access still uses host port 1234 and is opened only when an admin password
is configured. Host-network listeners cannot be remapped through the app's
Network settings. Resolve a conflicting direct listener before restarting
ST-MQ. Startup also rejects an ingress assignment that collides with another
ST-MQ listener.

The Node.js experimental SQLite warning is informational and is unrelated to
`EADDRINUSE`. The port conflict is the startup failure to resolve.
