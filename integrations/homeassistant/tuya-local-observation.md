# Tuya Local received-observation adapter

The DESD8LW bridge requires this small, reviewed source patch alongside the
`electriq_desd8lw_dehumidifier.yaml` profile. It reuses Tuya Local's existing
connection and native controls. It opens no second device connection.

Tuya Local's normal entity values temporarily include requested settings while
commands await device feedback. Its entity update time can also advance when an
unrelated datapoint arrives. Those values and Home Assistant `last_reported`
therefore cannot establish independent confirmed measurements. Calling
`homeassistant.update_entity` does not force a poll while this integration is
running. The patch instead captures accepted device replies before pending
settings are overlaid.

Only the dedicated profile's humidifier entity gains `local_observations`:

```json
{
  "identity": "opaque SHA-256 digest",
  "1": { "value": false, "timestamp": 1800000000000 },
  "2": { "value": 55, "timestamp": 1800000000000 },
  "4": { "value": "mid", "timestamp": 1800000000000 },
  "6": { "value": 50, "timestamp": 1800000000000 }
}
```

The four keys are power, target humidity, fan speed and measured relative
humidity. Timestamps are UTC milliseconds at **native report receipt**, not the
sensor's internal sampling clock. Each field advances only when that datapoint
arrives. Partial packets preserve other fields' timestamps; full replies omit
unreported fields. Heartbeats, cached reads and requested settings never renew
measurements. Connection loss and native cache reset clear observations; a new
connection requires new reports. The identity digest comes from Tuya Local's
native `unique_id` (the configured device ID for an appliance without a child
ID). The bridge requires it to match the selected private identity.

The patch does not change native service behavior, connection locking or retries.
The bridge checks an expiring, identity-bound command before passing it to the
native Home Assistant service. Once handed off, Tuya Local's own delivery and
retry behavior applies; MQTT expiry is not a device-local cancellation guarantee.
Only a genuine subsequent device reply confirms the resulting state.

## Apply the reviewed patch

This adapter supports only the exact reviewed **2026.9.2** source hashes listed
in `tuya-local-observation.json`. An unknown or partially patched source is
rejected before mutation. Review a changed upstream source before updating the
adapter; a matching version label alone is insufficient.

Copy the installer and its three bundle files with their relative layout intact,
then first run a read-only check:

```sh
python3 scripts/apply-tuya-local-observation.py \
  --integration-dir /config/custom_components/tuya_local --check
```

Apply with a private backup directory outside this repository and the integration:

```sh
python3 scripts/apply-tuya-local-observation.py \
  --integration-dir /config/custom_components/tuya_local \
  --backup-dir /config/private-backups/tuya-local-observation
```

The installer performs no network calls, Home Assistant restart, service call or
device command. It validates both files and the patch before backing up original
bytes, preserves permissions and line endings, then replaces each file atomically.
A failed second replacement restores the first. A reviewed Home Assistant restart
is required to load the patched Python classes; plan it separately from file
installation. HACS may replace the patch during an integration update. A missing
observation attribute makes the bridge unavailable rather than falling back to
optimistic entity state.

Offline validation: `node --test test/tuya-local-observation.test.js`. The test
executes patched upstream methods using synthetic native replies and checks
partial reports, pending values, reconnects, physical identity, scoped attributes,
exact source checks, backups, idempotence and installation rollback.
