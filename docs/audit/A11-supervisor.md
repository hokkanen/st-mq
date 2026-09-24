# A11-G02 — Supervisor options contract

Validated on 2026-09-24 against official Home Assistant Supervisor **2026.09.1**, commit [`40e3ee7640a3c44abe67f1a1397f39c3cd949806`](https://github.com/home-assistant/supervisor/tree/40e3ee7640a3c44abe67f1a1397f39c3cd949806). The exact current ST-MQ manifest and its nested defaults pass the actual upstream validators. No flattening, JSON-string workaround, compatibility translator, or additional Supervisor privilege is justified.

The [developer documentation](https://developers.home-assistant.io/docs/apps/configuration/#options--schema), checked on that date, still describes a maximum nesting depth of two. The pinned implementation recursively accepts dictionary/list schemas, with no two-level limit. Its [manifest validator](https://github.com/home-assistant/supervisor/blob/40e3ee7640a3c44abe67f1a1397f39c3cd949806/supervisor/apps/validate.py) and [option/UI validators](https://github.com/home-assistant/supervisor/blob/40e3ee7640a3c44abe67f1a1397f39c3cd949806/supervisor/apps/options.py) were executed directly; no validator was copied, patched, or replaced with ST-MQ's assumptions.

The reproducible fixture is [validate_options.py](../../test/extended/supervisor/validate_options.py), with its isolated [Dockerfile](../../test/extended/supervisor/Dockerfile). **Nine tests passed**. The manifest SHA256 for that run was `bf9d3701d4e5e507e7da4296f966d8430dd4bfecfb7345615a1a188e1b804129`; all **240 schema paths** survived upstream UI descriptor generation.

| Check | Observed result |
| --- | --- |
| Entire `config.json`, including packaging metadata and defaults | Accepted; option values retained |
| Nested `equipment.devices[].mqtt` and `readings[]` | Accepted with original array/object structure and calibrated numeric values |
| Current Garage and physical charger-2 defaults | Accepted as part of the complete manifest |
| Generated UI descriptors | Every current schema path represented recursively |
| Nested invalid numeric value and explicit optional `null` | Rejected |
| Existing string and numeric `!secret` references | Resolved by the upstream accessor and option validator |
| Actual `options/config` API handler | Returns resolved settings while leaving stored references unchanged |
| Actual `options` API handler | Validates, then stores resolved values; subsequent readback matches |
| Missing secret or nested `null` on save | Error before persistence; existing options preserved |
| Synthetic reply loss after successful persistence | A fresh readback returns the already saved normalized options |

The actual [options API implementation](https://github.com/home-assistant/supervisor/blob/40e3ee7640a3c44abe67f1a1397f39c3cd949806/supervisor/api/apps.py) calls the validator before assigning options. The actual [App options getter/setter](https://github.com/home-assistant/supervisor/blob/40e3ee7640a3c44abe67f1a1397f39c3cd949806/supervisor/apps/app.py) participates in the fixture. This independently supports the application's existing save/readback and interrupted-import receipt contract. ST-MQ still rejects new secret references in `secrets.json` imports; resolving an existing Supervisor reference does not add a new import format or preserve retired development options.

Upstream warns that the accepted `addon_config` mount name is deprecated in favor of `app_config`. That warning does not reject this manifest or change its current `/config` mount. Renaming installation paths is separate from the nesting/secret defect hypothesis and was not folded into this validation.

## Reproduction

Use a disposable public-source checkout and the fixture Dockerfile. These commands do not mount household configuration, the Docker socket, host devices, or application data. The container has no network, no capabilities, a read-only root, and a small temporary filesystem containing only synthetic secrets.

```sh
git clone --depth 1 --branch 2026.09.1 https://github.com/home-assistant/supervisor.git /tmp/stmq-supervisor-a11-2026.09.1
git -C /tmp/stmq-supervisor-a11-2026.09.1 rev-parse HEAD
# Must print 40e3ee7640a3c44abe67f1a1397f39c3cd949806.
docker build -f test/extended/supervisor/Dockerfile -t stmq-supervisor-a11-validator:2026.09.1 /tmp/stmq-supervisor-a11-2026.09.1
docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges --tmpfs /tmp:rw,nosuid,nodev,noexec,size=16m \
  -e PYTHONDONTWRITEBYTECODE=1 -e PYTHONPATH=/supervisor -e GIT_PYTHON_REFRESH=quiet \
  -v /tmp/stmq-supervisor-a11-2026.09.1:/supervisor:ro \
  -v "$PWD/config.json:/manifest.json:ro" \
  -v "$PWD/test/extended/supervisor/validate_options.py:/validate_options.py:ro" \
  stmq-supervisor-a11-validator:2026.09.1 python /validate_options.py /manifest.json
```

The Python base is digest pinned; direct Python dependency versions come from that Supervisor revision. Transitive Python and Debian dependencies are resolved during image construction, so this is repeatable contract validation, not a claim of a bit-for-bit reproducible Supervisor release image.

## Remaining installation checks

This closes the unverified **backend depth and normalization** question for the pinned release. It does not certify a household's installed Supervisor version, browser form rendering, the actual add-on install/update flow, ingress authorization, Supervisor's durable storage under power loss, backup coverage, or secret-file reload scheduling. The fixture uses the real YAML parser and secret accessor; it supplies synthetic registry, reload, request-body and persistence callbacks around the unmodified API methods. It simulates response loss after a successful save, not filesystem crash consistency. Existing ST-MQ import tests separately exercise receipt recovery and cleanup.

The installed-platform acceptance check remains: record the deployed Supervisor version, apply a synthetic current configuration, check the rendered form or YAML editor and normalized readback, and verify the actual installation/backup flow in a disposable Home Assistant installation before claiming that broader coverage. No household service, equipment, credential, or private file was used here.
