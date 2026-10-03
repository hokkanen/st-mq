# Changelog

Release notes describe changes relevant to users. Detailed implementation and
validation history is available in Git; unfinished work belongs in GitHub issues.
Versions follow Semantic Versioning. `-dev.N` denotes a development prerelease.

## Unreleased

### Added

- `npm run deploy:ha` deploys the committed checkout to a stopped Home Assistant
  app through WebSocket, verifies the rebuilt image and preserves stored files.
  Credentials stay outside the checkout; the app remains stopped.

- **Recover history** opens one shared window from Recording details and Paired
  computers. Preview and recover missing history from a paired computer, a saved
  backup or an uploaded SQLite file. Earlier recoveries remain available to
  revert and restore, preserving newer local recordings and other recoveries.
- Dashboard exports, CLI backups and pairing reset archives now produce the same
  self-contained `.sqlite` format. Reset archives also retain the original files;
  incompatible or damaged originals remain preserved with an explicit explanation
  when a usable SQLite backup cannot be made.

- **Reset pairing…** offers **Keep local history** or **Start fresh** from the
  paired dashboard, including protected startup failures. Both archive the
  previous pairing files; Start fresh also archives local databases and snapshots
  before returning as a slave. Archives remain until manually deleted and are
  accessible through Home Assistant's app-configuration folder. Retained history
  stays protected, and neither choice automatically promotes the computer.

### Changed

- History recovery now has a compact entry inside its own Recording details fold
  and an aligned action in Paired computers. The shared window separates new
  recovery from previous recoveries, keeps reviews tied to their source, and
  presents clearer counts, progress and revert/restore outcomes on small screens.
- Reversible recovery uses SQLite schema 20 and learning algorithm
  `committed-house-v14-reversible-recovery`. Earlier development databases require
  a deliberate fresh start; they are rejected without migration or automatic
  reset. Recovery accepts the current format only; supported 0.7.5 CSV import
  remains available.

### Fixed

- Charging searches run in a local worker and avoid repeated unchanged work,
  keeping dashboard requests and device replies responsive. Joint planning is
  faster without reducing its search or changing selected schedules.
- Existing charging pauses and programmed release times survive missing startup
  prices or electrical readings for the same confirmed connection.
- Paired computers keeps successful local status when chart/history requests
  fail, and ignores older failed reads after a newer status arrives. An offline
  peer remains a separate status.
- Charger 2 keeps physical connection readings available when another charger
  read fails, and accepts confirmed unchanged state without losing its original
  timestamp. Both charger cards show clearly labeled configured defaults while
  connection evidence is unavailable, and use consistent wording for confirmed
  pauses between charging periods.
- Reset pairing accepts configured storage-directory links, including a checkout's
  `var` link to persistent storage. Internal links and overlapping physical paths
  remain protected, and changing a directory link cannot redirect an interrupted
  archive operation.
- Paired computers has clearer status groups, balanced mobile layouts and amber
  emphasis for problems or decisions that need attention. The compact view shows
  reported mirroring evidence, and normal operation keeps recovery steps out of
  the way. Lost connections no longer leave current-status claims visible.
- Charger 2 retains command acknowledgements arriving during replanning so its
  own confirmed stop does not incorrectly become a manual override. Whole-second
  charger timestamps no longer leave acknowledged Start/Stop commands permanently
  unconfirmed when a matching post-command query confirms the setting. Missing
  vehicle feeds no longer hide charging periods while identification is pending.
  Charger 1 displays proposed periods while waiting for OCPP charging approval,
  without claiming the profile has already been applied.
- Paired startup and snapshot transfer report incompatible or malformed database
  schemas explicitly. Startup logs include safe schema-version numbers and
  recovery guidance; protected dashboards retain the diagnosis across restart.
  Incompatible databases remain rejected without migration or automatic reset.
  The pairing guide now documents deliberate fresh setup on Ubuntu and Home Assistant.

## 0.9.5-dev.3 — 2026-10-03

### Fixed

- Charger 2 keeps its native kW readings in the correct units, fixing near-zero
  power displays, Tesla power matching and recorded power. Correlated current
  readbacks can confirm an unchanged setting without inventing a newer device
  timestamp; meter-counter warnings no longer hide control readiness.
- Unknown charger current uses the maximum available within known limits and
  shared property capacity when planning cheaper periods. An unavailable second
  charger remains in that forecast instead of forcing immediate BMW charging.
  Cards label assumed current and unconfirmed proposed schedules; session reports
  retain the planning reason, warnings and assumptions.
- The corrected power interpretation requires database schema 19 and current
  Shelly acquisition state. Earlier development databases are rejected before
  mutation and need an intentional fresh start; no history is silently rescaled,
  migrated or deleted.
- Pair recovery recognizes existing unavailable and stale observations across
  fresh snapshots, avoiding repeated imports and misleading coverage or learning
  conflicts. Existing history is preserved without an automatic cleanup.
- Pairing distinguishes normal mirror comparisons from protected-history
  recovery, prevents restoring master deletions from an ordinary mirror, and
  preserves completed recovery when the same donor is checked again. Both
  computers show snapshot status with its observation time; unresolved releases
  retain their original retry request.
- Pairing protects unexpectedly changed local snapshots before replacing them
  and rejects malformed saved authority state before startup mutation.
- Returning masters resolve reachable competing claims before opening equipment
  connections, and require confirmed control and address release from the peer.
- Pairing now explains how to correct a missing Home Assistant LAN interface
  in the app configuration and regenerate its address-helper policy by restarting.
- Configuration and startup-recovery screens show
  `/addon_configs/<app-slug>/secrets.json` for Home Assistant uploads. The
  in-app import path remains `/config/secrets.json`.

## 0.9.5-dev.2 — 2026-10-03

### Fixed

- The README icon uses a public absolute image URL so it also appears in Home
  Assistant's app information section.
- Invalid startup configuration now opens a configuration recovery screen instead
  of preventing access to the UI. Home Assistant uses its authenticated ingress;
  standalone Linux uses loopback access with a temporary private access key.
- Recovery can review and explicitly replace incompatible saved Home Assistant
  options with a current `secrets.json` import. Omitted settings return to shared
  defaults, and the previous saved options are backed up privately before replacement.
  Ordinary imports continue to merge into saved settings.
- Recovery keeps equipment control and recording inactive until configuration is
  valid and the application is restarted. Invalid uploads remain available for
  correction; old configuration formats are not translated and databases are not reset.

## 0.9.5-dev.1 — 2026-10-03

First public development prerelease after 0.7.5. The intervening 0.8.x/0.9.0
work from H66 is integrated into `main` and consolidated into this release; it is not
a production-support promise. Home Assistant's default repository now follows
this development version; installations configured with `#H66` need the default
repository source for this release.

### Added

- One Node application for standalone Linux and the Home Assistant **Home Energy**
  app, with a shared dashboard, simulated startup and independent feature controls.
- Home thermal learning with deterministic journal reconstruction, reversible
  source corrections, price-based heating plans and complete-cycle assessments.
- Durable Garage Normal/Away targets and the `shelly-cn105/v2` integration for
  device-local regulation and independent frost protection.
- Coordinated Easee and Shelly EVSE charging, connection-scoped vehicle identity,
  manual controls, native-instruction handover and retained session reports.
- SQLite recording with source timestamps, quality and unknown-state handling;
  adaptive storage, chart exploration, database export and same-version backups.
- Read-only SSH mirroring and paired operation with explicit manual handover,
  recovery and command-authority fencing.
- Separate admin/family direct access, configuration preview before application,
  MQTT equipment setup and optional Home Assistant device bridges.

### Changed

- Home heating starts paused; Garage uses manual modes. Charging Automatic and
  Caravan Automatic power have their own equipment-bound choices.
- Ordinary application stop, restart and pair handover preserve native Easee OCPP
  configuration. New connections and explicit **Use automatic** handovers require
  fresh native evidence; later external charging instructions retain priority.
- Home Assistant packaging uses the current `app_config` mount and assigned
  ingress port, preserves existing Supervisor `!secret` references, and validates
  nested defaults, English translations and imports against pinned upstream code.
- Documentation separates installation, current behavior, contributor guidance
  and release notes. Completed TODO/progress/audit diaries and obsolete local
  copies are removed from the checkout.

### Fixed

- Admin and read-only UI restrictions now compose correctly, so clearing one
  restriction does not leave a permitted control locked or release another
  restriction. Database downloads remain available when saving a server-side
  copy is restricted, and export completion preserves active access locks.

### Compatibility and limitations

- Read-only `st-mq.csv` and `easee.csv` import from 0.7.5 remains supported, with
  provenance, duplicate handling and interruption recovery. The old runtime,
  configuration and development databases are not supported upgrade inputs.
- There are no development database migrations or automatic resets. Incompatible
  databases fail before mutation; use a deliberate fresh database and reimport
  supported original CSV sources when needed. Existing 0.7.5 installations also
  require current configuration; preserve backups and review the
  [installation change guidance](DOCS.md#moving-from-an-earlier-version).
- The SONOFF floor-preheating integration remains pending and cannot be enabled
  or commissioned. Home/Garage models and equipment safeguards still need their
  installation-specific checks.
- Local OCPP needs the controller for new-session authorization; native pause
  expiry does not restore cloud control. Shelly recovery requires a working
  application/device connection. See the maintained charging guides for limits.
- Automated and synthetic tests do not establish installed Home Assistant OS,
  physical Raspberry Pi, firmware, wiring, heat delivery or energy savings.
  See [development validation](docs/development-validation.md) for current
  checks and the remaining release validation work.
