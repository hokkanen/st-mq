# Set up and update a Linux standby

Use these tools on Linux with systemd. They install a separate runtime from the
source checkout, manage its service, and preserve external configuration,
databases and pairing state. They do not install operating-system packages,
commission a pair, promote a slave, update HA, or migrate a database.

See [paired deployment](paired-deployment.md) for the two-computer sequence, or
[standalone startup](startup.md) for development without an installed service.

## Prepare the installation

Install Git, npm and Node.js 22.19 or newer. Find a stable, absolute Node executable
with `command -v node`. npm must be on the operator's PATH. Builds use the
configured Node directory first on PATH and install locked dependencies. Run the
tools as your ordinary deployment user, not as root.

Keep the source checkout and runtime separate. For example:

| Location | Purpose |
| --- | --- |
| `~/st-mq` | Source checkout; commit intended changes here |
| `~/.local/share/home-energy-runtime` | Managed code and frontend releases |
| `~/.config/st-mq` | Private application and deployment configuration |
| `~/.local/share/st-mq` | Application data, databases and pairing state |

These are examples. **When replacing a runner, reuse its actual data, database
and pairing paths.** New empty paths create a different installation; they do not
restore the old computer's role. Preserve verified backups and private configuration.

Stop and disable the previous application service or runner before starting its
replacement. Do not run two applications against the same state. Keep the
[restricted VIP helper](pairing.md#mqtt-address-management) installed when required;
it is a separate root-owned network service, not the application runner.
When installing that helper for an ordinary user account, adapt its socket's
`SocketGroup` to a group that account belongs to. The pairing guide's example
assumes an existing `stmq` account/group. Keep the helper code, policy and units
root-owned; the application itself does not receive network administration rights.

Create a private directory:

```sh
install -d -m 0700 "$HOME/.config/st-mq"
```

Use your editor to create the files below, with mode `0600`. Secrets stay outside
the checkout and managed runtime.

### Application environment

Create `linux-runtime.env`, substituting your actual absolute paths:

```ini
STMQ_CONFIG=/home/you/.config/st-mq/secrets.json
STMQ_DATA_DIR=/home/you/.local/share/st-mq
STMQ_DATABASE_DIR=/home/you/.local/share/st-mq
STMQ_PAIR_DIR=/home/you/.local/share/st-mq/pairing
STMQ_TOPOLOGY=pair
STMQ_INPUT=providers
STMQ_PORT=1234
```

`secrets.json` must already contain the current installation configuration,
including [pair settings](pairing.md). The environment supplies process settings;
it does not replace application options. Retain other required supported `STMQ_`
settings from your installation. Do not specify an add-on flag or role override:
saved pair state owns the role.

If native helpers need executables outside the system PATH, configure their
supported absolute paths or include the required PATH in this environment file.
The service does not inherit an interactive shell's startup scripts.

Use one `KEY=value` assignment per line. Single quotes allow literal spaces or
special characters: `STMQ_DATA_DIR='/home/you/House data'`. Blank lines and lines
starting with `#` are allowed. Shell commands, variable expansion, double quotes,
escapes, duplicate keys, inline comments and multiline values are unsupported.
This common subset is read consistently by the validator and systemd's
`EnvironmentFile`; it is never sourced by a shell.

### Deployment connection

Create `linux-deploy.json`:

```json
{
  "runtime_dir": "/home/you/.local/share/home-energy-runtime",
  "service_scope": "user",
  "service_name": "home-energy.service",
  "node_path": "/usr/local/bin/node",
  "environment_file": "/home/you/.config/st-mq/linux-runtime.env",
  "status_url": "http://127.0.0.1:1234",
  "token_file": "/home/you/.config/st-mq/linux-status-token"
}
```

`status_url` is the local loopback HTTP origin, using the recovery listener port
(`STMQ_PORT`). Do not use ingress, a VIP, a remote address or an API path. The
script sends only authenticated read requests to `/api/pair`.

If web authentication is configured, privately create `linux-status-token`
containing the same admin web token. Never put it in a command argument. Omit
`token_file` only when the loopback API accepts unauthenticated local access.
The token file's parent also requires mode `0700`.

Paths must be normalized and absolute. Deployment path names support letters,
numbers, spaces, `/`, `_`, `.` and `-`. Unknown fields fail validation.
`sync_timeout_seconds` is optional, defaults to 900, and accepts 1–86400.

For a **system** service, use `"service_scope": "system"` and add
`"service_user": "your-linux-user"`. Run setup/deployment as that same non-root
account so private inputs retain their mode `0600` ownership. It must be able to
write the runtime and run the required `sudo -n install` and `sudo -n systemctl`.
The tools do not prompt for passwords or change sudo policy. A user service avoids those privileges;
a system service can start independently of a login. The root-owned VIP helper
still has its own installation.

## Set up the service once

From a clean, committed source checkout:

```sh
cd /path/to/st-mq
npm run setup:linux
```

This previews the generated service without installing or building. Review it,
then apply:

```sh
npm run setup:linux -- --apply
```

The default connection is `$XDG_CONFIG_HOME/st-mq/linux-deploy.json`, falling back
to `~/.config/st-mq/linux-deploy.json`. Select another file with
`--connection /private/path/linux-deploy.json`.

Setup requires an absent or empty runtime directory and an unused service name.
It validates current application configuration without starting the application
or opening a database, builds the selected commit, installs the persistent
service, and verifies it is stopped. It does **not** enable startup or control.

Confirm the old runner is stopped, preserved pair state belongs to this computer,
and HA is still master. Then explicitly start the service:

```sh
systemctl --user start home-energy.service
systemctl --user is-active home-energy.service
```

Open **Paired computers**. Confirm this computer remains **Slave**, its peer is
**Master**, and synchronization becomes ready. A running process alone does not
prove startup or synchronization succeeded. Inspect local logs if needed:

```sh
journalctl --user -u home-energy.service -n 50
```

Do not paste private logs into public issues. Optionally enable the verified
service for future starts:

```sh
systemctl --user enable home-energy.service
```

For system scope, use `sudo systemctl` and `sudo journalctl` without `--user`.
User startup without a login additionally requires your administrator's normal
lingering policy; setup does not change it.

## Deploy a later commit

With HA master and this computer running as a synchronized slave:

```sh
cd /path/to/st-mq
npm run deploy:linux
```

The command requires a clean, committed source and an unchanged managed runtime.
It accepts unpublished local commits. It checks the persistent service, fresh pair
identity, master reachability, slave role and absence of control authority before
preparation, and again immediately before stopping. Do not hand over or promote
concurrently.

Preparation clones the exact commit into `runtime_dir/releases`, installs locked
dependencies and builds while the old slave remains available. The service must
confirm a complete stop before `current` changes to the new release. The script
verifies the installed source/build, restarts the same service and waits for the
same slave, the same master and successful synchronization. Old releases remain.
The status listener must belong to the service's actual Node process, checked
through Linux `/proc`; another process answering the same URL cannot qualify it.

Commands are bounded; dependency installation and build each have a 15-minute
deadline. Synchronization has its configured deadline. Success reports the exact
revision and synchronized slave status. It does not prove physical equipment
behavior or permit a handover the application refuses. Incompatible development
databases and journals are not converted.

The source comes from the script's location, independently of the terminal's
directory. For example:

```sh
node /path/to/st-mq/scripts/deploy-linux.js --connection /private/path/linux-deploy.json
```

### Deploy an already stopped service

For offline maintenance of a managed runtime, stop its service explicitly first:

```sh
npm run deploy:linux -- --stopped
```

This mode requires a confirmed inactive service with no main process, rechecks
that state before switching releases, and leaves it stopped. It sends no stop,
start or pair-status requests. The source/build and installation checks remain;
runtime startup and synchronization are not verified. It does not install an
unmanaged standalone runtime or infer authority from saved state. Review roles
and compatibility before any later explicit start. HA supports the same flag.

## Failure and recovery

A preparation failure leaves the previous release selected and preserves the
service's initial running or stopped state. In managed mode, a failure after Stop
can leave it stopped; a synchronization failure after restart can leave it running.
The error identifies the phase, any release switch and the last lifecycle request
or confirmation. Inspect systemd and **Paired computers** before continuing.

The tool never automatically rolls back, changes roles, clears pairing, replaces
configuration, deletes history or retries uncertain service commands. Rolling
code back after starting a new runtime requires an explicit compatibility
decision; retained code is not a database rollback.

An empty `runtime_dir/deployment.lock` prevents overlapping operations. Failures
retain it and prepared releases. Confirm the previous command and its children
have finished before removing that empty lock with `rmdir` and retrying.
Failed initial setup may leave a partial runtime or service. Inspect and archive
those artifacts before repeating setup into an empty location; setup does not
erase them. Never delete application data to fix deployment.

Changing the environment or service requires explicit installation maintenance;
deployment refuses a mismatched service instead of rewriting it. Old code releases
are not automatically removed. Remove an inactive release only after checking
`current` and running process references.

## Offline validation

```sh
node --test test/linux-deployment.test.js
```

Tests use disposable repositories, real Git/npm preparation, synthetic pair
status and simulated systemd operations. They cover both scopes, role changes,
authentication, failures and timeouts without operating household services.

On a Linux test machine with an available user systemd manager, also run:

```sh
STMQ_REQUIRE_SYSTEMD_TESTS=1 node --test test/extended/linux-deployment-systemd.test.js
```

This explicitly creates a disposable synthetic user service under `/run/user`,
verifies its syntax with `systemd-analyze`, and exercises managed and stopped
deployment, including paths containing spaces. It stops and removes that service
afterward. It never loads installation credentials or starts the household app.
