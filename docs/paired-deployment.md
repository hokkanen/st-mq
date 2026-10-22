# Deploy to a Linux–Home Assistant pair

Use one clean, committed source checkout for both computers. The tools deploy its
committed HEAD, including unpublished local commits, without pushing Git or
publishing a release.

For initial commissioning, follow [pair setup](pairing.md). Install the Linux
runtime with [Linux setup](linux-deployment.md), and configure SSH using
[HA deployment](ha-deployment.md). Replacing a runner must retain its private
configuration, databases and saved pairing state.

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

If Linux was just set up stopped, explicitly start it and verify synchronization
as described in [Linux setup](linux-deployment.md#set-up-the-service-once) first.
Setup already installs the selected commit; deploying it again is optional.

## Hand over, then update HA

1. In the master's **Paired computers**, choose **Hand over to the other computer**,
   review the confirmation and complete it. Wait for **Linux Master** and
   **HA Slave**. An accepted request is not a completed handover. Existing
   readiness checks must succeed; the tools do not override them.
2. Stop **Home Energy** under **Settings → Apps** in HA. Stop the app itself,
   not Home Assistant Core or the SSH app.
3. From the same clean source checkout:

   ```sh
   npm run deploy:ha
   ```

   For a non-default connection file:

   ```sh
   npm run deploy:ha -- --connection /private/path/ha-deploy.json
   ```

   The installed HA app version must match `config.json`; use Supervisor's normal
   installation/update flow first if they differ. The command transfers the
   commit, rebuilds and verifies the image, preserves saved options and leaves HA
   **stopped**. It does not reset databases.
4. Start Home Energy manually in HA. Confirm it returns as a slave and synchronizes.
   Follow failure instructions before handing over if either deployment fails.

## Restore roles and verify

From the Linux master, explicitly hand over to HA and wait for completion.
Confirm HA is master, Linux is slave, synchronization is ready, and there are no
authority or recovery errors. Verify the changed UI or behavior normally. Builds
and transfers alone do not establish runtime readiness or physical behavior.

Neither script promotes or hands over. If Linux was the original master, first
use ordinary handover to make it a synchronized slave, then follow this sequence
and restore your chosen final roles explicitly.
