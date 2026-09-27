# Topology and role contract review — September 2026

This change replaces two interacting enable flags with one current configuration
contract. The user selected `standalone`, `mirror` and `pair` for topology, with
`master` and `slave` for runtime/API and dashboard roles. Only mirror mode has
a configured role; pair authority belongs exclusively to durable runtime state.

## Current contract

- `controller.topology` / `STMQ_TOPOLOGY` selects `standalone` (default), `mirror`
  or `pair`. Standalone derives master authority without a configured role.
  Heating/control mode remains separate.
- `mirror` owns `mirror.role` / `STMQ_MIRROR_ROLE` (`master` by default or
  `slave`), SSH destination, snapshot storage and freshness settings. Both
  computers use mirror topology; only the master requires outgoing SSH settings.
  The slave never starts acquisition or equipment control.
- `pair` owns peer connection, local state, snapshot storage, freshness and
  virtual-IP settings. It does not read the mirror section or configure a role.
  Fresh pair installations without local history start as slaves; explicit
  promotion establishes the first master. Existing unclassified history starts
  protected. Saved authority remains authoritative after handover and restart.
  Promotion and handover never edit configuration.
- UI headers are **Standalone**, **Mirror · Master**, **Mirror · Slave**,
  **Pair · Master** and **Pair · Slave**. **Database mirroring** and **Paired
  computers** retain natural section names. Protected recovery and transitions
  remain explicit states rather than alternative configured roles.

## Removed representations

The `replication` and `pairing` configuration sections, their `enabled` flags,
`controller.role`, any `pair.role`, `primary`/`replica` role values, `STMQ_ROLE`,
`STMQ_REPLICATION_*`, `STMQ_REPLICA_*` and `STMQ_PAIR_ENABLED` are retired.
Readers reject retired inputs instead of translating them, ignoring them or recovering authority from an old shape.
Incompatible saved state is reported without deleting, resetting, converting or
overwriting it. The default pair authority-state path remains
`<data directory>/pairing` so renaming configuration cannot skip existing authority. Existing source and
script paths may retain historical names; those filenames are not configuration aliases.

`/api/pair` and `/api/pair/action` replace the former pairing API routes.
`/api/status` reports `topology`, `role`, `pair` and common `sync` status.
Pair authority state is version 3; the encrypted peer protocol is version 2 at
`/v2/pair`. Standalone controller identity is version 1 with the master role.
Incompatible saved authority/identity is rejected before lock or state-file
mutation. A deliberate new setup uses a fresh state directory and preserves
rejected files; no mixed-version bridge or reset-on-startup is provided.

## Retained capabilities

Both synchronization implementations remain: fixed-role SSH mirror mode using
`sqlite3_rsync`, and encrypted HTTP pair synchronization with explicit handover,
manual force promotion and protected history recovery. Neither mode adds
automatic failover or a transport selector. Current-schema restart, verified
snapshot publication, interrupted-transfer recovery, read-only slave fencing,
local credentials, retained restoration duties and explicit recovery remain part
of the supported behavior. Copied database settings cannot grant authority.

Private installation configuration and household state are not rewritten by
this repository change. Documentation examples use invented addresses, paths
and credentials.

## Validation

The mirror and pair setup examples in `docs/replication.md` and `docs/pairing.md`
parse as JSON and pass full `loadConfig` against public defaults. The check used
only synthetic temporary configuration, confirmed mirror master and pair slave
roles and the absence of a configured pair initial role, and removed its temporary
files afterward. No household configuration was read or written. All 114 relative
links in the changed documentation resolved.

| Check | Executed result |
| --- | --- |
| `npm test` on Node 26.8.2 | 3,802 tests passed; zero failures, skips or cancellations. This run preceded the final bootstrap publication guard adjustment; its focused follow-up is recorded separately below. |
| `STMQ_REQUIRE_SSH_TESTS=1 STMQ_REQUIRE_RSYNC_TESTS=1 STMQ_REQUIRE_MQTT_TESTS=1 npm run test:extended` | All 9 passed without skips, including actual isolated local SSH, `sqlite3_rsync` and MQTT. |
| UI-related Node suites | Broad run: 1,123 passed. Final focused run: 47 passed. |
| `npm run build` | Initial and final rebuild passed; existing chunk-size advisory only. |
| Firefox synthetic browser smoke | Passed, including all five normal topology/role headers and mobile layouts. |
| `node --test test/pair-authority.test.js` after the final bootstrap publication guard | 33 passed. Covers first-master setup, durable `everWritten` authority and protection of unclassified incoming snapshots. |
| Final broader pair/configuration/authority follow-up | 145 passed; zero failures, skips or cancellations after the final guard changes. |

The final follow-up command was:

```sh
node --test --test-concurrency=4 --test-timeout=60000 test/pair*.test.js test/control-authority.test.js test/addon-configuration.test.js test/replica-config.test.js
```

These checks use synthetic fixtures and isolated local services. They do not
operate household equipment or establish live deployment readiness. Both
transports remain supported; no comparative transport benchmark was performed.
