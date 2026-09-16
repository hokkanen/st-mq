# 0.9.0

- Validate development on Node 22 and 24 with real SQLite/SSH replication,
  browser, live-provider, Garage simulation and native add-on container checks;
  document commands and limits in [development validation](docs/development-validation.md).
- Fix Node 24 snapshot-worker startup, charger deployment configuration loading,
  stale charger readiness, hidden recirculation stop requests and Firefox status
  popup dismissal during refresh. Reject individually future-dated Garage sensor
  evidence and deduplicate energy retries without a source identity.
- Use compact Home/Garage summaries, expandable provider rows and separate
  equipment folds. Show tariff control above recirculation and Garage learning
  before Garage settings; distinguish requested heating from device confirmation.
- Add opt-in Charger 1 native Easee scheduling, persistent per-charger preferences,
  recorded-energy charge progress and household-load forecasts. Charger 2 remains
  observation-only. Charging permission is independent of heating mode.
- Add independent Garage learning, thermal-reserve protection and episode planning.
  The provisional Pill contract supports simulation and read-only inspection;
  physical Garage control remains unavailable.
- Enable live DHWR watts from `stmq/home/dhwr/status/power`, with event-only freshness and
  no power history or inferred switch confirmation. Document the SmartThings
  forwarding Rule and include a sanitized recreation template; retain ST-MQ's
  timed ON/OFF commands and requested-circulation chart history.

- Add separate Upstairs, Downstairs and Bedroom temperatures, a stable
  configured indoor average and individual room comfort checks. Record sensor
  replacements, moves and calibration changes as replayable measurement boundaries.
- Allow the learned normal temperature to adapt gradually in either direction
  from repeated normal heating, including changes to floor circulation thermostats.
  Retain report coverage and reversible sensor changes in the current
  `committed-house-v9-reversible-sensors` learning journal; earlier algorithms
  retain their documented archival boundaries.
- Use FMI temperature and solar forecasts with keyless Open-Meteo ICON Seamless
  fallback, including missing solar intervals. Prefer H66 outdoor temperature,
  then FMI nearby stations, then Open-Meteo model estimates. Remove the obsolete
  weather-token setting and label sensors, station readings and estimates.
- Enable active MQTT tariff control with conservative operation when H66 is absent.
- Add coupled ROOM/DHWR preheating, cost-aware reduction and recovery, persistent
  H66 setting restoration, and timed tests for ROOM, DHW start/stop and mode.
- Use a shared adaptive thermal model with outdoor temperature and cloud-aware
  global solar-radiation forecast, chronological validation and bounded trials.
- Track complete-cycle estimated profit, the observed space-heating AUX subgroup,
  recovery cost prediction error and learned normal indoor temperature in history.
- Add learning/provider details, solar and learning chart axes, routed compressor
  shading, AUX power fill, a pump-mode strip and daily price-timing benchmarks.
- Upgrade SQLite to schema 12; record observations, learning journals, source
  corrections, cycles and restoration obligations durably.

Active mode must be selected in configuration. Device tests use real commands.
H66 integration follows the documented C60 MQTT profile and has been tested with
mocked devices, not the installed pump. Native overrides have software restoration,
not device-side leases. Compressor-only reductions may skip the native 14-day
high-temperature water cycle, as explicitly accepted for this controller design.

# 0.8.3

- Put the Home Assistant database in the public add-on folder for Terminal & SSH
  access. Migrate the existing private database consistently and retain the
  original. Keep `/share/st-mq` for imports/exports and credentials private.
- Use cold add-on backups and test mounted startup, migration, restart and restore.
- Move permanent settings and electricity rates into add-on options / standalone
  configuration. All monetary inputs explicitly exclude VAT. Default margin is
  0.33 c/kWh, tax 2.325 c/kWh and VAT 25.5%. Day/night remains the default; seasonal
  rates are configurable. Rate changes preserve historical calculations.
- Remove obsolete temperature-to-hours configuration and update add-on help.
- Add persistent Finnish-time Away until and Pause until controls, automatic
  expiry and independent cancellation. Away planning removes occupied drop
  penalties and retains recovery/auxiliary costs; model confidence gates remain.
- Reduce the dashboard middle section to Home control, Electricity and Data &
  learning. Rates and the occupied temperature drop are reported read-only.
- Run read-only H66 acquisition alongside prices, weather and other providers.
- Retain dark startup, the single-day chart picker and the revised chart colours.

Upgrade: review add-on options, remove a retained `temp_to_hours` key if shown,
and restart. Database paths and SSH/backup instructions are in `DOCS.md`.
Physical heat-pump and DHWR commands remain disabled.
