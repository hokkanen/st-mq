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
