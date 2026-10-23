# Deploy to a Linux–Home Assistant pair

Use one clean, committed source checkout for both computers. The tools deploy its
committed HEAD, including unpublished local commits, without pushing Git or
publishing a release.

For initial installation, install HA's matching `st-mq` app, then run
`bash scripts/setup-linux.sh` from the Linux checkout and choose **pair**.
The [Linux wizard](linux-deployment.md#set-up-a-linuxha-pair) installs the Linux
service and VIP helper, prepares pairing and optionally configures HA through
SSH. See [pair operation](pairing.md) for authority, commissioning and recovery.

## Before updating

1. Identify the actual master and slave under **Paired computers**. The sequence
   below starts and ends with HA master.
2. Save a portable backup from the active master. Verify it under **Recording
   details → Backups → Verify**, and retain a copy outside the runtime. Preserve
   each computer's private configuration and pairing state separately. Copying
   an ordinary SQLite file without accounting for WAL is not a portable backup.
3. Review the target commit's requirements. No automatic development-schema
   conversion or old algorithm interpretation is provided. If the target cannot
   synchronize and hand over safely with the installed master, stop this rolling
   sequence and use a separately agreed coordinated update. Preserve original
   databases; do not reset pairing to bypass incompatibility.
4. Confirm the intended source revision:

   ```sh
   git status --short
   git log -1 --oneline
   ```

Do not change the selected checkout, service configuration or roles during a
deployment command. Do not refresh HA's app repositories during its deployment.

## Update the Linux slave

From the source checkout on Linux:

```sh
npm run deploy:linux
```

This prepares the build, verifies Linux is a slave, stops only its application
service, installs the release, starts it and waits for synchronization. HA keeps
running as master. The command refuses a Linux master.

The setup wizard already installs the selected commit and verifies startup;
deploying it again is optional. Complete any reported pending HA configuration
or initial role selection before using the paired update sequence.

## Hand over, then update HA

1. In the master's **Paired computers**, choose **Hand over to the other computer**,
   review the confirmation and complete it. Wait for **Linux Master** and
   **HA Slave**. An accepted request is not a completed handover. Existing
   readiness checks must succeed; the tools do not override them.
   Lost responses are resolved automatically by reading the original computer's
   operation receipt. Do not submit another handover to confirm the first one.
2. From the same clean source checkout, run:

   ```sh
   npm run deploy:ha
   ```

   For a non-default connection file:

   ```sh
   npm run deploy:ha -- --connection /private/path/ha-deploy.json
   ```

   Like Linux deployment, this verifies the running slave, prepares, rechecks its
   role, stops it, deploys, restarts it and waits for synchronization. The installed
   HA version must match `config.json`; use Supervisor's normal update flow first
   if they differ. Saved options and databases are preserved.
3. Confirm HA has returned as a synchronized slave. Follow failure instructions
   before handing over if either command fails.

Both deployment commands also support `--stopped` for offline maintenance:

```sh
npm run deploy:linux -- --stopped
npm run deploy:ha -- --stopped
```

This requires an already stopped target and leaves it stopped. It sends no
application Stop/Start or pair-status requests and does not verify runtime readiness. Linux
still requires its managed runtime and persistent service; either target may be standalone.
An explicit later start requires its own role and compatibility review.

## Restore roles and verify

From the Linux master, explicitly hand over to HA and wait for completion.
Confirm HA is master, Linux is slave, synchronization is ready, and there are no
authority or recovery errors. Verify the changed UI or behavior normally. Builds
and transfers alone do not establish runtime readiness or physical behavior.

Neither script promotes or hands over. If Linux was the original master, first
use ordinary handover to make it a synchronized slave, then follow this sequence
and restore your chosen final roles explicitly.
