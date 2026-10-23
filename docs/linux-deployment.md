# Install and deploy st-mq on Linux

The interactive installer supports standalone operation and a Linux–Home
Assistant pair. It installs a runtime separate from the source checkout,
prepares private configuration, installs the required services and starts the
application. Later deployments preserve configuration, databases and saved
pairing state.

## Install

On systemd-based Ubuntu 22.04 or newer, on amd64 or arm64, open a terminal in
the clean, committed checkout and run:

```sh
bash scripts/setup-linux.sh
```

Run as the ordinary account that will own the application, with sudo access.
The installer requests sudo authentication through sudo itself. An internet
connection is needed for missing packages, Node and locked npm dependencies.
Setup reuses a suitable trusted Node installation or installs a checksum-verified
official runtime under `/opt/st-mq`. Node and npm do not need to be installed
before running the shell command.
If Node is missing, this bootstrap prerequisite is installed before the wizard;
application configuration and services change only after the wizard's review.

The wizard collects installation choices, then presents a review before applying
them:

1. Choose **standalone** or **pair** and accept the default paths or select
   custom absolute paths.
2. Supply the complete `secrets.json` using an existing file, a hidden paste,
   a file copy, a minimal starter, or an optional import from HA.
3. For a pair, select the LAN interface, fixed peer addresses and shared virtual
   IP. Optional HA SSH access allows reviewed configuration on both computers.
4. Review configuration fields, services, prerequisites and Linux/HA interruptions,
   then confirm installation and startup.

The application runs as the invoking non-root account. New installations use a
system service enabled at boot; an existing current installation retains its
service scope. Setup handles the root-owned VIP helper, restricted socket and
policy for pair mode. Standalone operation needs no VIP helper.

### Supply configuration as one file

Choose **Paste JSON** to paste a complete file from a password manager. Terminal
input is hidden. Finish with a line containing only:

```text
END
```

Setup never asks for individual provider passwords, device credentials or API
keys. **Copy a file** imports an owned private file; use file mode `0600` and
directory mode `0700`. Invalid JSON or configuration opens a correction workflow:
edit the private draft, paste a complete replacement, or edit it externally and
continue. `$VISUAL` or `$EDITOR` selects the editor, with `nano` as the fallback.
Errors do not print credential values.

The smallest standalone starter is:

```json
{}
```

It uses public defaults, simulated input and paused Home heating. A paired
starter includes the live-input and local-MQTT sections; the wizard supplies the
reviewed network and pairing fields. Add the installation's provider and device
settings in the same file. Setup validates the complete current configuration
before startup; it does not commission equipment or enable control permissions.

Public defaults remain in `config.json.options`. The private file contains
installation overrides. Setup preserves unrelated settings and privately backs
up existing files before saving reviewed changes. Save the resulting
`secrets.json` back to the password manager after adding generated pairing or
broker credentials. See the [configuration guide](configuration.md).

### Default locations

Setup resolves the account and home directory automatically. These are the
defaults; no username substitutions or manual deployment files are needed:

| Location | Purpose |
| --- | --- |
| `$HOME/st-mq` | Typical source checkout; the script uses its own checkout location |
| `$HOME/.local/share/st-mq-runtime` | Managed runtime releases and `current` link |
| `${XDG_CONFIG_HOME:-$HOME/.config}/st-mq/secrets.json` | Private application overrides |
| `${XDG_CONFIG_HOME:-$HOME/.config}/st-mq/linux-runtime.env` | Generated process environment |
| `${XDG_CONFIG_HOME:-$HOME/.config}/st-mq/linux-deploy.json` | Generated deployment connection |
| `$HOME/.local/share/st-mq` | Data, databases and pairing state |
| `/etc/systemd/system/st-mq.service` | Default system service, running as `$USER` |

Generated files contain resolved absolute paths. JSON and systemd environment
files do not expand `$HOME` or `$USER` when read. Configuration and state stay
outside both the checkout and runtime. Run only one application against each set
of writable state directories.

With a supported Node runtime already available, `npm run setup:linux` starts
the same wizard. For a review without applying installation changes, use:

```sh
bash scripts/setup-linux.sh --dry-run
```

An alternate installation connection can be selected with
`--connection /private/path/linux-deploy.json`. Re-running setup reads the current
installation and preserves its data and saved authority. It normally stops,
rebuilds and restarts an existing managed service after the interruption is
reviewed. Existing history directories are retained in place.

## Set up a Linux–HA pair

Install HA and its matching `st-mq` app through the normal
[HA installation flow](../DOCS.md) first. For automatic HA configuration, make
Advanced SSH & Web Terminal available using the existing SSH key and trusted
host entry described in [HA deployment](ha-deployment.md#one-time-setup).

Choose **pair** in the Linux wizard. Both computers need fixed management
addresses and local MQTT brokers. Reserve a third, unused IPv4 address on their
common LAN for the MQTT virtual IP. Devices use that virtual IP; the controllers
connect to their own local brokers. Setup can provision a missing local broker,
an inactive stock installation, or its existing managed broker using
file-supplied or generated credentials. It authenticates existing connections
without subscribing or publishing, and preserves unmanaged broker configuration.

A newly installed HA Mosquitto broker exposes its fixed host endpoint on port
`1885`; its internal endpoint remains `core-mosquitto:1883`. This leaves
`VIP:1883` available to st-mq. Existing HA broker mappings are preserved; a
mapping that occupies host port `1883` must be corrected before pairing. When
importing standard HA settings, setup derives the separate Linux `mqtt.ha`
route from HA's actual published port and fixed address. An existing explicit
Linux route is retained. Custom brokers or TLS routes require whole-file
configuration review.

When SSH is available, the wizard discovers HA interfaces, preserves existing
HA storage paths and prepares matching pair settings. Reviewed HA changes are
privately backed up, applied while the app is stopped, and followed by startup.
Machine-local paths and verification files do not transfer between computers.
The first master of a new pair is an explicit installation choice; existing
pair identities and roles are retained.

Without SSH, Linux installation still completes. A fresh pair starts as a
read-only slave; an existing installation retains its saved authority. Setup
saves a private `ha-pair-settings.json` beside the Linux configuration. Apply
those settings to HA, supplying HA's actual interface and local MQTT settings,
then complete [pair commissioning](pairing.md#configuration). The installer
reports **HA configuration pending** rather than claiming synchronization.

A paired installation is ready only when the intended master owns control and
the slave reports verified synchronization. A running service alone does not
establish readiness. Device commissioning, network/firewall policy and individual
feature permissions remain installation responsibilities. See
[pair operation](pairing.md) and [paired deployment](paired-deployment.md).

## Inspect the installed service

For the default system service:

```sh
sudo systemctl status st-mq.service
sudo journalctl -u st-mq.service -n 50
```

Use `systemctl --user` and `journalctl --user` for an existing user-scope
installation. Private logs can contain installation details; keep them out of
public issues.

Setup and deployment locate the existing account-owned bus under `/run/user/<uid>`
when both `DBUS_SESSION_BUS_ADDRESS` and `XDG_RUNTIME_DIR` are absent. They preserve
explicit session settings and do not create or start a user manager. If the bus
is unavailable, log in with an active user systemd session before retrying.
For manual `systemctl --user` commands in a terminal missing both variables, use:

```sh
XDG_RUNTIME_DIR="/run/user/$(id -u)" systemctl --user status st-mq.service
```

## Deploy a later commit

From the clean, committed source checkout:

```sh
npm run deploy:linux
```

For pair mode, this requires Linux to be a running, synchronized slave. The
command checks the service, fresh pair identity, reachable master and absence
of control authority before preparation and immediately before Stop. It refuses
a paired master; do not hand over or promote concurrently. Standalone deployment
checks the running standalone application instead.

Preparation builds the exact committed HEAD in `runtime_dir/releases` while the
installed application remains available. After a confirmed complete stop, the
command refreshes the owned pair helper only when needed, switches `current`,
verifies source and build artifacts, starts the same service and verifies runtime
readiness. Pair mode also waits for the same slave, master and successful
synchronization. Prepared releases remain available for inspection.

The status listener must belong to systemd's actual Node process, verified
through Linux `/proc`. Another process answering the configured URL cannot
qualify it. Dependency installation and build each have a 15-minute deadline.
`sync_timeout_seconds` defaults to 900 and accepts 1–86400 in the private
deployment connection.

The source comes from the script's location, independently of the terminal's
working directory. For example:

```sh
node "$HOME/st-mq/scripts/deploy-linux.js"
```

User-scope deployments skip sudo and leave the restricted VIP helper running
when its installed public code, service definitions, ownership, permissions and
loaded systemd state match the prepared release. A helper update requests sudo
authentication after preparation and before stopping the application; the helper
is verified again before publishing the release. Missing or unverifiable helper
state cannot select the skip path. Its private policy and address ownership remain
unchanged. System-scope deployments still require sudo for application lifecycle
commands, even when the helper is current. Sudo owns password entry and its
credential cache is renewed only while the reviewed privileged operation is
active. Deployment does not prompt for application credentials.

### Deploy an already stopped service

For offline maintenance of an installed managed runtime:

```sh
npm run deploy:linux -- --stopped
```

This requires a confirmed inactive service with no main process, rechecks that
state before switching releases, and leaves it stopped. It sends no application
Stop, Start or pair-status requests. Source/build and installation checks remain;
runtime startup and synchronization are not verified. HA supports the same flag.
Review compatibility and saved authority before a later explicit start.

## Failure and recovery

Setup retains its private draft when correction or installation does not finish.
Existing private files are backed up before reviewed replacements. Inspect the
reported phase and actual services before rerunning after an interrupted
installation. Do not delete application data or pairing state to fix setup.

A deployment preparation failure keeps the previous release selected and
preserves the service's initial running or stopped state. Failure after Stop can
leave the application stopped; a readiness failure after Start can leave it
running. Errors distinguish requests from confirmations. Inspect systemd and,
for a pair, **Paired computers** before continuing.

Neither operation automatically rolls back code, changes existing roles, clears
pairing, deletes history, converts incompatible databases or replays uncertain
service commands. Setup's explicit first-master selection is separate from
deployment. Retained code does not provide a database rollback.

An empty `runtime_dir/deployment.lock` prevents overlapping runtime operations.
Linux setup and deployment errors report its exact, quoted absolute path,
including ownership, cleanup and retained-lock failures. Creation and permissions
failures are distinguished from an existing lock. No lock is removed automatically
to get past a deployment refusal.
Failures retain the lock and prepared releases. Confirm the previous command
and its children have finished before removing only that empty lock with `rmdir`.
HA operations use their own retained remote lock. Inactive releases are not
automatically removed; check `current` and running process references first.

## Validation

See [development validation](development-validation.md) for setup, deployment,
container and Supervisor tests. Disposable systemd tests exercise managed and
stopped deployment without loading household configuration. Build and transfer
verification do not prove physical equipment behavior.
