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
| `~/.local/share/st-mq-runtime` | Managed code and frontend releases |
| `~/.config/st-mq` | Private application and deployment configuration |
| `~/.local/share/st-mq` | Application data, databases and pairing state |

Choose persistent configuration, database and pairing paths for the installation.
Keep them unchanged across deployments and retain verified backups. Run only one
application instance against each set of writable state directories.

Pair mode requires the [restricted VIP helper](pairing.md#mqtt-address-management).
Install it separately using the application account's group. Its code, policy and
units remain root-owned; the application itself receives no network administration
rights.

Create a private directory:

```sh
install -d -m 0700 "${XDG_CONFIG_HOME:-$HOME/.config}/st-mq"
```

The commands below create the deployment files with mode `0600`. Review them in
an editor before setup. Secrets stay outside the checkout and managed runtime.

### Application environment

Create `linux-runtime.env` with resolved paths for the current account. The
unquoted heredoc resolves the account's paths when creating the file; systemd
later reads literal absolute paths. This command refuses to overwrite an existing file:

```sh
(
  umask 077
  set -C
  cat > "${XDG_CONFIG_HOME:-$HOME/.config}/st-mq/linux-runtime.env" <<EOF
STMQ_CONFIG='${XDG_CONFIG_HOME:-$HOME/.config}/st-mq/secrets.json'
STMQ_DATA_DIR='$HOME/.local/share/st-mq'
STMQ_DATABASE_DIR='$HOME/.local/share/st-mq'
STMQ_PAIR_DIR='$HOME/.local/share/st-mq/pairing'
STMQ_TOPOLOGY=pair
STMQ_INPUT=providers
STMQ_PORT=1234
EOF
)
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
special characters. The generated path assignments above use single quotes so
spaces in the account's home directory work. Blank lines and lines
starting with `#` are allowed. Shell commands, variable expansion, double quotes,
escapes, duplicate keys, inline comments and multiline values are unsupported.
This common subset is read consistently by the validator and systemd's
`EnvironmentFile`; it is never sourced by a shell.

### Deployment connection

Generate `linux-deploy.json` from the current account's home directory and Node
executable. This command also refuses to overwrite an existing file:

```sh
node --input-type=module <<'JS'
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const home = homedir();
const directory = join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'st-mq');
const connection = {
  runtime_dir: join(home, '.local/share/st-mq-runtime'),
  service_scope: 'user',
  service_name: 'st-mq.service',
  node_path: process.execPath,
  environment_file: join(directory, 'linux-runtime.env'),
  status_url: 'http://127.0.0.1:1234',
  token_file: join(directory, 'linux-status-token'),
};
writeFileSync(join(directory, 'linux-deploy.json'),
  JSON.stringify(connection, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
JS
```

The generated JSON contains actual absolute paths. Neither JSON nor the runtime
environment file expands shell variables when read. Keep the configured Node
executable available across updates; review the generated path if using a Node
version manager.

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

For a **system** service, run this before initial setup to select system scope
and resolve the service account automatically from `$USER`:

```sh
node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

const user = process.env.USER;
if (!user || user === 'root' || user !== userInfo().username)
  throw new Error('Run this as the intended non-root deployment user.');
const path = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'st-mq/linux-deploy.json');
const connection = JSON.parse(readFileSync(path, 'utf8'));
connection.service_scope = 'system';
connection.service_user = user;
writeFileSync(path, JSON.stringify(connection, null, 2) + '\n', { mode: 0o600 });
JS
```

Run setup/deployment as that same non-root account so private inputs retain their
mode `0600` ownership. It must be able to
write the runtime and run the required `sudo -n install` and `sudo -n systemctl`.
The tools do not prompt for passwords or change sudo policy. A user service avoids those privileges;
a system service can start independently of a login. The root-owned VIP helper
still has its own installation.

## Set up the service once

From a clean, committed source checkout:

```sh
cd "$HOME/st-mq"
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

Start the configured service explicitly:

```sh
systemctl --user start st-mq.service
systemctl --user is-active st-mq.service
```

For a new pair, complete [initial role selection](pairing.md#configuration) on
both computers. For an established pair, verify its saved roles under **Paired
computers**. Before using managed deployment, this computer must be **Slave**,
its peer must be **Master**, and synchronization must be ready. A running process
alone does not establish readiness. Inspect local logs if needed:

```sh
journalctl --user -u st-mq.service -n 50
```

Do not paste private logs into public issues. Optionally enable the verified
service for future starts:

```sh
systemctl --user enable st-mq.service
```

For system scope, use `sudo systemctl` and `sudo journalctl` without `--user`.
User startup without a login additionally requires your administrator's normal
lingering policy; setup does not change it.

## Deploy a later commit

With HA master and this computer running as a synchronized slave:

```sh
cd "$HOME/st-mq"
npm run deploy:linux
```

The command requires a clean, committed source and an unchanged managed runtime.
It accepts unpublished local commits. It checks the persistent service, fresh pair
identity, master reachability, slave role and absence of control authority before
preparation, and again immediately before stopping. Do not hand over or promote
concurrently.

Preparation clones the exact commit into `runtime_dir/releases`, installs locked
dependencies and builds while the installed slave remains available. The service must
confirm a complete stop before `current` changes to the new release. The script
verifies the installed source/build, restarts the same service and waits for the
same slave, the same master and successful synchronization. Prepared releases remain.
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
node "$HOME/st-mq/scripts/deploy-linux.js" --connection "${XDG_CONFIG_HOME:-$HOME/.config}/st-mq/linux-deploy.json"
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
deployment refuses a mismatched service instead of rewriting it. Inactive releases
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
