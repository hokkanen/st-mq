# Startup and an occupied web port

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

Do not work around a duplicate live controller by changing only its port. Home
Assistant's separate ingress listener uses `STMQ_INGRESS_PORT` (default `8099`);
an ingress bind conflict names that setting in the error.

The Node.js experimental SQLite warning is informational and is unrelated to
`EADDRINUSE`. The port conflict is the startup failure to resolve.
