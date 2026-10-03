# Deploy a development commit to Home Assistant

Run this from your Linux checkout:

```sh
npm run deploy:ha
```

The command deploys the checkout's **committed HEAD**, including commits that have
not been pushed. It uses Home Assistant's authenticated WebSocket API and the
Advanced SSH & Web Terminal app's terminal WebSocket. It leaves Home Energy
**stopped**. It does not publish a release, push Git, start equipment control,
change configuration or reset databases.

## One-time setup

Install the checkout's dependencies with `npm ci`. Home Assistant must already
have Home Energy installed from its Git repository and Advanced SSH & Web Terminal
running with ingress enabled. The terminal needs access to Docker (normally
requiring that terminal app's protection mode to be disabled), Python 3, `sh`,
`base64` and `sha256sum`. The Supervisor container must have Git and Python 3.
The script checks the available paths; it does not change terminal permissions.

Create a Home Assistant long-lived access token for an administrator from the
Home Assistant profile. Store it in a private token file outside the checkout;
never put the token in a shell command, Git or the connection JSON itself.
For example, use a text editor for these two files:

```sh
install -d -m 700 ~/.config/st-mq/ha-deployment
install -m 600 /dev/null ~/.config/st-mq/ha-deployment/token
install -m 600 /dev/null ~/.config/st-mq/ha-deployment/connection.json
```

Run those creation commands only for new files: `install` replaces existing
contents. Put just the token in `token`. In `connection.json`, use your actual HA
origin and an absolute token-file path, for example:

```json
{
  "url": "http://home-assistant.example.invalid:8123",
  "token_path": "/home/example/.config/st-mq/ha-deployment/token"
}
```

Connection and token files require private parent directories (mode `0700`) and
private file permissions (`0600`). The script reads the default connection from
`$XDG_CONFIG_HOME/st-mq/ha-deploy.json`, or `~/.config/st-mq/ha-deploy.json` when that
environment variable is unset. To use the example location above:

```sh
npm run deploy:ha -- --connection "$HOME/.config/st-mq/ha-deployment/connection.json"
```

When more than one matching app is installed, add `app_slug` and/or
`terminal_slug` to the connection JSON. Copy the exact slugs from HA; the script
refuses ambiguous selection. No other connection fields are accepted.

## Each deployment

1. Commit your intended changes and leave the checkout clean. The command builds
   the frontend locally using the installed dependencies; use `npm ci` after
   dependency changes.
2. Stop Home Energy in HA. The script refuses a running app and never stops or
   starts it automatically.
3. Run the command. The installed version number must match `config.json`; use
   Supervisor's ordinary installation/update flow first when versions differ.
4. Wait for transfer, Supervisor rebuild and verification to finish. Transfer uses
   small terminal messages and can take several minutes. Both local and HA source
   trees must be clean, and HA's source commit must be an ancestor of local HEAD.
5. Start the app yourself in HA when ready. Deployment verification does not
   qualify runtime startup, database compatibility, pairing authority or physical
   equipment behavior. Incompatible development databases remain rejected and
   require a separate deliberate fresh-start decision.

The command verifies the transferred Git bundle, performs a fast-forward source
update, and asks Supervisor to rebuild the installed image. It compares all
runtime `src` files, package/manifest files and frontend assets with the local
commit/build in an isolated, networkless container without household mounts.
It checks saved Supervisor options and fingerprints regular files and symbolic
links under the app's Supervisor data/configuration directories before and after.
Targets outside those directories are not included in the file comparison.
A successful run reports the exact commit and confirms that the app is stopped.

The operation touches the HA repository cache directly. A later Supervisor
repository refresh can replace that cache with the published branch; this is a
development deployment, not release publication.

## If a deployment fails or is interrupted

The script does not automatically roll back, restart, reset storage or retry a
possibly running rebuild. Inspect Supervisor's app status and logs locally first.
Remote source may already have advanced while the image still contains the
previous build. A lost response does not prove that a rebuild failed.

A directory named `/tmp/home-energy-deploy-<app-slug>.lock` in the terminal app
prevents overlapping runs of this script. After confirming that the previous
process and Supervisor rebuild have finished, remove that empty lock directory
with `rmdir` before retrying. Do not remove a lock while a deployment is running.
Deployment-owned temporary files under `/tmp/home-energy-deploy-*` are retained
on failure for inspection; successful runs remove their own files and lock.
Neither retry nor lock removal erases app data. Failures deliberately suppress raw
terminal/network output because it may contain private configuration.

Offline transport and boundary tests run with:

```sh
node --test test/ha-deployment.test.js
```
