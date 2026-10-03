# Importing 0.7.5 CSV history

Store original CSV exports outside the checkout and keep their source bytes
intact. The only supported pre-v1.0.0 historical compatibility is read-only
import of the two CSV formats below; this document does not provide an old runtime or database reader.
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
Units are amperes. These are current snapshots, not energy measurements. Charts
estimate power using the applicable recorded phase-voltage estimates and unity
power factor. For CSV timestamps before voltage-estimate history begins, the first
fully established database value for each phase supplies an explicitly labelled
retrospective assumption. Until that evidence exists, the original current remains
available but voltage-dependent power is unknown. Later voltage changes do not
change the early-CSV fallback or rewrite imported source rows.

## Import and provenance

Use `node scripts/history.js import --db <database> --file <csv> --kind stmq`
or `--kind easee`. See [recording and import](recording.md) for the current
storage and learning interpretation. Imports require the matching header and
preserve raw source rows, row numbers, source timestamps, quality flags and the
file digest. Missing or invalid fields do not become zero measurements. Gaps,
non-increasing timestamps and suspicious measurements remain explicit.

Reimporting the same completed file digest is skipped. An interrupted import
retries its unpublished staging from stable source bytes and publishes once,
without duplicating committed rows. Distinct source rows and
their provenance remain available even when they have the same timestamp; chart
and learning queries retain their deterministic duplicate handling. Imported
model learning continues to use the historical Upstairs measurement normalized into the
current learning contract, as required by the [reconstruction contract](reconstruction-and-versioning.md).

## Import and inspect history

Select the original file and matching kind explicitly. The importer does not
rewrite source files or run the old application:

```sh
npm run history -- import --file /path/to/st-mq.csv --kind stmq
npm run history -- import --file /path/to/easee.csv --kind easee
npm run history -- summary
npm run history -- tail --follow
```

Use `--db <path>` to select the target database. A completed source digest is
idempotent; a differently edited file retains its own provenance. Missing data
stays unknown, historical spot prices remain excluding VAT, and old requested
heating modes are never treated as observed compressor activity.

An incompatible development database is not an import input. Start a fresh
current database deliberately and reimport the original supported CSV sources;
there is no automatic schema migration, reset or old-database reader. Imported
telemetry alone cannot reproduce a complete live learning journal.

See [recording](recording.md) for storage/learning meaning and
[backup and export](recording.md#history-cli-backups-and-exports) for current
same-version database maintenance.
