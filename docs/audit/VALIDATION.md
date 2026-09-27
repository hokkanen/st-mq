# Final validation of A01–A11 and B12

Executed on 2026-09-24 in an isolated checkout of baseline
`f017684f708d0016978f27c40b291e7f2e222a59`. All observations, credentials,
configuration and services used by these checks are synthetic. No household
database, export, broker, actuator or installed service was used or changed.

## Automated checks

| Check | Result |
| --- | --- |
| Complete `test/*.test.js`, Node 24.21.0 | 2,753 passed; no failures, cancellations or skips |
| Complete `test/*.test.js`, minimum Node 22.19.0 | 2,753 passed; no failures, cancellations or skips |
| Complete `test/extended/*.test.js`, Node 24.21.0 | 9 passed; no failures, cancellations or skips |
| Supplied A01 desired-behavior production witnesses | 4 passed |
| Supplied A01 independent allocation specification | 12 passed; these exercise the specification, not the production implementation |
| Supplied B12 policy acceptance | 23 passed; targeted sentinels, not a completeness proof |
| SmartThings vendored source and Lua behavior | 31 source hashes verified; 75 assertions passed |
| Actual upstream Supervisor 2026.09.1 validators/API contract | 9 passed; all 240 current schema paths retained; see [pinned fixture and limits](A11-supervisor.md) |
| Production Vite build | Passed on host Node 24 and shipped Alpine Node 22.23.2 |
| Final AMD64 add-on image and networkless container harness | Passed; image `4a107d829b64` |

Full-suite commands use the selected Node executable:

```sh
node --test --test-concurrency=4 --test-timeout=60000 test/*.test.js
STMQ_REQUIRE_SSH_TESTS=1 STMQ_REQUIRE_RSYNC_TESTS=1 STMQ_REQUIRE_MQTT_TESTS=1 \
  node --test --test-concurrency=2 --test-timeout=180000 test/extended/*.test.js
npm run build
docker build --tag st-mq:audit-a01-b12 .
bash scripts/test-addon-container.sh st-mq:audit-a01-b12
```

The host checkout shared read-only installed dependencies with the original
checkout; their retained package versions match the lockfile. Its equivalent
build command used Vite's `--configLoader native` to avoid writing into that
read-only dependency directory. The Docker build used genuine `npm ci` installs
and the ordinary `npm run build`. Vite reports the existing large-chunk advisory
(approximately 707 kB minified JavaScript, 234 kB gzip); this is not a failed build.

The extended run requires real Mosquitto, SSH and `sqlite3_rsync` and cannot silently
skip them. It covers duplicate MQTT delivery, current-schema transfer and recovery,
interrupted transfer, SSH channel configuration, and real SQLite lock contention.
The container harness covers the shipped command, authentication, restart,
current-schema persistence, export, cold backup/restore, read-only shared folders,
provider plumbing, slave viewer and bundled SSH/SQLite/VIP tools.

## Actual browser checks

These scripts ran in isolated Chrome sessions against the built application:

| Script | Executed coverage |
| --- | --- |
| `scripts/browser-ingress-smoke.js` | Ingress-prefixed assets/API, authentication/session expiry, settings application, stalled initial requests, complete-body timeout, continuing status polling and stale/online recovery |
| `scripts/browser-equipment-smoke.js` | Current independent vehicle feeds, equipment controls, pending/readback/slave presentation and five responsive widths |
| `scripts/browser-garage-smoke.js` | Home/Garage/Total and timing/model controls, 22 charging states, physical C2 presentation, both themes, 320–1920 px layouts, keyboard/focus and polling persistence |
| `scripts/browser-home-controls-smoke.js` | Synthetic Home controls, state/confirmation presentation and responsive layouts |
| `scripts/browser-learning-smoke.js` | Current learning/input charts and axes, settings drafts, real Engine/API path with fake H66 50-degree readback and restoration to 55 |

All passed with no reported browser exceptions. The final Garage pass follows
the corrected shared Heating card identity and includes visual screenshot review.
Browser tests intercept or simulate commands; they do not qualify physical receipt.
Firefox BiDi was unavailable, so updates to the full historical-chart smoke fixture
are not represented as an executed pass of that separate script.

## Scope and remaining operating limits

Every numbered A01–A11 finding, including A11's qualified gaps and hardening item,
has a disposition in the [audit index](README.md). All 20 B12 items and A01's 20
integrated acceptance topics plus six observations are tracked. Retired tests
were replaced with current-contract and explicit rejection coverage; test-count
changes are not a claim that old development formats remain supported.

Physical C2 remains disabled/uncommissioned until the arriving EVSE's exact native
contract is verified. Garage automatic OFF requires verified release ordering.
ARM execution, installed Supervisor rendering/install/backup behavior, installed
systemd/VIP behavior and real device timing remain commissioning checks.

Measured host limits are retained explicitly: a roughly five-second SQLite lock
wait, roughly 0.47–1.24 seconds for bounded synchronous charging planning, and a
roughly 10.9-second cold synthetic year chart query. Runtime event-loop delay is
observable; no hard real-time or Raspberry Pi performance guarantee is claimed.
See the feature ledgers for measurement geometry and tradeoffs.

Only read-only v0.7.5 `easee.csv` and `st-mq.csv` imports are supported historically.
Incompatible native databases/configurations are rejected before mutation; this
change does not reset, migrate or delete existing installation data. A deliberate
fresh development database and current configuration are required before running
the changed native contract. This is not the v1.0.0 production release.
