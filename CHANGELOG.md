# Changelog

Release notes describe changes relevant to users. Detailed implementation and
validation history is available in Git; unfinished work belongs in GitHub issues.
Versions follow Semantic Versioning. `-dev.N` denotes a development prerelease.

## Unreleased

- Wait for routine standby synchronization in Linux and Home Assistant deployment
  preflight and before stopping, with a timeout and continuous safety checks.
  Also wait if synchronization resumes during HA's final readiness check.

- Discover relocated completed reset archives without rewriting their manifests
  or relaxing reset-resumption checks. Describe preserved raw history without
  portable backups separately so it does not produce a false incomplete listing.

- Keep a saved copy's verification failure reason visible during and after a
  download, independently of its transfer receipt.

- Detach the Garage adapter without opening an empty transaction, so a settling
  recording save cannot interrupt controller shutdown or paired handover.

- Mark held chart range edges and freshness endpoints as display boundaries,
  preserving the original reading time instead of implying a new measurement.

- Keep native charger meter increments distinct from power-based energy estimates
  in Charging comparisons, including mixed evidence. Update chart-explorer help
  and name retained-history stages during complete inventory measurements.

- Bind Linux setup and HA setup promotion requests to the freshly reviewed
  computer identity required by the current pairing API.

- Name the exact lock location in Linux setup/deployment, HA setup/deployment and
  live-test runner errors. Keep HA lock refusals visible through setup, distinguish
  existing locks from creation failures, and identify retained locks and workspaces
  after uncertain operations without exposing command output or removing locks.

- Keep explicit promotion available after an interrupted handover when the backend
  admits it. A retained role-change marker no longer disables recovery forever;
  active operations and the stopped-or-isolated-master confirmation still apply.

- Restore breathing room inside outer cards and windows while retaining smaller
  nested fold indentation. Adjust both spacing levels for narrower screens.
  Energy cost comparisons now initially select Last 7 days, matching Energy checks.

- Confirm paired operations automatically with read-only requests to the original
  computer after reconnecting or reloading. Remove the action-resubmission button
  and reject actions reaching the wrong computer, preventing an unintended reverse
  handover during upgrades. Preserve newer source history after an interrupted
  handover and report local shutdown failures with useful, private-safe diagnostics.

- Find the existing user systemd bus for Linux setup and deployment from terminals
  without session variables. Report an unavailable manager separately from service
  mismatches, preserving explicit session settings and all deployment checks.

- Identify the failed Linux deployment service checks instead of reporting one
  generic mismatch, while keeping private service values out of errors.

- Separate chart drawing from assessment requests so live model checkpoints do
  not reconstruct unchanged historical plots. Assessment results and evidence
  still refresh after model changes and corrections.
- Show continuous, equipment-scoped Garage Normal/Away intent across later days.
  Preserve the original selection time, distinguish saved intent from device
  readback, and leave unrecorded or disabled scopes blank.

- Include the year when inspecting chart activity, identify saved floor-control
  evidence as GPIO output feedback, and keep settings and aggregated-activity
  explanations accurate with the selected display options.
  Individual-series charts skip unrelated temperature history while preserving
  the selected readings and price context.

- Explain future Fireplace selections without a false cache failure, distinguish
  unavailable estimates from provisional ones, and show comparison loading stages
  while keeping retained results visibly stale through failed refreshes.

- Keep Home's comparison method when visiting Garage or Total, identify missing
  charger contributions in combined timing results, avoid claiming an estimate
  for unavailable Garage evidence, and fit comparison dates on narrow screens.

- Skip sudo and unnecessary virtual-IP helper restarts during user-service Linux
  deployments when the installed helper matches the prepared release. Request
  authentication before stopping the application when a helper update is needed;
  system-service deployments retain their existing privilege requirements.

- Explain when reset archives prevent a complete backup listing and retain the
  instruction to preserve those archives for inspection.
  Keep the storage outcome summary separate from slow-operation timings; an
  absence of recorded failures does not establish responsive operation.

- Explain admin-only history tools in Recording details and keep an unread
  database-verification schedule unknown instead of claiming it is disabled.
  Describe database-copy receipts, derived-cache proofs and remembered browser
  sessions in the recorded-data inventory without exposing their contents.

- Add an interactive Ubuntu installer for standalone and paired operation, with
  whole-file private configuration, prerequisite and broker provisioning,
  restricted VIP helpers and optional reviewed HA setup over SSH. Start and
  enable the installed service, preserve current history and authority, and
  verify application readiness before reporting success.

- Standardize deployment paths and service names on `st-mq`. Linux setup examples
  generate private files with resolved home paths, Node executable and `$USER`
  for system scope. Document fresh setup and routine updates, and keep the
  separately installed VIP helper independent of application storage modules.

- Align HA and Linux deployment: both normally verify a running paired slave,
  prepare, stop, deploy, restart and wait for synchronization. Both offer
  `--stopped` for an already stopped target, leaving it stopped without lifecycle
  commands. Preserve existing HA source/image and stopped-window storage checks.

- Add repository-managed Linux standby setup and deployment, with persistent
  user/system services, staged builds and verified synchronization. Document the
  complete Linux–HA update sequence with explicit handovers and preserved state.

- Rename the chart shortcuts to Yesterday + today and Today + next 2 days;
  the latter now shows three Finnish calendar days.

- Preserve prepared firewood history when logging a new fire or advancing time.
  Reuse unchanged simulations across model-report updates while restarting
  independent validation at the actual training boundary. Genuine numerical
  changes and historical corrections still prepare affected history in the
  background; source proofs and cache-size limits remain enforced.
- Avoid repeated searches through live indoor history when no new CSV learning
  is available. Keep temperature fallback reads and historical voltage selection
  focused, and skip unused CSV voltage assumptions in household forecasts.

- Add Today to the shared date calendars, align recorded-energy period shortcuts
  to the right, and set the end date to each newly selected start date in charts
  and energy cost comparisons without dimming the end field.

- Recover supported Shelly SYS startup interruptions with bounded retries and
  separate scheduled/Charge now budgets. Fresh Charge now supersedes an earlier
  SYS hold; confirmed failure returns it to Automatic through the normal OFF
  action. Session reports retain SYS transitions, retries and observed recovery
  with firmware context, including successful workarounds. Compatibility policies
  are isolated for later removal after firmware qualification.

- Keep the dashboard, saved heating choices and independently qualified manual
  controls available while a missing Home model cache is reconstructed. Show
  rebuilding explicitly, continue expiry/restoration, and wait for the complete
  committed model before automatic heat optimisation.
- Resume firewood comparisons from sparse, disposable thermal checkpoints and
  household-load forecasts from a compact persisted reference. Cache loss or a
  changed model prepares history in the background. Preserve seasonal evidence,
  corrections and unknown overlapping energy; completed idle reads do not repeat
  preparation or source-proof publication. Durable prefix proofs survive ordinary
  journal trimming.
- Keep valid idle charger energy compact across long connections. Close other
  adaptive energy groups at accepted acquisition boundaries after a day,
  preserving exact energy and unknown quality while bounding routine forecast
  updates during steady or unavailable readings.
- Bound routine manual-firewood reads with physical schema 34's revision, load
  and removal indexes. Source rows and journal interpretation stay unchanged;
  adopting this schema needs a coordinated backed-up installation conversion or
  a deliberately fresh development database, with no startup migration.

- Keep recent history and charging-energy reads responsive as older recordings
  accumulate, and prevent temperature-report changes from failing on a large
  database. Chart coverage seeks the selected period; retrospective firewood
  history reads yield between bounded pages so recording and control can proceed.
  Fireplace rebuild checks seek the current learning epoch instead of scanning
  other environments' retained samples during dashboard refreshes.
  Household forecast refreshes seek future source and receipt clocks separately.

- Fit energy-check dates and shortcuts into the recording fold, shorten the
  completed-check status, and show the latest property meter reading once in
  its comparison row.

- Keep Sonoff GPIO readback available through an isolated failed monitoring poll
  until its original freshness deadline. Actual disconnects, invalid feedback,
  hardware faults and expiry still show unavailable immediately.

- Use one smaller horizontal inset across dashboard folds, cards, warnings and
  windows at every screen width. Remove stacked margins and padding, align
  recording health rows with the compact equipment style, and keep more room
  for content on narrow screens in every operating role.

- Simplify Recording details headers and inventory issues, align every nested
  fold with the shared indentation, and improve tablet measurement layout.
  Recorded energy checks use their own Finnish date period, defaulting to the
  last seven days, with explicit refresh and no animated refresh bar.
  Storage history explains counted failures even when individual dates are missing.

- Fix a dashboard refresh error after opening the app or changing snapshots.
  Refresh energy checks through their current controller when the source changes.

- Open recorded-data descriptions without scanning the whole database. Measure
  complete counts and allocation with a shared background job, progress and
  cancellation; energy checks run independently and retain dated complete results.
  Browser timeouts and leaving the page no longer discard accepted work.
- Organize recorded data and History tools with consistent actions, status,
  progress and evidence. Rename the model audit **Check saved learning** and
  group its detailed results in a secondary fold.

- Load energy cost comparisons without preparing unused chart geometry or
  reading property-energy drawing data. Keep the same original-interval energy
  and cost calculations, and reduce energy-row decoding overhead for charts.

- Reopen a paired computer's HTTPS listener when enabling it again with the
  same saved peer certificate. Keep listener activation failures visible and
  preserve the certificate identity and generation.

- Load energy cost comparisons only while their panel is open. Closing cancels
  unfinished reads while retaining dates, selections and mounted cards; reopening
  checks the latest source evidence. Label coefficient series as recorded history.

- Record all four coefficient histories with committed learning in the main
  database, so every coefficient chart loads directly without reconstruction or
  preparation controls. Include the selected history in backups and mirroring;
  corrections, recovery, revert and restore select it together with the model.

- Add **Check saved learning** under History tools to independently
  reconstruct and compare the complete saved model and all four recorded
  coefficient histories at one fixed boundary. Local jobs support pause, resume,
  cancellation and discarding their temporary files on master or slave. The check
  reports model and history agreement separately, never repairs source data, and
  does not need to run for charts to work. A pruned transaction proof leaves a
  completed result's applicability unconfirmed instead of marking it outdated.

- Preserve the current legend or footer keyboard focus when a chart redraw
  finishes, including when focus moved during geometry preparation.
  A resize or detail redraw cannot leave interpolation controls and notes behind
  the displayed plot.

- Explain that a dehumidifier On request blocked by native restart protection
  was not sent, instead of presenting its delivery as uncertain.

- Recover a Caravan power check interrupted by controller shutdown after native
  power restoration and fresh stable reports. Preserve five-minute restart waits
  and latched failures when the meter does not confirm the physical switches.

- Restore recent Garage Normal/Away action reports after reload or restart.
  Keep rejected selections visibly rejected when the pump already has that target.

- Restore the latest circulation Stop report after reload, let a newer Start
  replace it, and keep a completed run's confirmed report through OFF feedback.

- Preserve separate manual-heating and circulation action reports across page
  reloads and application restarts. A circulation action no longer hides the
  previous heating report.

- Keep a heating request rejected before dispatch visibly failed when a later
  device report happens to match it. Show that current report separately;
  uncertain deliveries can still receive late confirmation.

- Release circulation-only recovery after the pump's confirmed OFF state is
  committed, so a completed run cannot leave later heating selections blocked.
  Preserve separately held heating choices and other restoration duties.

- Correlate a Shelly current change's same-second notification when it arrives
  after acknowledgement, so the controller's own write cannot become a false
  external current ceiling. Preserve later native choices and original clocks.

- Clear a charger's earlier Pause confirmation after that pause is superseded
  or its physical connection changes. Temporary feed loss still preserves the
  receipt for the same saved pause.

- Stop reporting an unchanged Garage Normal/Away selection as an out-of-date
  device. Preserve the original selection timestamp; actual
  heat-pump and sensor freshness warnings remain independent.

- With the updated Garage protection sender, accept independently fresh probe
  reports without the former 65-second timestamp-alignment restriction. Preserve
  individual freshness limits, actual pipe-risk protection and Bluetooth
  freshness safeguards. The heat-pump controller script and mapping need no update.

- Keep the **Heating pump active** chart bar continuous while fresh reports
  confirm an unchanged state, including in cached views. Preserve actual
  reporting gaps and OFF states.

- Add an optional **Keep me signed in for 360 days** choice for HTTPS access.
  Keep the checkbox and label aligned on phones, with a complete touch target;
  hide the option on HTTP. Preserve the choice and restore editing after a
  rejected password, and prevent duplicate submissions while signing in.
  Its fixed expiry never renews with activity. Remembered logins survive restart
  and paired handover, and can be revoked by logout, password changes or the
  administrator's **Sign out remembered browsers** action.

- Keep **One extra day** available when the other charger is paused or idle and
  reports residual standby current. Active and native-scheduled peer charging
  remains part of the shared cost and capacity comparison.

- Restore green availability dots with neutral labels in MQTT and equipment
  status, use content descriptions consistently in connection setup subtitles,
  and omit repeated charger notices while keeping their explanations available.

- Recover native OCPP power, current and voltage while an idle charger supplies
  only clock-aligned reports. Request bounded fresh native samples without
  treating interval values or acknowledgements as instantaneous evidence, and
  let charging commands preempt a delayed background sample request.

- Use the same HTTPS address for an installed phone web app at home and through
  Tailscale, without host subnet or exit-node changes. Show remote forwarding
  status separately in Web access.
- Show **Needs attention** for an enabled price forecast that is unavailable or
  out of date, consistently with other data sources and the prices overview.
- Give each new manual Normal or Reduced selection in Automatic its own
  reassessment window. Use fresh native settings after Preheat restoration and
  explain native confirmation failures without hiding their cause.
- Keep manual heating buttons disabled until the controller's current transition
  finishes, including the status refresh after a successful selection.
- Keep the latest manual heating result visible when a status refresh still
  contains an older failed request.
- Wait for actual Normal tariff relay feedback when switching from Reduced to
  Preheat, before verifying ROOM and applying its temporary increase.
- Reassert and confirm the native baseline after an uncertain temporary write;
  an earlier baseline reading can no longer clear its restoration duty.

- Use consistent charging activity, target completion and status explanations on
  both charger cards and recorded standby views. Distinguish reported and estimated
  completion, show a normal completed charge ahead of its native permission hold,
  and keep faults, uncertain instructions and temporary-setting recovery visible.

- Confirm Normal tariff control and a new normal ROOM report before Preheat,
  preserving user changes and the correct restoration baseline through reduction
  and restart. Keep floors off while preparing and cancel unresolved requests.
- Give all four native heat-pump settings a separate dispatch and readback window.
  Settle late confirmations consistently, clear obsolete timeout messages and
  preserve original override deadlines without automatically repeating native edits.

- Compare cheaper one-extra-day charging options after charging starts. Preserve
  the current period's minimum run while optimizing later delivery, and use the
  same commitment when an allowance is approved.

- Prevent brief Charger 1 energy-recording gaps when slightly early local meter
  readings finish admission. Keep acquisition on the local connection through
  that save, preserving genuine outages, source clocks and charging safeguards.

- Let both chargers start their bounded vehicle-identification test before an
  initial power reading arrives. Preserve the original energy/deadline limits,
  require measured evidence for identification, and retain native current
  preparation and stopping/restoration checks.

- Calculate one-extra-day charging savings automatically, using the normal
  planner's material-change thresholds and bounded worker. Refresh meaningful
  tomorrow-price changes, reuse completed estimates across browsers and retain
  dated estimates through temporary refresh failures. Match circulation-pump
  availability text and tariff-control links to the shared equipment styles.

- Keep history indicator bars filled according to their recorded coverage at
  every zoom. Preserve continuous Normal, Garage power and Caravan states,
  summarize dense changes across the full period, and retain genuine gaps.

- Open chart details only after a touchscreen tap, without popups during dragging
  or pinching. Match Garage rear/front labels on the read-only computer, order
  Home equipment consistently, and keep dehumidifier humidity beside its status.

- Keep a configurable 0–14 day chart window in RAM, updated incrementally at idle
  priority. Preserve it during long history requests, reuse energy reconstruction
  between views, retain completed plots across unrelated new readings and compress
  chart responses. Keep caches through verified incremental mirror publications,
  including while archive responses finish. Remove navigation-based companion fetching.
- Reduce repeated voltage/energy reads on cold charts, use a 1000-frame managed
  checkpoint trigger and avoid redundant durability barriers in private mirroring
  scratch work. Preserve FULL source commits and final transfer publication.
- Allow twenty seconds for MQTT startup subscription admission and report explicit
  admission failure promptly.
- Release certificate-manager ownership automatically on process exit or crash,
  preventing reused container PIDs from blocking HTTPS after a restart. Show
  actionable lock errors while preserving saved certificates and helper identity.

- Keep successfully identified vehicles and their battery planning references
  through inconclusive shared charging starts/stops in the same connection,
  including after restart. Continue to withdraw identities on clear contradictory
  evidence, without identifying an unknown peer from an existing label.

- Recover charging opportunity when changed capacity or progress makes an
  accepted economic pause threaten ready-by. Remove avoidable pauses even when
  the full target is no longer recoverable, retaining the visible shortfall and
  native control checks. Keep accepted charging periods visible during forecast
  reassessment and target risk.
- Preserve distinct Shelly charger changes that share one device timestamp,
  preventing a stale pending change from blocking control indefinitely. Require
  fresh native readback of the final value and retain original evidence clocks.
- Allow BMW's own identification confirmation pause beside an identified Tesla
  under a confirmed economic pause, preserving fresh zero-current evidence,
  connection scope and independent BMW matching requirements.
- Keep fractional simulated completion times out of native schedule boundaries
  so both chargers can accept the jointly selected program.

- Align Storage health with the shared storage queue and separate WAL checkpoints.
  Show the running writer's actual policy, current background turn, all three queue
  lanes, transaction-building time and independent checkpoint timings. Keep
  background failures separate from failed saves, preserve dated frame evidence,
  and retain the local scope of standby diagnostics without adding recorded data.

- Keep an active charger identification attempt running when an older queued
  vehicle report is processed after newer native readback. Evaluate current
  charger readiness at processing time while preserving original report clocks,
  energy allowances and probe deadlines.
- Recheck heating control preparation age after writer admission so storage
  contention cannot resume an expired preparation. Retain committed learning
  progress and take a fresh control view before continuing.

- Calculate live heating samples and learning in a worker between short storage
  transactions, allowing urgent saves to proceed during fitting. Recheck changed
  control inputs before dispatch and retain exact replay and correction publication.
  Rebuild a startup view invalidated by source recovery before publishing it.
  Confirm Home Automatic and Pause only after their updated view is ready.
  Keep the last complete status readable while a replacement view is calculated.

- Give controller saves priority between bounded mirror and history-read steps.
  Coordinate runtime WAL checkpoints separately from commits, targeting 50
  outstanding frames while retaining FULL durability and atomic peer publication.
  Native queries and file synchronization still have no hard duration bound.
  Cancelling a chart releases its storage reservation after worker termination.

- Keep clock-aligned OCPP interval reports separate from instantaneous charger
  measurements so they cannot cause false telemetry loss during identification.
  Retain genuine measurement and transaction conflicts, source clocks and probe limits.

- Limit SQLite journal-reversal and recovery-energy indexes to the records their
  queries need, reducing recording write amplification. Physical schema 32 keeps
  the same journaled data/hash layout; incompatible development databases still
  require an explicit fresh start or a separately approved installation action.

- Reduce charging-history and storage work by omitting routine input-processing
  events, keeping disconnected progress stable, and projecting active report
  summaries from their current checkpoints. Retain schedules, prices and forecast
  provenance without repeatedly saving or serving candidate scenario vectors.

- Coalesce unchanged heat-pump and voltage recorder metadata within 30 seconds.
  Value and quality changes, real gaps and accepted energy remain immediate;
  normal shutdown flushes the remaining metadata. Recovery, revert and restore
  keep confirmations immediate while assessing and publishing history changes.

- Reorganize Storage health around current activity, dated problems and grouped
  diagnostics, with one history period selector and separate monitoring coverage.
  Retain earlier local-task failures after later successes, and track database
  saves and downloads through final publication, transfer and cleanup.

- Identify Tesla during ordinary charging without requiring an extra-energy probe
  or a test on the other charger. Preserve healthy current and power reports while
  fresh measurements establish settling, retaining source clocks and probe limits.
  Increase the extra identification charging allowance to 0.30 kWh so the existing
  deadline calculation leaves more time for vehicle startup and matching.

- Reuse verified immutable heating checkpoints during unchanged controller updates,
  avoiding repeated full-model hashing and rollback copies while preserving replay.

- Reuse bounded recorded charging-energy cohorts between views and refresh the
  affected tail when evidence changes, preserving gaps, corrections and source clocks.

- Read Shelly's discovered control and physical components in two independent
  batches plus its schedules, reducing each ordinary round from eight requests
  to three while preserving source clocks and fresh command confirmation.

- Preserve explicit charging takeover after an uncertain native command expires;
  commands still in their active window keep takeover unavailable.

- Stop saving duplicate Shelly acquisition checkpoints for unchanged polls while
  retaining fresh live readback, native changes and restart safeguards.

- Avoid repeated session-report events for idle input processing while preserving
  current readiness, actual device changes and meaningful allocation evidence.

- Compute each published charging view once for diagnostics, physical assessments
  and storage, avoiding repeated reads of the same energy history.

- Withhold Shelly takeover while an accepted current setting still needs native
  readback, so the controls do not advertise a token that is already changing.

- Reuse Shelly's completed notification readback for its following reconciliation,
  avoiding a duplicate native read round while retaining fresh-read fences.

- Keep Shelly Pause available while fresh committed connection evidence remains
  healthy and a native reply awaits admission; commands still wait and revalidate.

- Complete Shelly's confirmed idle-current return when an unrelated native
  reply briefly awaits storage, retaining fresh input and instruction checks.

- Route shared-client MQTT messages only through their owning receiver, avoiding
  duplicate writer work and heating-state copies for native charger traffic.

- Preserve checkpoint-worker and publication-guard cancellation reasons so
  interrupted work does not falsely classify an intact paired replica as a
  verification failure.

- Coalesce background planning while vehicle observations await durable
  admission, avoiding fallback/recovery searches for unchanged readings. Copy
  only public charging-report fields when preparing dashboard summaries.

- Reduce charging planner CPU use with exact allocation reuse, a flow-guided
  bounded search and meaningful-change admission. Keep accepted programs through
  unchanged reporting; require more than 5 cents to replace ongoing charging or
  1 cent while waiting. Preserve 15-minute charging windows with 10-minute minimum
  economic pauses and absolute price-slot boundaries.

- Calculate extra-day comparisons on request, show the actual approved program
  for active allowances and keep Web access status inside its details. Align
  hot-water circulation availability with neighboring equipment.

- Reduce CPU and memory use when reading and saving charging state by reusing
  unchanged plans and forecasts, while preserving scheduling, rollback and
  recorded history.

- Preserve native confirmation of an acknowledged Shelly charging command while
  received input waits for storage, without allowing another command through that
  admission hold.

- Let either charger's bounded probe identify Tesla from unique measured current
  and power without requiring a charger 2 test; retain the joint 6 A and BMW
  evidence requirements.

- Report an unsent Shelly relay command's witnessed recording deadline as
  waiting for storage, while keeping dispatched readback outcomes unconfirmed.

- Align floor-controller and heat-pump availability labels with other devices.
  Keep floor output status, timed controls and release recovery together in Home;
  separate installation guidance and hardware details from live operating state.

- Commit the first complete controller view before startup finishes when MQTT
  source recovery invalidates the earlier view during provider initialization.

- Extend Storage health to both charging adapters, floor and Caravan commands,
  Garage protection setup and storage-blocked control requests. Show separate
  local storage-job outcomes, durations and monitoring coverage, including
  backups, rebuilds, queries and publication.

- Keep a forecast target-risk warning in charging attention details when
  charger control is unconfirmed, alongside the reported control problem.

- Retain a precisely correlated late floor-acquisition capability for release
  recovery while keeping the timed-out action failed and requiring fresh readback.

- Keep explicit charging takeover bound to its initial published plan, preserving
  newer native current choices and charger limits.

- Recheck received-input storage before floor-valve MQTT dispatch so a newly
  pending observation cancels an unsent lease command.

- Complete an accepted Shelly charging-period pause while a replacement plan is
  still calculating, retaining native instruction checks and confirmed idle
  current fallback.

- Account for small positive charging-energy slices so rounding near completion
  cannot leave planning repeatedly advancing without reducing the request. Keep
  the first minimum-completion time when native post-target demand continues.

- Release a charging takeover reservation when its intent save rolls back,
  allowing a fresh action without clearing a newer takeover.

- Restore Shelly **Use automatic** and **Charge now** with the dedicated writer,
  preserving saved intent and native-input checks before any charger command.

- Integrate the four-output floor controller with bounded local leases, confirmed
  GPIO feedback and durable release recovery. Add individual timed circuit
  controls to Home and rebuild floor setup around connection, commissioning,
  circuit status and thermal assumptions. Physical commissioning remains required;
  output readback does not measure valve movement or water flow.

- Avoid unnecessary writer-lock attempts while scanning recovery history when
  no temporary entry needs removal. Actual deletions retain normal transaction
  and journal protection.

- Refresh historical energy cost comparisons when recovery publishes a new
  history selection, discarding cached results and late replies from the previous
  selection while preserving the chosen period and controls.

- Recover validated pending electricity intervals from paired journal history
  without failing on the source's temporary views. Preserve original energy,
  timestamps, conflict checks and local controller state.

- Seek chronological recording-coverage boundaries through an immutable index,
  preserving recovery and historical timestamps without loading all retained
  coverage into each chart request. Physical schema 31 retains the current
  journaled data layout; existing installations require the separately authorized,
  backed-up one-time chart-index conversion rather than automatic startup repair.

- Fence paired and SSH replication against a different physical database schema before authority or publication work.

- Include the observed dehumidifier identity in equipment status so **Recheck
  appliance location** can submit the current physical-check scope.

- Adapt the dashboard to asynchronous recording: show when readings come from
  the last saved view, keep storage checks active during pending actions, and
  make unavailable writers visible without misreporting confirmed saves.
  Balance queue and save timings, separate observed outcomes, and show application
  responsiveness with its own monitoring scope. Preserve drafts, focus and
  read-only tools while storage-dependent edits are unavailable.
  Clarify recorded snapshot scope, unconfirmed charger instructions and gaps in
  charging measurements without implying new observations or lost energy.

- Move ordinary runtime SQLite admission, journal sealing and durable commits
  to a dedicated writer thread so slow storage can leave networking and timers
  responsive. Preserve committed reads, ordered callbacks, rollback, shutdown
  and command fencing. Storage throughput and device latency still depend on
  the underlying filesystem and hardware.

- Cancel an unsent dehumidifier protection Off when fresh warm recovery evidence
  supersedes it, preserving the native baseline, later cold protection and any
  earlier command whose delivery is still uncertain.

- Add **Pause charging** beside **Use automatic** on both charger cards, with
  a session hold that survives restart and reconnect and reports whether stopping
  is confirmed. Charge now can explicitly supersede the displayed external Stop
  and supported native schedules while retaining current and protection limits.

- Preserve the dehumidifier's full five-minute physical restart wait through
  forward wall-clock corrections, using original MQTT receipt elapsed time while
  retaining saved native clocks, fresh confirmation and restoration checks.

- Organize Recording and Storage health into activity, source evidence and
  monitored history. Give unavailable sources individual status and timestamp
  rows, separate current backlog from past problems, and show transaction timings
  with nested commit stages on desktop and phones.

- Prepare the next read-only replica manifest before applying synchronized rows,
  reducing the work between database commit and visible publication. Keep
  checkpoint refusals, original source clocks and interrupted-publication recovery.

- Avoid a duplicate completed Shelly read round during unchanged periodic
  reconciliation while preserving independent polling and fresh command readback.

- Include original local reporter clocks in bounded private checkpoint refusal
  diagnostics, preserving unknown timing and the existing read fence and response.

- Distinguish local OCPP listening, socket, durable admission and first-message
  phases in bounded private startup diagnostics. Preserve unknown retry causes,
  existing authority and timeouts without recording private connection data.

- Preserve a later current unsent command queued behind a failed Tuya setting
  write, while discarding that handler's initial failed commands. Keep native
  retries and unavailable feedback unchanged; source loss cannot revive intent.

- Keep Web access action buttons the same height on phones when a label wraps.

- Preserve a current unsent native command queued behind a failed ordinary Tuya
  status read. Withdraw unavailable feedback as before; changed sources, sent
  values and superseded or removed requests cannot supply a replay.

- Request one earlier native status refresh after the supported dehumidifier's
  socket replacement withdraws current fields. Preserve unknown observations,
  original report clocks and late commands through that added read; repeated
  replacement does not create a new refresh loop.

- Distinguish MQTT connection, subscription callback and durable admission phases
  in bounded paired startup failure diagnostics. Preserve readiness deadlines,
  protected fallback and private broker/device data.

- Record bounded private read-only checkpoint refusal phases without changing
  the public response, verified-read fence or single recheck. Preserve unknown
  causes and omit private data from diagnostics.


- Await actual HTTPS fixture operation completion under the test case deadline,
  preserving operation identity and cancellation cleanup during queued publication.

- Clarify Web access guidance using reported hostnames, destinations and ports;
  omit runnable examples for unknown or loopback-only household destinations.
  Align helper metadata and distinguish unknown security status from release
  currency while retaining reported urgent warnings.

- Reuse fresh authenticated certificate-helper status for setup and Retry, confirm
  restrictions without another login or reapplying the bootstrap hostname, and
  preserve unknown release-check clocks in the Web access display.

- Adopt an explicitly renamed Tailscale certificate hostname through Recheck or
  Enable HTTPS, publishing the matching certificate and address together. Keep
  complete generations through storage interruptions and allow forward retry.
- Offer helper installation updates only for eligible newer releases, group local
  helper details separately from release checks, and keep vendor security signals
  distinct from package availability and unknown advisory coverage.

- Resume an already requested HTTPS sign-in after its certificate helper restarts
  and loses the temporary enrollment URL. Keep the saved identity and show startup
  progress; status polling does not repeatedly request login.

- Verify a newer completed read-only publication once when it arrives during a
  viewer refresh, avoiding an unnecessary failed request. Pending publications,
  failed cleanup and repeated checkpoint races remain unavailable.

- Add bounded Tuya native field withdrawal reasons without private data for the
  dedicated dehumidifier profile. Diagnostics preserve existing evidence and
  native control behavior; loading the patch requires a separate Core restart.

- Discard abandoned local OCPP connection handshakes from the pending save queue,
  allowing another connecting client to proceed without obsolete work. Connected
  clients still require durable state admission and current control authority.

- Identify a read-only snapshot checkpoint mismatch in status and recording-health
  responses without exposing native diagnostics. Keep verified-read fencing and
  synchronization behavior unchanged.

- Retain a successful Caravan appliance/meter association across restart,
  handover and brief evidence gaps. Require advancing stable reports before reuse,
  preserve real recording gaps and native restoration, and expose a separate
  physical location recheck. Sustained loss or changed wiring requires a new check.

- Confirm Home Assistant HTTPS installation identity through authenticated
  Supervisor host information when container identity files are unavailable.
  Preserve saved identities on failure. Show the next HTTPS setup action clearly,
  with a current authorization link when available and a useful retry path when
  it is missing. Keep certificate, listener and household DNS checks distinct.

- Repair dedicated HTTPS helper enrollment and reapply its verified network
  restrictions when retrying. Preserve installed identity state on failed setup.

- Keep Web access and Configuration inside Connections & configuration. Use
  compact setup, DNS and renewal disclosures; preserve current readiness beside
  recent action receipts. Center matching fold titles, statuses and markers,
  including Home learning, and keep recording warning badges spaced on phones.

- Reject malformed saved HTTPS manager state before setup can replace it.
  Only a genuinely missing state file initializes a new disabled installation.

- Distinguish a scheduled local OCPP settings check from a cloud check currently
  running. Current local readings remain separate from unchecked setup settings,
  saved retry deadlines and the original confirmation clocks.

- Close incomplete local OCPP connection handshakes during shutdown, so a silent
  connection cannot delay listener release and paired handover. Charger retry
  timing and authenticated control checks are unchanged.

- Add optional trusted LAN HTTPS using native TLS and a private Tailscale
  certificate helper. Keep authenticated loopback recovery and Home Assistant
  ingress independent, with explicit unencrypted LAN HTTP backup and warnings.
  Certificate renewal and authenticated helper updates do not restart control.

- Clear an unchanged owned Easee cloud delay after unplugging even when its start
  has passed, so the leftover native schedule cannot block local OCPP restoration.
  External schedules and failed cleanup keep their existing guards.

- Reject appliance datapoints from a positively failed native frame-integrity
  check before recording a new received setting or field clock. Missing integrity
  metadata remains distinct from a known failed frame.

- Preserve original appliance field evidence when a positively identified partial
  Tuya status packet arrives before its query reply. Delayed complete replies
  still withdraw omitted fields, and ambiguous or shared-source correlation
  remains fail-closed.

- Admit an already-ready source report after a delayed database writer instead
  of treating that delay as an expired future timestamp. Original measurement,
  receipt, freshness and connection checks remain intact; a timestamp that is
  still ahead retains its bounded wait.

- Preserve connected native Easee session references when native-control
  deactivation to cloud cannot prove the same separately admitted backend boundary. Cleanup waits
  without discarding profiles or duties; a confirmed disconnect still permits
  exact owned-profile cleanup before `OcppOff`.

- Provider shutdown and request deadlines cancel held response bodies after
  headers arrive, including on Node 22 after garbage collection. Cancelled
  partial data and command replies remain failures with their original error
  classification.

- Native Easee setup checks its actual target scope and saved session boundary
  before cloud cleanup. Disagreement or unresolved scoped references preserve
  the current cloud program and separate local ownership without inferring a
  physical replug or transferring control authority.

- Avoid repeatedly preparing cloud charging delays that are already shorter than
  the supported pause. An applicable confirmed program keeps its original
  release, while a positively unsent replacement is cleared without losing
  genuinely uncertain commands or native instruction priority.

- Qualify HA deployment refusal when an independent repository refresh changes
  source after rebuild, and document stopped verification and inspected retry.

- New Easee cloud plans exclude exact fifteen-minute intermediate gaps that
  cannot survive dispatch latency. Same-price alternatives retain joint service,
  electrical and cost checks; adopted programs keep their original boundaries.

- Preserve newer Tuya pending commands when an older native attempt returns, and
  retry the current unsent settings instead of an obsolete batch. Existing retry
  limits and independently received device observations remain unchanged.

- Forward reported Tuya command failures to its existing native retry handler
  without marking failed writes sent or treating requested settings as fresh
  device observations. The source patch remains pinned and fail closed.

- Keep Charger 1's current commitment when a planned cloud pause was unsent or
  remains unconfirmed, so Charger 2 cannot mistake the period boundary for newly
  available capacity. Confirmed pauses and native restrictions remain separate.

- Allow guarded native Easee handback when retained disconnect evidence belongs
  to a proven earlier session, preserving the event and current restoration,
  native instruction and ownership checks.

- Local Easee setup shows its saved retry deadline after restart, so a delayed
  retry remains visible while setup is waiting to check the charger. Original
  clocks and failure backoff are preserved.

- Avoid rewriting unchanged charging cost and Shelly limiter state solely for
  another calculation date. Live dates stay current, while committed equipment,
  session, source and command state retain their exact persistence boundaries.

- Rejoining a protected computer allows its final history acknowledgement to
  finish within the configured operation timeout, avoiding a premature short
  timeout after replacement history was already accepted. Failed or interrupted
  acknowledgements keep protection and retain the original saved request.

- Storage diagnostics retain a bounded, dated list of slow attempts and anonymous
  prepared change counts, making individual delays easier to attribute without
  saving household values or changing database durability.

- A rejoin can resume a failed or lost acknowledgement after its full seed was
  accepted, preserving that accepted history instead of attempting to republish
  the original seed image. Full verification, current authority and unchanged
  publication checks remain required; original donor evidence stays retained.

- Re-enabling local Easee control can hand over its own confirmed cloud delay
  before native setup. Fresh session and instruction checks preserve external
  schedules, later restrictions and uncertain cleanup; changing the setting
  alone still does not confirm native control.

- Storage technical details distinguish journal sealing from SQLite COMMIT,
  helping attribute slow saves while retaining the existing total. Unmeasured
  stages stay unknown; SQLite COMMIT includes synchronization and checkpoint work.

- A transient Easee OCPP Charging status no longer releases an application pause
  while the charger still confirms its effective zero-current schedule. Failed
  readback and pending writes stay uncertain; newer Stop and schedule instructions
  retain their independent priority.

- History recovery accepts fresh report spans that genuinely extend the same
  recorded source prefix, so a usable learning window can replace a missing
  local window. Original rows remain separate and reversible. Historical imports
  no longer hide newer local reporting merely because they were inserted later.

- A Tesla stopped 5 A report received while a same-connection Stop awaits its reply
  remains unknown instead of becoming a lasting vehicle current limit. Earlier
  qualified limits keep their original evidence; zero and independent requests
  retain their meanings, and command intent is never reported as applied Stop.

- Unchanged charging coordination and controller allowance calculations respect
  the card snapshot's save cadence, reducing repeated writes without changing
  their original clocks, native evidence, live control or actual plan boundaries.

- Caravan native On commands wait five minutes after observed Off, including
  power tests, Automatic, manual power and restoration. Native drying receives
  a bounded five-minute power-fall window. Original clocks and restoration duties
  survive restart; a fresh Off after unknown continuity adds a separate
  conservative hold, and ordinary repeated Off reports do not renew it.

- Caravan recording warnings distinguish an unconfirmed power check from missing
  MQTT reports after a new capture attaches. Earlier recorded state and source
  clocks stay intact, and detailed readings explain the current recording gate.

- Slave viewers release a read transaction when checkpoint validation fails,
  preventing one failed read from leaving subsequent requests stuck.

- Pairing and SSH mirror publications keep the source clocks of the exact frozen
  delivery, preventing intermittent unavailable saved charging and learning views
  when recording advances during synchronization. Retries and static seeds retain
  their original clocks. Finish and acknowledge earlier pending deliveries before
  updating both peers together; unsupported deliveries remain preserved.

- A qualified Tesla vehicle current limit survives maximum-only pilot updates,
  preventing repeated current reductions and increases. Stopped and identification
  reports cannot become permanent vehicle limits; original raw observations and
  qualification clocks remain separate through same-connection restart.
- A confirmed joint Tesla/BMW assignment survives later shared charging episodes
  on the same physical connections. Earlier BMW-only peer episodes cannot create
  a false identity conflict or reset the current battery target and charge anchor;
  independent contradictory evidence and changed connection scopes remain blocked.
- BMW target-filter evidence remains dormant through unresolved identity on the
  same connection, so recovery cannot erase an observed lower target. It supplies
  no active vehicle value or charging permission while identification is unresolved.

- Learning checkpoints share exact prepared fitting samples instead of repeatedly
  copying their bodies into the current cache and every sparse recovery checkpoint.
  This reduces checkpoint writes, replica payloads and future checkpoint storage
  growth while preserving learning precision, history and recovery revert/restore.
  Ordinary pairing and handover remain incremental. Development schema 30 requires
  a deliberate fresh database; existing databases are preserved and rejected,
  without automatic conversion or reset.
- Ready source corrections receive bounded publication priority so continuously
  changing controller inputs cannot indefinitely postpone the corrected model.
  Journal-head checks, catch-up retries and normal-write fairness remain intact.

- Charging history avoids database admissions for unchanged allowance reports.
  Confirmed unchanged coverage saves every minute for Charger 1 and every five
  seconds for Charger 2; actual transitions remain immediate. Charging card
  snapshots save on a 30-second cadence, with important control/session changes
  saved immediately and replicas displaying the snapshot's own date. Repeated
  native readbacks, OCPP phase metering and vehicle-feed reception respect that
  cadence without changing original evidence clocks or live control. Optional
  recorder poll/error statistics are batched while saved records, energy,
  accounting, control intent and restoration obligations remain durable.

- Charger cards treat a healthy unplugged vehicle as ready for the next connection
  instead of warning about missing charging permission. Both cards explain
  connection loss, pending instructions and recovery separately; popups translate
  internal status codes into causes and next checks without claiming an uncertain
  command failed. Vehicle-feed and one-day comparison messages use the same clear
  wording, and planning disclosures retain their original meaning.

- Caravan dehumidifier recording stays active when a slightly early Shelly
  energy-counter notification arrives while required readings remain fresh.
  Required reports, faults and actual outages retain their evidence checks.
  After a brief required-report timestamp wait, an already qualified state
  resumes recording at admission without waiting for another appliance update;
  the brief history gap and original measurement clocks are preserved.
  Fresh meter reports update the recording deadline while preserving appliance
  expiry, so recording and the Caravan card use the same current evidence.
  Recording warnings now reflect current source recovery between controller
  updates and explain missing Caravan power-check or appliance reports.

- Paired history checks hide Recover history when a validated source has no
  changes since the exact shared checkpoint. Resume mirroring then verifies and
  catches up the other computer without suggesting that history is skipped.
  Nonempty checks retain record counts, dates and details, with Resume without
  recovery as the explicit alternative. Verification failures remain separate,
  and changed donors or uncertain release replies retain their existing checks.

- Recording details groups Recording, Storage health, Storage & growth and
  Backups under Recording & storage, with explicit server and live/simulated/
  replica/history scope. Storage & growth combines free space and database sizes;
  Recorded data no longer repeats it. Recording shows observed source exceptions
  and loop evidence; Storage health dates successful writes separately.
- Recording warnings include partial observed-source loss and current-database
  verification failures. Inventory refresh explicitly fetches fresh figures,
  clears results when the database changes and puts populated datasets before
  folded empty entries. Adaptive measurements keeps its existing layout and
  restores keyboard focus after opening source details.
- Home Assistant backup locations distinguish the verified host **Folder** from
  the path **Inside app**, matching Configuration. Saved-copy checks show their
  latest result and failures clearly; save and download outcomes remain separate.
  Export receipts are dated, expire after 24 hours and clear on logout, which
  also cancels an in-progress browser transfer. Verification polling pauses in
  closed or hidden panels while accepted checks continue.
- Backups lists managed copies, sizes, snapshot/modification dates and verification
  evidence, with selected-copy download, full verification and history-review actions.
  Browser transfers stay separate from saved copies. The persistent default backup
  folder is beside the database; `recording.backup_directory` replaces the retired
  export setting and requires restart when changed. Manual copies, complete reset
  bundles and paired exports share that root; existing files are never relocated.
  Listing stays bounded, reports incomplete results and preserves dated failed-refresh
  evidence. Routine replication exports do not count as retained backups.
- Storage health shows current backlog, average and worst queue wait, failed saves,
  queue-full refusals and monitored MQTT commands known not to have been sent
  because recording blocked them. Recent problems distinguish original-update retry
  recovery from ordinary resumed saving; technical timings stay folded. Day/week
  summaries live in memory, label monitored coverage and add no database writes.

- Charging saves changing evidence separately from accepted plans and control
  intent. Plans and their scenario context are stored once; replica reports read
  their existing history instead of repeatedly copying completed reports into
  every device update. Unchanged terminal identification attempts keep their
  original clocks. Related state remains atomic through rollback and restart.
  Development schema 29 and charging format 7 require a deliberate fresh database;
  incompatible databases are preserved and rejected, without migration or reset.

- Garage doors, switches and heat-pump commands wait briefly for received readings
  to finish saving instead of failing immediately during a recording backlog.
  They recheck device state and authority before sending, retain their original
  deadlines and never replay cancelled requests. Doors and ordinary MQTT switches
  distinguish a request that was not sent from an unconfirmed delivery.
- Click or tap a chart data-point popup to dismiss it; selecting another data
  point moves the popup to that point.
- Charging currents keeps Charger 2 fallback periods in its allowance line and
  adds a bar explaining full, priority-constrained, property-constrained and
  fallback allowance. A second bar identifies the highest property phase using
  the same L1/L2/L3 colours as Phase loading. Actual draw remains separate.
- Large firewood and sensor corrections, history recovery, revert and restore
  publish their complete model in a worker. The controller adopts the committed
  model before queued updates resume; failed publication retains the previous
  model and reports failure. A lost worker reply cannot undo a completed save.
  Restart-cache warnings clear once a valid current cache is confirmed.
- Growing Home learning checkpoints no longer make ordinary controller updates
  exceed the recording transaction limit. Large restart caches save in a worker
  after learning inputs and control intent commit; charging keeps its existing
  persistence and command ordering. Cache failures retain recorded learning and
  are shown separately in the model details.
- Reverting recovered history skips cycle assessments already invalidated by the
  same revision, allowing catch-up to progress while learning continues.
- Charging identification explains its actual blocking condition. Charging cost
  labels distinguish the remaining estimate from the whole connection, and cost
  details disclose energy inferred during recording gaps.
- Recovery, verification and pairing messages retain known refusal causes and
  distinguish failed requests from uncertain outcomes. Downloads are labelled
  as sent, without claiming a retained backup on the receiving device.
- Home and Caravan receipts distinguish command delivery from device confirmation.
  Sensor and firewood corrections retain dated receipts across refreshes; recorded
  reconstruction state no longer claims a live worker is running.
- Corrected configuration, Garage, Caravan, recording, charging and recovery
  documentation to match current behavior, defaults and supported capabilities.
  Unsupported floor preheating is distinguished from ROOM-only preheating.
- Vehicle feeds can finish startup and reconnect with populated charging plans.
  Buffered MQTT observations commit in order without one oversized transaction;
  final admission updates identity before readiness, and pending or failed replay
  cannot grant vehicle evidence readiness.
- A burst of vehicle reports waiting to save no longer ends an existing
  identification attempt or stops its probe early. New identification commands
  wait for admission; original time/energy limits and real source failures still apply.
- A missed Shelly query no longer erases still-fresh accepted Stop confirmation
  or identification observations. New commands wait for a complete successful
  refresh; actual source loss, restrictions and original evidence expiry still apply.
- Shelly keeps a complete advancing meter report when its matching notification
  arrives before the query reply, avoiding false telemetry gaps during identification.
  Original measurement clocks and contrary physical changes remain authoritative.
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
  continue independently. Newly selected identification Start and current
  preparation can interrupt an old planning wait, as can a due probe stop or
  restoration, including after its observation window has expired. Shelly's
  accepted Stop confirmation survives a separate current-setting readback.
- After restart or handover, the same vehicle connection retains its saved
  target and battery capacity through the initial absence of live feeds. An
  accepted Easee transaction stays identified when only its power sample is
  uncertain. Transactions recovered from meter reports can regain confirmation
  when later valid reports arrive for the same transaction.
- Local OCPP starts and confirmed pauses survive harmless refreshes and cost
  estimate changes. Shelly actions wait briefly for already received observations,
  then recheck the original connection and native instruction before dispatch.
  Legitimate command preparation no longer consumes the charger's response
  timeout; input waiting and native replies retain their separate bounds.
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

- One Node application for standalone Linux and the Home Assistant app, with a
  shared dashboard, simulated startup and independent feature controls.
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
