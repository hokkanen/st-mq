# Deploy a development commit to Home Assistant

Run this from your Linux checkout:

```sh
npm run deploy:ha
```

The command deploys the checkout's **committed HEAD**, including commits that have
not been pushed, over SSH to the Advanced SSH & Web Terminal app. It leaves Home
Energy **stopped**. It does not publish a release, push Git, start equipment
control, change app configuration or reset databases.

## One-time setup

Install the checkout's dependencies with `npm ci`. Ubuntu needs the OpenSSH
client. Home Assistant must already have Home Energy installed from its Git
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

Create a private connection file outside the checkout, for example
`~/.config/st-mq/ha-deployment/connection.json`:

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

The default connection file is `$XDG_CONFIG_HOME/st-mq/ha-deploy.json`, or
`~/.config/st-mq/ha-deploy.json` when that environment variable is unset. To use
the example location above:

```sh
npm run deploy:ha -- --connection "$HOME/.config/st-mq/ha-deployment/connection.json"
```

If more than one matching app is installed, add `app_slug` with its exact slug
from HA. Only `ssh_host` and optional `app_slug` are accepted. The retired
`url`, `token_path` and `terminal_slug` fields are rejected; replace the connection
file explicitly. There is no web-terminal fallback or automatic conversion.
An earlier local token file is unused and is never automatically deleted.

## Each deployment

1. Commit your intended changes and leave the checkout clean. The command builds
   the frontend locally using the installed dependencies; use `npm ci` after
   dependency changes.
2. Stop Home Energy in HA. The script refuses a running app and never stops or
   starts it automatically.
3. Run the command. The installed version number must match `config.json`; use
   Supervisor's ordinary installation/update flow first when versions differ.
4. Wait for transfer, Supervisor rebuild and verification to finish. Each file
   streams as binary stdin through one SSH command and is checked by SHA-256
   before use. There are no terminal chunks, base64 encoding, screen redraws or
   per-chunk acknowledgements. The bundle transfer reports verified bytes and
   elapsed time. Supervisor's image rebuild can still take several minutes.
   Both local and HA source trees must be clean, and HA's source commit must be
   an ancestor of local HEAD.
5. Start the app yourself in HA when ready. Deployment verification does not
   qualify runtime startup, database compatibility, pairing authority or physical
   equipment behavior. Incompatible development databases remain rejected and
   require a separate deliberate fresh-start decision.

The command verifies the transferred Git bundle, performs a fast-forward source
update, and asks Supervisor to rebuild the installed image. It compares all
runtime `src` files, package/manifest files and frontend assets with the local
commit/build in an isolated, networkless container without household mounts.
It checks app identity, state, version and saved Supervisor options around the
update and rebuild, and fingerprints regular files and symbolic links under the
app's Supervisor data/configuration directories before and after. Targets outside
those directories are not included in the file comparison. A successful run
reports the exact commit and confirms that the app is stopped.

The operation touches the HA repository cache directly. A later Supervisor
repository refresh can replace that cache with the published branch; this is a
development deployment, not release publication.

## If a deployment fails or is interrupted

The script does not automatically roll back, restart, reset storage or retry a
possibly running rebuild. Inspect Supervisor's app status and logs locally first.
Remote source may already have advanced while the image still contains the
previous build. A lost response does not prove that a rebuild failed.
SSH timeouts, connection failures and oversized output stop further commands;
no uncertain operation is automatically replayed. Each logical command uses
noninteractive SSH without an inherited multiplexed session. This avoids browser
terminal state and does not attach to an unrelated SSH session.

A directory named `/tmp/home-energy-deploy-<app-slug>.lock` in the SSH app prevents
overlapping runs. After confirming that the previous deployment process and
Supervisor rebuild have finished, remove that empty directory with `rmdir`
before retrying. Never remove it while a deployment is running. A lock retained
by an interrupted web-terminal deployment has the same ownership and must also
be inspected before removal.

Deployment-owned temporary files under `/tmp/home-energy-deploy-*` are retained
on failure for inspection; successful runs remove their own files and lock.
A retry starts a fresh transfer. Neither retry nor lock removal erases app data.
Errors identify existing locks, command failure, transport failure and the failed
phase. Raw SSH, command and Supervisor error output remains hidden because it
may contain private configuration.

Offline transport, boundary and deployment workflow tests run with:

```sh
node --test test/ha-deployment.test.js test/ha-deploy-ssh.test.js test/ha-deploy-workflow.test.js
```
