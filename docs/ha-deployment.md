# Deploy a development commit to Home Assistant

For a pair, follow the [Linux–HA deployment sequence](paired-deployment.md) so the
standby is verified before control moves. Both [Linux deployment](linux-deployment.md)
and HA deployment use the same two modes:

| Command | Required state | Result |
| --- | --- | --- |
| `npm run deploy:ha` | Running, synchronized paired slave | Verify, stop, deploy, restart and wait for synchronization |
| `npm run deploy:ha -- --stopped` | Already stopped app | Deploy and leave stopped; no stop/start or pair-status requests |

The command deploys this checkout's **committed HEAD**, including unpublished
local commits, over SSH to Advanced SSH & Web Terminal. It does not push Git,
publish a release, change pair roles, replace saved settings or reset databases.
Supervisor's schema and shared defaults are refreshed to the deployed commit.

## One-time setup

Install the checkout's dependencies with `npm ci`. Ubuntu needs the OpenSSH
client. Home Assistant must already have the `st-mq` app installed from its Git
repository and Advanced SSH & Web Terminal running with SSH access configured.
Reuse the SSH key and trusted host entry that already work from Ubuntu. The
script uses noninteractive authentication and strict host-key verification; it
never accepts a new or changed host key automatically.

The SSH app needs access to Docker (normally requiring that app's protection mode
to be disabled), Bash, Python 3, `sh`, `cat` and `sha256sum`. The Supervisor
container must have Git and Python 3. The script does not change permissions or
SSH settings. SFTP and an interactive terminal are not required.

Keep host, user, port and identity settings in your existing OpenSSH configuration
when using an alias. For example, an already configured alias can be verified
with `ssh -T home-assistant 'true'`. `ssh_host` also accepts a destination such as
`root@home-assistant.example.invalid`; use an SSH config alias for custom ports.

The [Linux setup wizard](linux-deployment.md) saves the default private HA
deployment connection when SSH setup is selected. For separate HA deployment,
create `${XDG_CONFIG_HOME:-$HOME/.config}/st-mq/ha-deploy.json`:

```json
{
  "ssh_host": "home-assistant"
}
```

Use your actual SSH alias or destination. The connection file requires mode
`0600`, with its parent directory mode `0700`. SSH retains ownership of keys,
agent use and host verification. No Home Assistant long-lived access token is
needed. Supervisor requests run through SSH in a login shell, using the SSH
app's local `SUPERVISOR_TOKEN`; that credential is never downloaded to Ubuntu.
This environment requirement is documented by the
[SSH app](https://github.com/hassio-addons/addon-ssh/blob/main/ssh/DOCS.md#running-the-ha-command-or-supervisor-api-non-interactively).

Deployment reads that default connection automatically:

```sh
npm run deploy:ha
```

If more than one matching app is installed, add `app_slug` with its exact slug
from HA. The optional `sync_timeout_seconds` defaults to 900 and accepts integers
from 1 to 86400, matching Linux. Only these three connection fields are accepted;
unknown fields are rejected.

## Each paired deployment

1. Commit the intended changes and leave the checkout clean. Use `npm ci` after
   dependency changes. Both source trees must be clean, and HA's source commit
   must be an ancestor of the selected local HEAD.
2. Confirm HA is the running synchronized **Slave** and the other computer is
   **Master**. Use explicit dashboard handover first if HA is master. The default
   command refuses a stopped app, a master, unavailable authority, protected
   recovery, or a role transition.
3. Run `npm run deploy:ha`, optionally selecting `--connection`. The installed
   app version must match `config.json`; use Supervisor's ordinary update flow
   first when they differ. Local frontend preparation happens while HA runs.
4. The script rechecks the same slave and master immediately before requesting
   Stop. Supervisor and Docker must confirm the app has stopped before stored-file
   snapshots or source changes begin. Do not initiate handover, change settings,
   edit source, or refresh app repositories during deployment.
5. Wait for transfer, rebuild and verification. Files stream as binary stdin and
   are checked by SHA-256. Snapshot and final stored-file comparison each allow
   15 minutes and report progress every 30 seconds. They inspect entry metadata,
   never database or backup contents; work scales with file count, not stored bytes.
6. Only after image and preservation checks pass does the script request Start.
   It verifies the running image digest and the app's own HTTP listener, then
   waits for the same HA node to remain slave, without control authority, and
   synchronize with the same master. Fresh peer clocks are assessed on the
   originating computer; the local synchronization deadline defaults to 15 minutes.

The status probe runs inside the selected app container. It uses the current
application configuration to authenticate locally; web tokens remain inside that
container. Container identity, image identity and listener ownership must agree.
Lifecycle requests use the documented [Supervisor app API](https://contributors.home-assistant.io/apps/supervisor-api/apps/).

### Deploy an already stopped app

For standalone HA, configuration recovery, or offline maintenance:

```sh
npm run deploy:ha -- --stopped
```

Stop the app explicitly first. This mode verifies a stopped container and leaves
it stopped; it does not infer a saved role or start a potentially controlling
application. Source/image and preservation checks remain enabled. Start it
manually only after reviewing its configuration, compatibility and authority.
A successful stopped deployment does not verify runtime startup or synchronization.
Both modes retain current database/algorithm compatibility gates and do not prove
physical equipment behavior.

The command verifies the transferred Git bundle, performs a fast-forward source
update, refreshes Supervisor's local app metadata and asks Supervisor to rebuild
the installed image. Metadata refresh re-applies the unchanged repository list
through the currently supported Supervisor v1 `/supervisor/options` endpoint.
If that operation is unavailable, deployment fails closed; there is no fallback
to the Git-fetching `/store/reload` endpoint. The selected source revision is
checked throughout the operation. Supervisor's installed raw schema and shared
defaults, plus the schema exposed by `/addons/<slug>/info`, must match the
committed `config.json` after rebuilding. Missing or mismatched metadata blocks
successful verification.

It compares all runtime `src` files, package/manifest files and frontend assets
with the local commit/build in an isolated, networkless container without
household mounts. It checks app identity, state, version and a private digest of
Supervisor's raw saved user record and settings around the update and rebuild.
Saved settings must remain unchanged, including credentials, secret references
and fields retired by the new schema. Effective options must remain available as
an object, but are not compared for equality before and after: adding or changing
an unoverridden default can legitimately change them. Saved-object comparisons
ignore object-key order while preserving values, types and array order. The
command also compares entry names and types, regular-file sizes and nanosecond
modification times, and symbolic-link targets under the app's Supervisor
data/configuration directories across the stopped update window. It does not follow links or
read stored-file contents. This detects metadata changes, not byte-for-byte
preservation: same-size changes with unchanged modification times are not
detected. Supervisor saved settings, source and image contents retain their
full comparisons. Runtime writes before Stop and after Start are outside the stored-file
comparison. A successful run reports the exact commit and either verified slave
synchronization or the explicitly requested stopped state.

The operation touches the HA repository cache directly. A later Supervisor
repository refresh can replace that cache with the published branch; this is a
development deployment, not release publication.

An independent Supervisor repository refresh can also run during deployment.
Supervisor 2026.09.3 schedules store refresh every three hours; its Git update
can reset a locally ahead branch to `origin/<branch>`. The deployment lock
coordinates this tool's runs, not Supervisor's repository tasks. A source check
before rebuilding therefore cannot exclude a later change: exact source and
image verification must still succeed while the app remains stopped. The
unchanged-repository-list metadata request itself does not fetch Git. See the
version-pinned [scheduled task](https://github.com/home-assistant/supervisor/blob/2026.09.3/supervisor/misc/tasks.py)
and [Git update](https://github.com/home-assistant/supervisor/blob/2026.09.3/supervisor/store/git.py).

## Configuration changes after deployment

Deployment preserves installation settings even if the new application no longer
accepts them. It never deletes retired fields, translates old settings or imports
Ubuntu's private file automatically. New defaults apply where no saved override
exists; saved values remain explicit overrides, even when they equal an earlier
default. Credentials normally need no further transfer.

When saved settings are incompatible, start the app explicitly and open its
configuration-recovery page through **Open Web UI**. Correct the saved options in
Home Assistant, or upload a current `secrets.json` and choose **Replace saved
settings from the uploaded file**. Replacement must include every installation
setting and credential you want to retain. Select **Check & review configuration**,
then **Save reviewed configuration**. Replacement privately backs up the previous
settings before saving; omitted settings return to current defaults. Restart
explicitly after correction. A normal merge import cannot remove omitted retired
fields. See [configuration recovery](configuration.md#configuration-recovery).
If Supervisor refuses to start the container because required settings are
missing or values are malformed, correct those settings in Home Assistant's
Configuration editor first. The app's recovery page is available only after the
container can start; unknown removed fields normally allow that recovery startup.

## If a deployment fails or is interrupted

An **app preflight** refusal makes no remote changes and submits no lifecycle
command or rebuild. Check the selected mode and current role. A running master
requires explicit handover; an already stopped app requires `--stopped` or an
explicit, separately reviewed initial start before using the managed default.
Unknown or unrecognized states block deployment.

Stopped-state checks require a fresh Docker listing showing the selected container
absent or `exited`, including when Supervisor reports `error`. Both supported
container names (`app_` and `addon_`) are checked. Ambiguous containers, failed reads
and running containers fail closed; no status reset is attempted.

Preparation failure leaves a managed slave running. After a confirmed Stop,
verification failure leaves it stopped. After Start, synchronization failure can
leave it running and must be inspected before handover. Messages distinguish Stop
or Start requested with an unconfirmed outcome from an acknowledged operation.
Lost lifecycle replies are never replayed. Neither mode automatically rolls back,
resets storage, promotes a peer or retries a possibly running rebuild.
Inspect Supervisor's app state and logs locally before retrying.
Remote source may already have advanced while the image still contains the
previous build. A lost response does not prove that a rebuild failed.
If Supervisor acknowledged rebuild completion but source verification then
reports a different commit, keep the app stopped and inspect the known source,
Supervisor jobs/logs and retained deployment evidence. A completed rebuild and
an unknown rebuild outcome are different retry boundaries. An empty jobs view
does not rule out a later scheduled repository refresh. Once the original
deployment and interfering task have finished, inspect the empty owned lock as
described below and begin a fresh checked deployment; retain the failed evidence.
SSH timeouts, connection failures and oversized output stop further commands;
no uncertain operation is automatically replayed. Each logical command uses
noninteractive SSH without an inherited multiplexed session. This avoids browser
terminal state and does not attach to an unrelated SSH session.

A directory named `/tmp/st-mq-deploy-<app-slug>.lock` in the SSH app prevents
overlapping runs. HA setup and deployment share this lock and report its exact
path and SSH-app location when acquisition, cleanup or confirmation fails.
Uncertain deployment errors also name any possibly retained workspace. A
creation failure is not reported as proof that a previous lock exists.
After confirming that the previous deployment process and
Supervisor rebuild have finished, remove that empty directory with `rmdir`
before retrying. Never remove it while a deployment is running.

Deployment-owned temporary files under `/tmp/st-mq-deploy-*` are retained
on failure for inspection; successful runs remove their own files and lock.
A retry starts a fresh transfer. Neither retry nor lock removal erases app data.
Errors identify existing locks, command failure, transport failure and the failed
phase. App verification names the changed checks (state, slug, repository,
version or configuration) without printing private identifiers or option values.
Failure messages distinguish an initial refusal from possible remote changes,
and warn about a possibly running rebuild only when this run submitted one
without receiving successful completion. Later failures identify the specific
verification step and report that Supervisor already confirmed the rebuild.
Raw SSH, command and Supervisor error output remains hidden because it
may contain private configuration.

Offline transport, boundary and deployment workflow tests run with:

```sh
node --test test/ha-deployment.test.js test/ha-deploy-ssh.test.js test/ha-deploy-state.test.js test/ha-deploy-workflow.test.js test/ha-deploy-runtime.test.js test/paired-deployment.test.js
```
