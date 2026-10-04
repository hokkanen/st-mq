# Changelog

Release notes describe changes relevant to users. Detailed implementation and
validation history is available in Git; unfinished work belongs in GitHub issues.
Versions follow Semantic Versioning. `-dev.N` denotes a development prerelease.

## Unreleased

### Added

- `npm run deploy:ha` deploys the committed checkout to a stopped Home Assistant
  app through SSH, verifies the rebuilt image and preserves stored files.
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

- Shelly current adjustment now defaults on independently of Automatic scheduling,
  including Charge now. Charger 2 priority uses household headroom without
  reserving Charger 1's draw; Equalizer must reduce Charger 1. Explicit basic-mode
  configuration, native limits and commissioning requirements remain supported.
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

- Unscheduled Shelly charging with Charger 1 priority uses live peer demand;
  an economic forecast no longer reduces its current when the peer is stopped.
- Easee reads, command acknowledgements and automatic takeover wait briefly for
  an admitted device timestamp to become current, then recheck the original
  connection and native instructions without repeating a command. Small clock
  skew no longer becomes a cached disconnection or an incorrectly revoked pause.
- Supported Shelly chargers can adjust current when optional UI step metadata is
  absent. Contradictory native capabilities still prevent current writes.
- Shelly allocation uses the latest admitted phase readings without advancing
  their timestamps or waiting for a cached cloud snapshot. Ordinary charger polls
  reuse applicable plans and avoid unnecessary peer polling. Uncommissioned load
  models retain their configured fallback ceiling in delivery forecasts.
- Shelly Start confirmation accepts a matching late notification within the same
  native timestamp second only after an acknowledged command and a fresh query
  after that notification. This prevents an owned Start appearing as native Enable.
- Vehicle identification can combine a unique measured Tesla current match with
  BMW's own matching start/stop evidence to resolve both chargers when their
  transitions overlap. Missing or contradictory evidence remains unresolved.
- Shelly device-originated `sys` Stop/Enable changes are handled throughout a
  connection, including repeated cycles and normal charging. A device Stop blocks
  replacement Start until fresh permission returns. Identification keeps its
  original limits; unrelated native instructions and protection still apply.
  The owner-approved source ambiguity remains documented.
- Charging planning can find split charging opportunities around household load
  peaks when continuous periods would incorrectly report a missed deadline.
  Fixed native current, per-phase headroom and minimum run/gap limits still apply.
- Briefly missing native charger metadata during restart no longer discards saved
  capacity observations. Planning waits for confirmed metadata and still rejects
  evidence from a changed installation or expired observations.
- Delayed charging calculations now check live identification with the current
  observation time. A fresh charger read arriving during a calculation no longer
  interrupts the 6 A comparison; its original deadline and forecast times remain
  unchanged.
- When a current comparison ends and the newly selected plan requires waiting,
  Shelly stops and confirms zero draw before restoring the higher current limit.
  Normal scheduled charging and **Charge now** retain their existing behavior.
- Shelly partial status notifications retain their event time and unchanged
  attributes without replacing native value clocks. Brief permission changes
  between polls remain visible to control, and held electrical values do not
  become fresh measurements. A command's own notification arriving during
  readback waits for fresh confirmation without repeating the command. A normal
  connected work-state update no longer rejects an independently confirmed
  permission change; pending observations still block further commands.
- A charger connected with native Auto charge disabled is now recognized while
  waiting for permission, so automatic identification can start from that state.
  A fresh native read also recovers that connection after restart when its state
  was previously unrecognized, preserving the original plug time and stop fences.
- Idle charger meter updates no longer repeatedly count unchanged property
  capacity evidence, which could lower the forecast and bring charging forward.
- After identifying Tesla on Charger 1, the 6 A comparison can hand Charger 2
  to BMW's own confirmed pause within the original test window. Any remaining
  reduced current restores after fresh zero draw, and **Charge now** preserves
  that pause before continuing normal charging. This also works when Tesla was
  already identified and remains under a confirmed native Stop: BMW's measured
  6 A draw can lead to its own pause without waiting for Tesla to charge again.
- BMW's identification pause remains in place while its original current setting
  is being restored. A native current update arriving before command confirmation
  no longer ends the pause before BMW can report its matching stop. Missing
  confirmation keeps charging stopped, including with Charge now and after restart.
- Native Stop during a Charger 2 current comparison keeps the 6 A setting until
  fresh physical zero confirms the stop, including with Charge now or Automatic
  off and across expiry or restart.
- Charger command confirmation waits for a new read after acknowledgement when
  an older poll is still running. This prevents a successful 6 A setting or
  start/stop command from being rejected because its read began too early;
  accepted writes are never repeated.
- A fresh charger query can reconcile different connected work states reported
  in the same native second, preventing a rapid start/stop from blocking control.
  Original timestamps remain unchanged; ambiguous connection boundaries stay blocked.
- Charger 2 confirms its 6 A identification setting before starting from an
  economic pause, including while Tesla still reports an old unplugged value.
  Its original probe deadline uses the confirmed ceiling; restoration waits for
  fresh zero draw when returning to the pause. **Charge now** lets an active
  identification finish before restoring normal current and continuing charging.
- Charging can resume after Tesla reports the current available from a stopped
  charger; that supply-dependent value no longer becomes a vehicle restriction.
  A positive vehicle request below 6 A can use the charger's minimum pilot while
  the vehicle limits its own draw. Electrical limits and native Stop still apply.
- **Use automatic** confirms Easee handover when a fresh native setting change
  has a source clock behind the application's command clock, and waits briefly
  for independently reported command results. It rejects unchanged readback and
  never repeats an uncertain command.
- An explicit **Identify** request can run a new current test after a successful
  earlier test on the same connection, including after restart.
- Economic replanning no longer repeatedly cancels a BMW identification pause
  before it reaches the charger. The pause keeps its original deadline and
  still yields to native Stop, disconnection and explicit control changes.
- An ordinary Easee scheduled pause can remain confirmed when a stopped charger
  receives a revised release time. Fresh zero draw and native profile readback
  confirm the continuing pause without inventing a new vehicle stop response.
- A bounded identification test retains its accepted return to economic waiting
  after an inconclusive result or restart. A provisional forecast caused during
  the test can no longer restart charging immediately after the test stops.
- Charger identification can use corroborated live Tesla charging evidence when
  TeslaMate's plug topic still holds an older unplugged value, while preserving
  that original report and rejecting newer disconnect evidence. BMW identification
  can pause beside a settled provisional or natively stopped peer. The dashboard
  explains blocked identification actions and no longer shows a completed current
  test from another physical connection as the current test.
- Home Assistant development deployments now use SSH for binary file transfer
  and Supervisor requests, removing terminal chunk delays and redraw failures.
  Existing SSH keys and trusted host entries are reused; deployment connection
  files now require `ssh_host` instead of the web-terminal URL/token fields.
  The app remains stopped, with checksums, storage checks and failure locks kept.
- Tesla identification now tolerates inaccurate vehicle phase-count metadata
  when measured current and power uniquely match, and can retire an old BMW
  episode that ambiguously matched both chargers. Identification no longer
  overrides ordinary economic charging while just observing, and exhausted
  attempts cannot restart pause loops. BMW tests wait for a quiet peer window;
  Balanced and both priority modes retain their existing schedule commitments.
- Simultaneous charging no longer identifies Tesla from similar power and start
  times alone. When Charger 2 supports verified current writes, identification
  temporarily uses its minimum current and requires a unique measured response;
  the original setting is restored afterward. Ambiguous evidence stays pending.
- BMW identification holds its pause for up to 90 seconds for the vehicle's
  response, with a fixed deadline preserved across restart. Charger 2's own
  same-value system updates no longer repeatedly yield to manual control, while
  newer external instructions keep priority. Fresh charger snapshots also keep
  their correct observation time.
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

### Known limitations

- A repeated native Stop while Shelly is already automatically paused may leave
  its status unchanged. The application cannot detect that new instruction and
  may resume at the scheduled time. This provider observability limitation remains
  open in [issue #2](https://github.com/hokkanen/st-mq/issues/2).

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
