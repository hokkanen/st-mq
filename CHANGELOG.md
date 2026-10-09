# Changelog

Release notes describe changes relevant to users. Detailed implementation and
validation history is available in Git; unfinished work belongs in GitHub issues.
Versions follow Semantic Versioning. `-dev.N` denotes a development prerelease.

## Unreleased

- Charging plans finish under repeated unchanged observations instead of
  restarting until reporting becomes quiet. A bounded additional candidate
  recovers feasible two-car schedules around an earlier vehicle deadline.
- Charging control takes priority over optional extra-day calculations and
  proceeds when its current plan commits. Identification and Charge now no
  longer wait behind obsolete economic calculations. Local Easee identification
  requests fresh meter reports within the original attempt deadline so slow
  periodic reporting does not consume the probe without usable measurements.
  Completed native work releases the controller for the next bounded duty while
  planning continues. Shelly's confirmed identification current preparation no
  longer invalidates its own automatic takeover.
- Charging actions finish with the selected charger's result while peer updates
  continue independently. A due probe stop or restoration can interrupt an old
  planning wait, including after its observation window has expired. Shelly's
  accepted Stop confirmation survives a separate current-setting readback.
- After restart or handover, saved vehicle targets survive the initial absence
  of live feeds. Easee transaction confirmation recovers from conflicting power
  samples when later valid reports arrive for the same transaction.
- Local OCPP starts and confirmed pauses survive harmless refreshes and cost
  estimate changes. Shelly actions admit already received observations within
  their existing command budget, then recheck the original connection and native
  instruction before dispatch.
- An unrelated Easee source clock lead no longer forces healthy current feeds
  into fallback or delays ready observations from another device. Original
  measurement clocks and actual source-loss checks remain intact.
- Turning Charge now off returns the displayed connection to Automatic in one
  committed action. Failed saves leave both choices unchanged, and an older
  browser cannot cancel a newer charging request.
- Backups verify their complete contents and captured transaction boundary before
  publication. Damaged WAL headers and inconsistent recovery references are
  rejected without repairing the source; a complete export survives a failed
  directory flush for diagnosis, with success still withheld.
- Circulation restoration retains its original device obligation across failed
  saves and restart. Confirmed OFF clears that obligation only after commit.
  Saved heating, equipment-test, charging and handover state rejects malformed
  current data before granting control; recovery cleanup protects active databases.
- Charging observations advance vehicle/session evidence when admitted, so
  dashboard reads no longer change control state. Failed buffered Tesla admission
  remains unavailable until a successful fresh subscription, and OCPP current
  retains its original measurement clock.
- Queued or rejected Tesla and BMW observations no longer appear as fresh vehicle
  evidence through another charger connection. Recovery requires the affected
  evidence to be saved; unrelated readings cannot clear the failure. Charging
  replans from labelled session references instead of reusing the former plan.
- Recording diagnostics separate queue waiting from transaction BEGIN, body and
  COMMIT time, helping identify storage stalls without adding recorded history.
- Updated a build-only source-map dependency to fix unbounded processing of
  malformed indexed maps.
- Caravan dehumidifier power checks no longer fail on brief recording backlogs
  or repeatedly lock settings when meter reports arrive slightly ahead of the
  local clock. Commands keep their original deadlines, require fresh native
  confirmation and preserve newer manual choices and restoration duties.
- Brief input-processing holds preserve confirmed charging schedules, pauses
  and idle current settings while continuing to block new commands. Shelly read
  timeouts now describe an unavailable reading separately from an uncertain command,
  and retain bounded timing diagnostics for investigation. Automatic charging
  starts ON with fresh charging state; saved OFF choices and equipment identity
  checks remain in force.
- Vehicle identification can proceed on a reachable charger while its peer is
  explicitly offline. Tesla requires a matching physical charging baseline and
  confirmed controlled stop with fresh vehicle evidence; BMW retains its
  existing matching checks. Known peer actions and restoration duties still
  block conflicting tests. Charger current details remove the duplicate selected
  current row and use compact allowance, confirmed-setting and limit values.
- Brief vehicle-feed outages retain the current connection's last observed
  charge target and battery capacity, including across restart. This prevents
  a nearly full battery being compared with a lower configuration default and
  incorrectly completing its request. Details identify the retained reference.
- One extra day retains the earlier plan unless the additional time improves
  the combined choice after forecast uncertainty, without increasing estimated
  cash cost for the selected charger or household. A stopped, unscheduled peer
  no longer blocks the comparison; active peer demand still participates.
  Active allowances show the current joint proposal and explain redistribution
  caused by a later allowance for the other charger.
- A stopped Shelly charger keeps its fallback current setting instead of
  following every headroom change. Available capacity is still recorded, and
  the current needed for charging is confirmed before an application Start.
  Current adjustments have their own confirmation, so they no longer make an
  accepted charging schedule alternate between confirmed and unconfirmed.
- Voltage interruptions preserve the original observation and admission times,
  preventing invalid saved estimates. Pairing and admin recovery controls remain
  accessible when dashboard status fails. Existing malformed development state
  is still rejected and requires an explicitly chosen fresh start.
- Charger details group the plan, current limits and vehicle charge reference,
  with a separate Help & setup section and consistent report/extra-day arrows.
  Help clarifies session targets, deadline allowances and estimated costs;
  an active extra-day comparison labels the earlier and approved deadlines.
  Forecast-only planning retains stable evidence while workers calculate, and
  extra-day comparisons refresh across proposed charging boundaries.
- Normal charging now uses fresh price forecasts alongside published prices,
  with the same all-in tariff and uncertainty allowance as **One extra day**.
  The comparison changes only the selected deadline, so its estimate measures
  the benefit of additional time. Charging help, Schedule & readings and the
  comparison explain forecast use and separate cash savings from uncertainty.
  Family-password users can view, refresh, allow and cancel an extra day with
  the same session and control checks as admins.
- A missing commissioned local OCPP connection now gets up to three spaced recovery
  attempts using its verified existing Easee configuration. Cloud failures preserve
  local OCPP and charging instructions; working local control stays independent of
  cloud access. The connection panel shows the recovery wait or exhausted budget.
- Charging forecasts now account for temporary household peaks by their modeled
  duration instead of treating the lowest possible current as an all-day limit.
  This prevents false ready-by warnings and unnecessary immediate charging when
  a later feasible period is cheaper. Live current protection and native Stops
  remain authoritative.
- Charging keeps confirmed current limits available during brief input-storage
  holds while commands remain fenced. Reports distinguish expected allowance,
  confirmed settings and command readiness, and classify evidence transitions
  separately from plan changes. Background forecast updates share a fixed
  30-second settling window only while accepted future schedules remain usable;
  urgent changes and live current protection bypass it.
- Charging reports store repeated price arrays and shared forecast context once
  per report, retaining original events and whole-report expiry. Schema 28
  requires a deliberate fresh development database; existing databases are
  rejected before mutation and are never automatically replaced.
- Whole-database growth weights elapsed time during startup so the first hour
  does not dominate the following week. Storage details describe annualized
  recent growth and explicitly exclude report-expiry or year-end-size forecasts.
  Caravan shutdown restoration events now have a registered inventory description.
- Heating and hot-water circulation relay commands wait through brief observation
  storage backlogs, with authority, identity, feedback and deadline checks before
  dispatch. Failed recording still blocks control, and execution errors retain
  specific safe diagnostic codes.
- Price forecasts retain the provider's complete final hourly interval. One
  extra day compares feasible charging plans even when prices end before the
  later deadline, with a notice that incomplete coverage may change the saving.
- Device reports up to one second ahead now wait for clock catch-up automatically
  while retaining their original timestamps. Shared admission checks cover
  acquisition, Shelly permissions and sessions, vehicle targets, recording,
  voltage, energy and learning. HTTP replies use their actual receipt time.
  Larger skew remains invalid. Schema 27 and Home learning v17 require a deliberate fresh
  development database; existing history is never automatically replaced.
- One extra day keeps its last successful savings estimate through ordinary
  telemetry updates and replaces it when a new comparison is ready. Open
  comparisons refresh when relevant planning inputs change and display new results
  only when the shown values change. Both choices include expandable proposed
  charging periods. Savings remain visible
  after allowing a day, and the comparison explains any cost effect on the other
  charger without implying that its deadline is extended. Charger priority and
  extra-day controls use matching diagonal arrows; Session report has a visible
  border. Usable battery capacity accepts two decimal places and the extra-day
  arrow is vertically centered.
- Shelly identification retains its bounded attempt while ordinary observation
  storage and native readback are pending. Confirmed replies to the controller's
  own Stop are reconciled across same-second device timestamps without turning
  them into external instructions; unrelated native Stops and unresolved command
  outcomes retain priority.
- Shelly identification recovery now reconciles acknowledged Starts with fresh
  system permission readback instead of leaving an expired probe stuck at its
  temporary current. Later device Stops keep priority, missing acknowledgements
  remain unresolved, and recovery respects fallback capacity. Recovery messages
  identify pending permission and no longer imply the original current must be
  restored above the available limit.
- Electricity source details separate Prices and Price forecast with consistent
  descriptions and plain provider attribution. Price and weather forecasts show
  original fetch times and ages. The compact One extra day control shows available
  estimated savings directly, including zero, without adding a date;
  its comparison includes estimated charging duration and completion for both
  deadlines. Existing charging-control eligibility remains unchanged.
- Optional Finnish electricity-price predictions extend the existing price
  chart with sparse dots, independently of connected cars. Electricity prices
  lists the new forecast feed. Connected charger cards offer a compact estimated
  savings comparison and a separate one-day allowance: the later Ready by is
  marked **+1 day** until the earlier deadline passes, then becomes the normal
  deadline. Each further day needs a new approval. Forecasts expire in memory,
  use a separate planning risk allowance, and never enter recorded bills or
  heating inputs. `electricity.forecast_enabled` defaults to on for private,
  non-commercial use and can be disabled in configuration.
- History recovery now shows recorded dates for incremental source checks and
  clearer per-category results. Previous recoveries identify their accepted
  records and original dates; revert/restore reviews show affected dates,
  dependent records and whether the learned model changes. Verification choices
  sit beside their actions, and **Reload results** explicitly refreshes saved
  outcomes. Pairing groups history results, upgrade guidance and operation
  messages with their related controls; earlier successful checks no longer
  appear current when mirroring is stale or unavailable.
- Journal capture preserves stored numeric precision across the Home Assistant
  and Ubuntu runtimes. This fixes valid snapshots being rejected with
  `database_journal_invalid` because SQLite JSON rendering rounded numeric values
  before hashing. Schema 26 requires a deliberate fresh development start;
  existing databases and their original journal evidence remain preserved.
- Late firewood removals and sensor-change reversals reuse a verified unaffected
  learning prefix, including after restart and transaction compaction, instead
  of replaying all earlier learning inputs for every correction.
- Interrupted initial-seed acknowledgements retain a cleanup receipt so a lost
  reply or restart cannot leave a full snapshot permanently pinned.
- Pairing reset archives pending replication files beside the database and reports
  bounded, private-safe failure diagnostics when a shutdown or archive fails.
  Keeping history clears the kept copy's previous peer enrollment after archival,
  so an interrupted initial seed cannot block the newly reset pair.
- Peer enrollment captures its default checkpoint after acquiring the write lock.
  Fresh peer status clears a past connection error while retaining actual transfer
  or verification failures; unexpected peer failures have private-safe diagnostics.
  Pairing metadata waits through normal asynchronous write admission, with the
  final handover stamp written off-thread after control has stopped.
- Recording health no longer shows an out-of-date warning for a small server
  clock lead. Larger clock differences have an explicit explanation, while stale
  checks and failed refreshes retain their warnings.
- Controls recover after a failed MQTT observation save when fresh evidence from
  the affected input commits, without requiring a broker reconnect. Read-only
  status requests remain available while commands wait for trustworthy evidence.
- Adaptive recording no longer retains every intermediate recorder update in an
  unlimited transaction log. Compact reversible changes and bounded recent
  transactions preserve observation selection, report coverage and real gaps.
  Recording details separates observation budgets, physical allocation, reusable
  pages, peer catch-up state and protected branch storage.
- Paired and mirrored peers retain a consolidated change set until acknowledgement.
  Long outages transfer changed rows and deletions without copying unchanged
  database history. Interrupted transfers, rejoin and lost acknowledgements keep
  durable checkpoints and protected divergent evidence.
- Sparse learning checkpoints keep late history recovery and reversal proportional
  to the affected suffix after transaction compaction. Required original learning
  inputs and correction records remain retained. These changes require schema 26;
  incompatible development databases remain intact and need a deliberate fresh start.
- Full verification remains available manually, during manual operations, and on
  an optional schedule. Application checks now share one visible queue and compare
  only matching committed checkpoints. Oversized controller-thread database writes
  roll back with worker/batching guidance; supported CSV CLI imports use a worker.
- Database exports and previous-recovery summaries run in background workers.
  Recovery uses bounded scratch storage and preserves concurrent recordings;
  measured progress and elapsed time remain visible across navigation and reload.
  Cancelled exports release their worker and temporary files. Source checks retain
  the current read-only inventory workflow, without a trial import.
- H66 restoration waits for usable readback without repeatedly retrying an
  expired timer. Missing registers retain their restoration duties, and newly
  received evidence resumes recovery even during another register's restore.
- Energy checks run in the history worker, keeping large meter histories off
  the control thread. Successful latest comparisons avoid loading all counters;
  older comparisons stream through bounded memory without discarding history.
- Joint charging search can move both chargers into shared cheaper periods,
  correcting a missed feasible schedule while preserving native restrictions,
  practical pauses and shared electrical limits.
- Busy database locks no longer hold the main thread for a five-second wait.
  Recording waits asynchronously in a bounded queue and retains original receipt
  times. Commands wait for committed intent, then recheck their authority and
  deadlines. Delayed or failed recording stays visible; restoration duties survive
  interruption.
- Recording and storage now share a compact dashboard summary with consistent
  spacing and separate, actionable problems. Healthy status appears briefly on
  opening the dashboard, then stays out of the way; startup, unknown health and
  problems keep it visible. Initial source checks no longer flash an outage before
  readings arrive, and stale health is explicitly labelled as last known.
- Recent charts load faster by seeking the selected energy history and reusing
  reconstruction work. Chart parsing and preparation run in workers, unchanged
  refreshes avoid full-data comparisons, and short Electricity/Garage selections
  prepare one related view in the background. Loading shows stages and measured
  reading progress; selecting new dates cancels obsolete work while preserving
  the current chart. Caches and background work remain bounded.
- Recording details now has compact, expandable recording, disk and backup
  statuses, one Storage & growth section for size estimates and projections,
  and separate data inspections and history tools. Adaptive measurements retain
  their source folds without repeated storage totals; refreshes preserve open
  details and keyboard focus.
- Recording details separates the adaptive annual target from total database size
  and growth, with dated adaptive size estimates, local disk capacity and backup
  evidence. Low space, failed writes and stalled recording receive a dashboard
  attention notice. Backup triggers remain unchanged; no schedule is added.
- Adaptive recording precision responds only to new adaptive data, so imports,
  exact records, learning history and index growth cannot make it less precise.
  Existing history stays intact; shared database overhead is additional storage.
- Backups, offline restores and saved exports share durable file publication.
  Saved exports now also guard SQLite companion files and flush their destination
  directory before reporting success. Recovery confirmation explicitly means
  history from this household; format checks remain automatic.
- Database restore refuses existing SQLite journal files and dangling companion
  links, and rechecks the destination after copying so concurrent files are preserved.
- Caravan dehumidifier feedback requires each field's native timestamp. An
  aggregate-only snapshot cannot enable controls, confirm a command or create
  measured state history.
- Web requests preserve non-ASCII text when a character spans network chunks.
- Charger 2 can identify Tesla when it draws less than the offered 6 A, provided
  fresh, settled charger and Tesla current/power readings match uniquely.
  Joint BMW assignment still requires BMW's own positive charging episode.
- Home schedule searches run in a bounded background worker. Results are checked
  against current evidence and control ownership before adoption, keeping local
  timers and requests responsive during larger searches.
- Home learning rejects control-only temperature estimates at the journal and
  learner boundaries. Heat-reserve estimates include covered heating before a
  room goes missing and cannot advance through source gaps. The updated learning
  algorithm requires a deliberate fresh development database; previous journals
  are rejected before mutation, with no automatic reset or migration.
- Economic preheat requires evidence for its requested ROOM increase and respects
  the current duration limit. Trial budgets include lost income during negative
  prices. Away consistently relies on native heat-pump protection, with occupied
  comfort limits resuming for the configured return.
- Plan & possibilities includes the starting indoor temperature in extrema,
  shows missing uncertainty explicitly, explains provisional comfort limits and
  retains control-estimate provenance. Delayed device acknowledgements cannot
  renew expired or revoked one-cycle approval.
- Unreadable or malformed heating-control state stops initialization without
  discarding restoration duties. Saved manual choices retain valid equipment
  ownership and expiry; incomplete native-setting obligations cannot be mistaken
  for external edits. Retired manual baselines cannot reactivate an earlier
  automatic reduction after a manual override ends.
- Home initializes an approximate normal-temperature reference after one supported
  hour of heating demand, then refines it gradually through ordinary Normal
  operation. Short reporting gaps pause learning without erasing progress.
- Home comfort uses one configurable indoor average. Automatic membership uses
  configured rooms with Bedroom weighted twice as much as Upstairs or Downstairs:
  50% / 25% / 25% with all three configured. These weights stay fixed during sensor
  outages. Individual room vetoes and rare stable-plateau qualification are removed;
  model and equipment readiness remain independent.
- A bounded, explicitly labelled estimate can bridge one unavailable room from
  the movement of the other two. Extra uncertainty constrains control; estimated
  temperatures never train the model or fill measured history. These changed
  learning semantics require the current SQLite schema and a deliberate fresh development
  database. Incompatible databases are rejected before mutation; supported v0.7.5
  CSV files may be reimported. No installation database is reset automatically.
- Charger 2 keeps recording available current while a device command awaits
  confirmation. Acknowledged current-setting changes can recover from a trailing
  device clock using ordered native readings and fresh readback, without retrying
  the write, weakening Start/Stop checks or filling historical gaps.
- Already configured Easee Direct OCPP charging no longer requires fresh Easee
  cloud replies for local approval, scheduling, Charge now or session recovery.
  Known later external instructions retain priority through outages; missing
  cloud data remains unknown. Initial setup and clearing a confirmed native
  zero-current Pause can still require Easee's cloud service.
- Local OCPP transaction handling now tolerates the charger's bounded clock
  lead, waiting for the original timestamp before accepting the event instead
  of rejecting an otherwise valid transaction.
- An idle or fully charged car no longer reserves the other charger's
  identification test indefinitely. Native permission holds and settled zero
  draw are handled separately from active tests; preparation waits are bounded,
  while test deadlines, native instructions and restoration remain in force.
- Slave dashboards consistently identify recorded snapshots across electricity,
  prices, vehicles and temperatures/weather, with original report times and
  explicit missing data. Saved circulation and Garage sender evidence remains
  visible without claiming live device availability.
- Circulation uses the standard equipment availability indicator and report
  time, and consistently identifies its Shelly connection.
- Shelly relay commands confirm correctly when a newer matching status
  notification arrives before the command readback. Newer measurements retain
  their timestamps; contradictory reports still prevent confirmation.
- Pairing shows equipment-definition mismatches explicitly, with guidance to
  run matching builds and configuration; handover errors stay visible after refresh.
- The Garage protection sender connection shows its actual live report status
  and preserves the last report time when unavailable. Circulation identifies
  its native Shelly integration consistently.
- Both charger allowances remain visible and recorded with no car plugged in.
  Charger 2 shows current available capacity without applying an instruction,
  preserving connected-peer commitments and existing historical gaps.
- Charger 2 current allocation uses each healthy feed's latest valid measurement
  immediately. The measurement-pairing hold is removed; independently timed
  reports can temporarily overestimate or underestimate household headroom.
  Source-health checks, fallback, native limits and command confirmation remain.
- Hot-water circulation uses a direct Shelly 1PM Gen3 connection with native
  relay confirmation and power feedback. Timed shutoff, restart restoration and
  device identity checks remain; the old raw MQTT command route and SmartThings
  power forwarding are removed. Configure the relay prefix as `stmq/home/dhwr`.
- Charger cards expand with a chevron beside their title. The compact footer
  keeps charging status and available-current or fallback allowance visible
  alongside action feedback, with a distinct **Session report · Open ↗** button.
  Battery readings use separate source and timestamp lines, preserving measured
  versus received times and full provenance in their information details.
- Planned starts awaiting approval stay within two lines, and native current
  settings no longer repeat their label.
- Charging currents replaces the dedicated session-check view, with the highest
  property phase current and both charger allowances. Fallback is a separate
  purple dash-dot line. Charger 1 session checks remain in All series; the old
  Shelly load-balancing strips are removed.
- Both allowances use compact change-only history with explicit fallback status
  and original source evidence. Charger 1 allowance history now records whenever
  its Easee integration is configured, independently of Automatic scheduling.
- A fresh database uses the first valid voltage reading for each phase immediately,
  then smooths subsequent readings. Voltage and reconstructed-current charts no
  longer wait for an hour of voltage coverage; missing or invalid phases stay unknown.
- Recording inventory now describes all current checkpoint and event writers,
  including voltage estimates, Caravan controls, paired MQTT source context and
  Home heating permission/pause changes.
- Charger energy figures keep their number and kWh unit on one line at narrow
  widths without stretching the card vertically.
- SQLite schema 22 replaces the earlier voltage maturity contract and Shelly-only
  history format; incompatible development databases require an intentional fresh
  start and are never migrated or reset automatically.

## 0.9.5-dev.4 — 2026-10-05

### Added

- Home Assistant configuration includes a compact guide for copying Ubuntu
  settings for pair mode, with local field guidance and import merge behavior.
- Optional `mqtt.ha` broker access routes TeslaMate, BMW CarData, garage doors
  and the Tuya dehumidifier bridge together, without per-device selectors.
  Unset installations keep one broker connection; an HA outage leaves
  independent primary equipment connected and never reroutes commands.
- Optional charger development observers, an offline physical-evidence auditor
  and a focused hardware-test runbook make selected feature checks repeatable.
  Routine tests stay offline; private installation recordings stay outside Git.
- Shelly load balancing has a current-status badge and a compact history strip
  below electrical charts. Inspect allowance, fallback reasons and charger
  confirmation by pointer, touch or keyboard. Only changes add state records;
  missing coverage remains unknown, independently of session-report expiry.
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
- **Reset pairing** offers **Keep local history** or **Start fresh** from the
  paired dashboard, including protected startup failures. Both archive the
  previous pairing files; Start fresh also archives local databases and snapshots
  before returning as a slave. Archives remain until manually deleted and are
  accessible through Home Assistant's app-configuration folder. Retained history
  stays protected, and neither choice automatically promotes the computer.

### Changed

- Recovery checks show both computers' history dates by category, recorded
  energy gaps and potential source coverage, without a trial import or
  model rebuild. Rejoining retains the other computer's original inactive
  database, including records that recovery does not import.
  Availability notifications appear in separate grouped diagnostics; single
  reports show unknown duration instead of being labeled zero-second outages.
- Adaptive recording keeps one row per known measurement with storage frequency
  immediately visible. Expand source history for older recording identities;
  historical source status is distinguished from current acquisition.
- Valid recorded energy remains usable inside another source's explicit outage
  period. Outage evidence stays retained, uncovered periods remain unknown and
  genuinely overlapping measurements remain conflicts.
- Paired computers now uses role-aware connection and mirroring messages,
  verified MQTT listener status and actions aligned with the shared history
  recovery window. Recovery comparisons and completed results describe only
  the actions actually available. Dashboard button labels omit trailing ellipses.
- Charging setup now groups charger device information, reported firmware,
  connection setup, vehicle feeds and documentation in Data & settings.
  Charger cards keep session schedules, readings and controls, with direct
  navigation to setup. Charging documentation separates user guidance, policy,
  implementation responsibilities, integrations and optional physical testing.
- Shelly current adjustment defaults on independently of Automatic scheduling,
  including Charge now. Healthy synchronized Easee feeds can retain unchanged
  older values, and current Shelly status readback can confirm unchanged readings
  without expiring them solely because their value-update clock is over 15 seconds
  old. Shelly uses
  0 or 6–16 A with priority sharing; unusable feeds select the configurable 12 A
  fallback cap, still respecting known lower limits. Charger 2 priority excludes
  Charger 1's draw; Equalizer must yield. The limiter needs no Shelly phase map,
  while recorded phase association remains configured.
- Shelly applies the planner's priority, energy-request and ready-by allocation
  policy to actual household headroom, including during Charge now. Forecast
  household demand no longer reserves capacity a second time. Charger 1's momentary draw and
  Equalizer response delay no longer redistribute its entitlement. Shelly reduces
  for property protection only when household demand plus Shelly alone exceeds
  the effective phase limit; it leaves excess that reducing Charger 1 could
  remove to Equalizer. Balanced allocation is not necessarily 50/50.
- The owner-approved F3 amendment removes the Equalizer allowance/native-budget
  comparison, its held references and comparison-settling state from Shelly's
  live limiter. Property and charger measurements determine household headroom
  against configured limits. Retired `agreementToleranceA`,
  `additiveCurrentVerified` and `maxSkewMs` configuration fields are rejected.
  Genuine source outages, native restrictions and command confirmation retain
  their separate protections.
- Separately arriving property and charger changes hold the previous validated
  ceiling, capped by the confirmed native setting, until the observations can
  be paired. The badge shows unknown headroom during that wait; no response
  deadline makes Shelly take over from Equalizer. Healthy unchanged cloud values
  remain usable without a new change timestamp, while real feed loss still
  selects fallback.
- Per-phase `marginA` accepts signed calibration values. A negative margin
  intentionally increases the effective `mainFuseA - marginA` budget without
  changing the declared physical fuse rating or native protection.
- Shelly load balancing no longer treats a current setting carried into a new
  physical connection as a permanent limit. A later external current choice
  retains precedence for that connection across restart and MQTT reconnection,
  until unplugging or explicit **Use automatic**. Confirmed controller writes
  remain owned settings. This owner-approved F3 amendment leaves hardware,
  electrical and vehicle restrictions binding and keeps current adjustment
  independent of the Automatic scheduling switch.
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

- Home Assistant deployment compares stored-file sizes and modification times
  without reading database or backup contents, so file size does not increase
  verification work. Saved settings, source and image contents retain full
  comparisons; storage metadata checks do not prove byte-for-byte preservation.
  Metadata inventories allow up to 15 minutes with progress every 30 seconds.
  Verification errors
  identify the failed step and distinguish an already completed rebuild.
- Home Assistant deployment accepts a manually stopped app that Supervisor
  still reports as `error` only with fresh Docker evidence of an absent or
  exited container at every checkpoint. Initial refusals report app preflight
  and no remote changes; rebuild warnings depend on an actual submission.
- Charger 1 can begin its bounded vehicle-identification probe after unplugging
  and reconnecting before the planned charging period. An old disconnect no
  longer leaves the probe waiting for a transaction it needs to start. Native
  restrictions retain priority; profile writes still require a confirmed new
  transaction.
- History recovery validates and inventories its source without a trial import,
  then merges history once after confirmation. Missing, conflicting and skipped
  counts are reported by that merge; model rebuilding runs only when needed.
  Recovery batches release the database and wait for the controller's next turn,
  preventing repeated worker writes from starving normal recording.
  Recovery errors now distinguish database contention, storage failures and
  invalid data instead of reporting an unrelated peer protocol failure.
- Home Assistant deployment refreshes Supervisor's schema and defaults from the
  committed source before rebuilding, then verifies them against the image.
  Saved installation settings and credentials remain unchanged; retired fields
  require explicit correction or reviewed replacement through configuration recovery.
- Configuration recovery detects retired saved fields before Supervisor resolves
  secret references, so filtering cannot hide incompatible settings.
- Updated compatible Moment and IP-address dependencies to their patched releases.
- Paired masters own a dedicated MQTT frontend at the virtual IP and disconnect
  its clients before releasing that address. Fixed HA connections remain open;
  both brokers keep running. Deployment requires freeing host port 1883 for the
  frontend: publish HA's broker on a separate fixed port and bind Ubuntu's broker
  to loopback. Fresh MQTT and OCPP device evidence remains separate from a
  completed role transfer.
- Current paired handovers preserve equipment and vehicle source identities
  across the two broker endpoints, keeping saved control choices, restoration
  obligations and already consumed identification evidence. The verified
  transfer binds current integration definitions and machine-local routes;
  copied state and retained messages grant no new permission or freshness.
- Home Assistant deployment accepts unchanged configuration whose JSON object
  keys were reordered, and identifies failed app checks without exposing private
  settings. Missing or malformed configuration still blocks deployment.
- Load-balancing history records changed decisions when they become visible,
  including while a charger command is awaiting confirmation.
- Native OCPP and cloud scheduling expose the same validated property-current
  source to Shelly. Choosing cloud scheduling no longer creates fallback solely
  because the live supply interface is missing its feed-health evidence.
- Easee reads, command acknowledgements and automatic takeover wait briefly for
  an admitted device timestamp to become current, then recheck the original
  connection and native instructions without repeating a command. Small clock
  skew no longer becomes a cached disconnection or an incorrectly revoked pause.
- Supported Shelly chargers can adjust current when optional UI step metadata is
  absent. Contradictory native capabilities still prevent current writes.
- Shelly allocation uses admitted phase readings without advancing their source
  clocks or waiting for a cached cloud snapshot. Ordinary polls reuse applicable
  plans and avoid unnecessary peer polling. Temporary fallback no longer imposes
  a permanent 12 A ceiling on optimistic future delivery estimates.
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
