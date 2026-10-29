# Changelog

Release notes describe changes relevant to users. Detailed implementation and
validation history is available in Git; unfinished work belongs in GitHub issues.
Versions follow Semantic Versioning.

## 0.9.5 — 2026-10-29

This release expands the MQTT electricity-price signalling and Easee CSV
monitoring in 0.7.5 into an integrated household energy controller. The changes
below describe the complete transition from 0.7.5 to 0.9.5.

### Installation and access

- A unified Node.js application replaces the separately scheduled monitoring,
  MQTT and chart-server scripts on standalone Ubuntu and Home Assistant OS. It
  serves the dashboard and runs monitoring, recording and authorized control. Home
  Assistant supports amd64 and aarch64; Node.js 22.19 or newer is required.
- The Ubuntu setup wizard installs a managed systemd runtime, imports private
  configuration and verifies startup. Deployment tools update committed source
  with explicit lifecycle, synchronization and verification checks.
- Shared defaults and sparse installation overrides replace editing private
  settings in the checkout. Home Assistant saved options own its configuration;
  standalone private configuration stays outside Git with private permissions.
- Startup uses simulated input with Home heating paused. Live acquisition,
  Home, Garage, charging and Caravan control each have separate permissions.
- Direct access supports admin/family roles, HTTPS and optional remembered
  logins with revocation. Home Assistant ingress uses the host login and grants
  application admin access. Optional LAN HTTP backup is a separate choice.
- Invalid configuration opens an authenticated recovery screen before recording
  or equipment runtime starts. Imports support review, private backup and explicit
  replacement of incompatible saved options without translating retired fields.

### Heating and equipment

- Home learns a thermal model from retained observations and plans preheating,
  reduction and recovery using electricity prices, weather, comfort and model
  uncertainty. Cost assessments cover complete cycles and distinguish estimates
  from measured outcomes; cheap timing alone does not establish savings.
- Home uses one learned occupied reference and fixed indoor sensor weights.
  Away, scheduled return, Pause and timed manual overrides have explicit scopes.
  H66 native-setting control retains independent instructions and durable
  restoration duties across restart, failure and model changes.
- Home equipment includes commissioned floor preheating through the separate
  SONOFF firmware, tariff control and native Shelly hot-water circulation.
  Timed controls require current identity, readiness and supported capabilities;
  GPIO or native readback does not prove water flow or heat delivery.
- Garage has persistent Normal/Away targets, native heat-pump controls and
  independent device-local freeze protection through the CN105 controller and
  protection sender. Garage uses local regulation rather than a learned economic
  scheduler. Door controls distinguish reported state from travel estimates.
- Caravan monitoring and supported native dehumidifier controls use a Home
  Assistant MQTT bridge. Automatic power has independent permission and
  temperature thresholds; native shutdown and restart timing remain protected.
  The pinned Tuya Local adapter preserves observation clocks, and an optional
  update guard restores reviewed compatible updates and the custom device profile.

### EV charging

- Coordinated Easee and supported Shelly EVSE charging replaces consumption-only
  monitoring. Easee supports cloud scheduling or local OCPP; Shelly uses its
  supported EVSE profile and capability checks rather than a generic relay path.
- Planning combines requested energy, ready-by times, priorities, electricity
  prices and shared property capacity. Shelly current adjustment is independent
  of Automatic scheduling and remains subject to native limits and feed health.
- Charge now, Pause, scheduling, vehicle identification and explicit automatic
  handover retain their own session scopes. Later external instructions,
  device-native protection and uncertain command outcomes retain precedence.
- BMW CarData and TeslaMate provide vehicle and battery evidence. Identity checks
  preserve connection boundaries and distinguish measured matches, assumptions
  and missing or contradictory evidence.
- Recorded session reports retain plans, instructions, acknowledgements, native
  readback and measured delivery as distinct evidence. Recent and saved reports
  have bounded browsing, dated findings and independent energy-history retention.
- Restart and pair handover preserve local OCPP configuration and outstanding
  restrictions. New-session authorization can depend on the controller during an
  outage; native pause expiry alone does not restore cloud control.

### Recording, learning and recovery

- SQLite replaces the CSV runtime store. Recording retains source identity,
  original measurement and receipt clocks, units, quality and explicit gaps.
  Valid zero and false remain valid; unknown values do not become zero or Off.
- Adaptive recording, background workers and bounded queues keep history and
  model work separate from responsive ingestion, controls and dashboard reads.
  Storage health distinguishes writer availability, delays and retained incidents.
- Home learning reconstructs from the committed journal, seed, configuration and
  correction revisions. Checkpoints are replaceable caches. Corrections preserve
  original evidence and publish complete caught-up models atomically; failure
  retains the previous model.
- Energy accounting uses recorded intervals and explicit coverage. Forecasts,
  retrospective estimates and measured consumption remain separate, including
  voltage/current reconstruction, charger allowances and cost comparisons.
- Dashboard exports, CLI backups and pairing archives support self-contained
  SQLite backups with exporter metadata. History recovery can compare and merge
  compatible backups or protected peer history, with reversible corrections,
  explicit confirmation and retained original sources.
- Read-only import of the original 0.7.5 `st-mq.csv` and `easee.csv` files preserves
  provenance, duplicate handling and interrupted-import recovery.

### Pairing and dashboard

- Standalone operation, a read-only SSH mirror and a manually managed Linux–HA
  pair share core behavior and data semantics. Only the explicitly authorized
  master commands equipment; a replica or timeout never grants control authority.
- Pairing provides verified synchronization, explicit handover, protected-history
  recovery and archived reset choices. Native device readiness and MQTT/OCPP
  continuity remain separate from a completed role transfer.
- The CSV chart page becomes a dashboard with Home, Garage and charging controls,
  equipment setup, history recovery and role-aware actions. It retains date
  selection and light/dark themes alongside keyboard navigation and layouts for
  narrow screens.
- SQLite-backed charts add quantity-specific views, recorded model-coefficient
  histories and source/coverage details. Background chart work and bounded
  history reads preserve responsiveness and source gaps.
- Source health separates current feed availability from primary/backup provider
  readiness for outdoor temperature, weather and electricity prices. Cached
  readings and reconnects do not create fresh evidence.
- A new event log presents recorded instructions and outcomes with filters,
  pagination, refresh and stable reading position.

### Compatibility and operating limits

- Home Assistant marks 0.9.5 as a breaking update; automatic updates do not cross
  this boundary. Review compatibility and update manually.
- Home Assistant builds support only 64-bit amd64 and aarch64 systems. The armhf,
  armv7 and i386 builds offered by 0.7.5 are no longer provided.
- **0.7.5 requires a fresh current configuration and database.** Preserve its
  installation settings, backups and original CSV exports before replacement,
  then optionally import the two supported CSV formats. The old MQTT heating
  action protocol and runtime configuration are retired.
- **The current database schema is 36.** Unsupported or malformed databases and
  unknown or retired settings are rejected before mutation. There is no automatic
  migration, history rescaling or database reset. Current-format restart,
  backup/restore and reconstruction remain supported. See the
  [Home Assistant](DOCS.md#moving-from-an-earlier-version) and
  [standalone](docs/startup.md#moving-from-an-earlier-version) installation guidance.
- Keep one equipment command owner, review outstanding restoration duties and
  commission each live integration separately. Installing or updating software
  does not establish device capability, physical protection or cost savings.
- Automated qualification covers Node 22/24, routine and extended recovery tests,
  browser fixtures, amd64 and emulated arm64 containers, and pinned Supervisor
  contracts. Native Raspberry Pi storage performance, real Home Assistant OS
  installation/update, AppArmor/network enforcement, host backup/restore and
  physical equipment behavior remain installation-specific acceptance work. See
  [development validation](docs/development-validation.md).
- Caravan control requires fresh native appliance and meter evidence; unavailable
  observations cannot establish readiness. A repeated native Shelly Stop while
  already automatically paused may be unobservable; see the maintained
  [charging limitations](docs/charging/integrations/shelly.md) and
  [Caravan guidance](docs/caravan-dehumidifier.md).

## 0.7.5

- MQTT electricity-price signalling for heating using configured outdoor
  temperature-to-hours rules, ENTSO-E prices and an Elering backup.
- Temperature and price recording in `st-mq.csv`, Easee charger and property-current
  recording in `easee.csv`, and browser charts for those files.
- Standalone scripts and Home Assistant packaging with SmartThings-oriented
  setup guidance. The 0.7.5 runtime is no longer maintained; its two supported CSV
  exports remain available for explicit read-only import into 0.9.5.
