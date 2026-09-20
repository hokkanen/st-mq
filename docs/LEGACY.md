# Legacy v0.7.5 history reference

Version 0.7.5 continues running on its existing machine until the owner starts the
production migration. Keep that installation and its source CSV files intact.
The current development entry point is `npm start`; setup is documented in
[the current guide](../DOCS.md).

## st-mq CSV

The original st-mq history has this header:

```csv
unix_time,price,heat_on,temp_in,temp_ga,temp_out
```

`unix_time` is Unix time in seconds, converted to milliseconds when imported.
Prices are corrected historical spot prices in c/kWh excluding VAT and other
charges. `heat_on` records the requested legacy mode (`0`, `15` or `60`), not an
observation that the heat pump received or applied it. The three temperatures are
in Celsius: `temp_in` is the original Upstairs sensor, `temp_ga` is Garage, and
`temp_out` is outdoor temperature. Indoor history is never reinterpreted as a
new multi-room average.

## Easee CSV

The original Easee history has this header:

```csv
unix_time,ch_curr1,ch_curr2,ch_curr3,eq_curr1,eq_curr2,eq_curr3
```

`unix_time` is Unix time in seconds. The first three current fields belong to
charger phases L1–L3; the last three belong to Equalizer property phases L1–L3.
Units are amperes. These are current snapshots, not energy measurements; old
charts estimate power using nominal 230 V and unity power factor.

## Import and provenance

Use `node scripts/history.js import --db <database> --file <csv> --kind stmq`
or `--kind easee`. See [recording and migration](recording.md) for the current
storage and learning interpretation. Imports require the matching header and
preserve raw source rows, row numbers, source timestamps, quality flags and the
file digest. Missing or invalid fields do not become zero measurements. Gaps,
non-increasing timestamps and suspicious measurements remain explicit.

Reimporting the same completed file digest is skipped. An interrupted import
resumes without duplicating its already recorded rows. Distinct source rows and
their provenance remain available even when they have the same timestamp; chart
and learning queries retain their deterministic duplicate handling. Imported
model learning continues to use the historical Upstairs measurement and its
matching algorithm, as required by the [reconstruction contract](reconstruction-and-versioning.md).

## Retired relay protocol

The current controller uses direct configured tariff-relay MQTT commands and
independent relay state readback. DHWR uses timed ON/OFF commands on its own
configured topic. Legacy button commands and the old controller entry point are
retired in this checkout; the separate 0.7.5 installation is unchanged. Historical
CSV numeric modes retain their original import semantics.
