# Startup and an occupied web port

For Home Assistant installation and saved app options, see [the setup guide](../DOCS.md).
The shell commands below are for standalone Linux. In Home Assistant, start,
stop and restart ST-MQ through **Settings → Apps → Home Energy** and read its **Logs**
tab. Restarting Home Assistant Core alone does not restart the ST-MQ app.

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
restores any temporary equipment settings owned by the instance. Avoid `kill -9`.
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
