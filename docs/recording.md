# Adaptive recording and reproducible house learning

Acquisition, recording and house learning have separate responsibilities. Devices
can be read frequently while history retains a compact approximation. Only
committed history and its recorded interpretation feed the learner. Recording a
garage temperature or a diagnostic does not make it a fitted model input.

## Acquisition schedules

| Source | Default acquisition | Important distinction |
| --- | --- | --- |
| H66 | Continuous MQTT publications, plus GETALL every 60 seconds | GETALL republishes the gateway's known values; receipt time is not proof of a new sensor measurement. |
| Easee charger and Equalizer | REST every 15 seconds; one batched observations request per configured device | The endpoint returns last-reported observations. Polling faster does not force new measurements. |
| Indoor/garage replacement sensors | Configured MQTT topics | The publisher determines its measurement frequency; retained messages are marked explicitly. |
| FMI outdoor observations, Open-Meteo backup | Every five minutes | A successful fetch can contain the same older station or model timestamp. |
| FMI/Open-Meteo forecast | Every 30 minutes | Actual forecasts update on provider/model schedules; unchanged content is referenced rather than copied. |
| ENTSO-E/Elering prices | Hourly, with 15-minute checks when the available horizon is shorter than the next 24 hours | Native hourly/quarter-hour delivery intervals remain unchanged. Missing current-day coverage and failed requests have separate backoff. |

Two Easee devices at 15 seconds require 40 observations requests in five minutes.
The shared request gate allows at most 90 such requests per rolling five minutes,
leaving margin below the documented limit of 100. Authentication retries consume
that same observations allowance. HTTP 429 delays and ordinary failure backoff
are respected; devices are not polled in overlapping batches. No charger settings
are changed by this acquisition path. The documented AMQP stream requires partner
access, so this implementation uses REST.

Provider references:

- [Husdata MQTT specification](https://husdata.se/docs/h60-manual/home-assistant-integration/mqtt-specification/)
- [Easee observations endpoint](https://developer.easee.com/reference/getobservations)
- [Easee charger observation IDs](https://developer.easee.com/docs/charger-observation-ids)
- [Easee Equalizer observation IDs](https://developer.easee.com/docs/equalizer-observations)
- [Easee AMQP requirements](https://developer.easee.com/docs/amqp-connect)
- [FMI time-series access](https://en.ilmatieteenlaitos.fi/open-data-manual-time-series-data)
- [FMI model updates](https://en.ilmatieteenlaitos.fi/numerical-weather-prediction)
- [Open-Meteo model updates](https://open-meteo.com/en/docs/model-updates)
- [Elering API](https://dashboard.elering.ee/v3/api-docs)

These references describe interfaces, not a verified update cadence for a
particular installation. The offline tests use invented observations and never
contact providers or use private credentials.

## Electricity: three recorded values per device

The electrical dataset contains `ev1_energy_l1` through `ev1_energy_l3` for the
charger, and `property_energy_l1` through `property_energy_l3` for property import.
Each value is an **estimated kWh increment over an explicit interval**, not an
instantaneous power reading or a cumulative phase meter.

Every usable acquisition contributes to integration, including polls between
database records. The acquisition accumulator retains only its preceding power
snapshot, source freshness, availability and audit-counter heads. The recorder
retains the three pending energy sums. Both checkpoints have bounded size;
there is no growing log of raw current/voltage/power polls.

The calculation is:

1. Prefer reported active total power: charger observation `120` or Equalizer
   observation `40`, both in kW.
2. Divide that total among phases using their voltage × current shares. If usable
   phase-neutral voltage is unavailable, use current shares and record that basis.
   The sum of the phase powers preserves the reported total.
3. Integrate consecutive phase-power estimates with the trapezoidal rule and
   actual elapsed receipt time. Polling delay, asynchronous source updates and
   holding a last-reported value remain estimation limitations.
4. Pass those energy increments to the recorder. It decides when to save from
   changes in phase power, quality and elapsed interval, while accumulating all
   intervening energy. Constant power therefore continues consuming energy even
   when no numerical change triggers a record.

If active total power is unavailable but all three currents and verified
phase-neutral voltages are usable, voltage × current supplies a fallback explicitly
labelled **unity power factor assumed**. It estimates real consumption from
apparent power; that assumption can be wrong. Positive total power with no usable
phase shares is missing data, not an invented equal split. Fresh zero total power
can produce three zero increments without requiring phase shares.

An unused phase may keep an old zero-current timestamp. With fresh reported total
power and fresh currents for every nonzero phase, those old valid zeros may supply
estimated zero shares, labelled `last_reported_zero_phase_weights`. They do not
renew measurement freshness. Old nonzero currents, failed or future readings, and
voltage × current fallback cannot use this exception.

Equalizer IDs `31–33` are phase currents and `34–36` are phase-neutral voltages.
Charger current IDs are `183–185`. Charger voltage IDs describe terminal pairs;
the default requested IDs `194–196` are **not used as phase-neutral voltages until
the installation mapping has been verified**. `easee.charger_voltage_ids` can then
specify three distinct IDs from `190–199`, in L1/L2/L3 order. An empty list uses
current shares with reported active power. Do not copy a terminal mapping from a
different grid or installation without checking it.

Current, voltage and power snapshots remain acquisition-only. Current snapshots
can appear in live status, but are not new historical or training signals.
Restart state does not authorize integration over a long outage: the default
maximum gap between usable polls is 60 seconds, and the power/current measurements
anchoring integration expire after five minutes. Repeated cached API values keep their original source
age. Failures, expiry, backwards timestamps and recovery leave explicit gaps;
there is no unbounded last-value hold. Pump/phase zero transitions bypass the
numerical change threshold.

Charts derive interval-average kW as `kWh × 3,600,000 / durationMs`. This conversion
does not use 230 V. Equivalent chart currents divide estimated phase kW by `0.23`;
they assume 230 V and unity power factor and are not the original current readings.
Older current-only history keeps its existing 230 V estimation basis. The new
energy path takes over at its recorded boundary without double-counting the older
path. Missing intervals remain missing in energy and timing comparisons.

### Audit-only cumulative meters

Charger lifetime energy (`124`) and Equalizer accumulated import energy (`45`)
are stored separately in `energy_audits` when a new counter observation arrives.
Both measure cumulative energy, so the charger and property checks use the same
comparison basis. Charger session energy (`121`) is no longer requested or
recorded; previously stored session readings remain in history. Duplicate
timestamp/value pairs are not copied. Source timestamps, resets, out-of-order
counters and availability are retained.

The meter-check panel shows only the latest reading for each cumulative meter,
with its comparison interval when available. It is not a list of readings or an
average across charging sessions. Older audit readings remain available in history.

Recording diagnostics compare a valid counter increment with the sum of committed
phase-energy estimates over the same source-time period. Missing coverage prevents
a valid comparison. If an edge cuts through a recorded interval, its energy is
prorated using that interval's average and the comparison is marked as using an
estimated boundary. Differences appear in kWh and percentage; zero metered energy
does not produce a division-by-zero percentage.

**Audit values never correct history, calibrate integration, tune the house model
or determine per-signal recording thresholds.** A comparison is computed when
diagnostics are read, after available energy intervals have been committed. A
counter update does not force an extra energy record.

## Recording optimizer and storage

Permanent options:

```json
{
  "recording": {
    "max_interval_minutes": 5,
    "annual_budget_gb": 10
  },
  "acquisition": {
    "easee_poll_seconds": 15,
    "weather_poll_minutes": 30,
    "outdoor_poll_minutes": 5,
    "market_poll_minutes": 60,
    "market_retry_minutes": 15,
    "electricity_source_max_age_seconds": 300,
    "electricity_max_gap_seconds": 60
  }
}
```

Acquisition schedules and recording settings are independent. GB means decimal
gigabytes. The five-minute recording value is a maximum interval **when fresh
source data exists**, not a promise to invent readings from an unavailable source.
The ten-GB value is a soft rolling annual growth target, not a quota that expires
in December. It never causes historical deletion or an end-of-year squeeze.

The recorder learns each continuous signal's scale from its observed variation
and uses a shared normalized error tolerance. That tolerance changes gradually
in response to measured SQLite growth, using smoothed daily and weekly estimates.
Signals are compared with their last saved value. There are no hand-assigned
accuracy targets or model-importance weights; garage temperature has the same
normalized reconstruction objective as indoor temperature.

Exact states, settings, alarms, runtime counters and availability transitions have
semantic recording rules. They are not blurred into fractional states to meet a
byte target. Equal treatment of continuous measurement error is an objective, not
a guarantee of identical error percentages for every signal at every instant.
Different source precision, availability and rates of change remain visible.

Repeated observations compact into coverage spans that distinguish fresh held
values from unavailable/stale sources. The held historical value is what a later
learner may read; discarded intermediate poll values cannot enter through those
spans. Successful downloads of older timestamps do not renew source freshness.
SQLite transactions group energy phases, pending sums and acquisition checkpoints
so retries cannot count an interval twice.

Forecast and price payloads are content-deduplicated separately from their
acquisition references. Original issuance/fetch provenance survives unchanged
re-downloads. Current solar radiation is selected from the forecast version known
then; it is not duplicated as a synthetic one-minute solar observation and is not
labelled as house-measured radiation. Later forecasts cannot replace the version
used by an earlier learning sample.

Long-range display summaries preserve representative scalar values and missing
data information. Electrical summaries use 15-minute energy sums and coverage;
their plotted power is labelled as a quarter-hour average. With complete coverage
and quarter-aligned prices, those sums give the same timing cost as the original
intervals. Incomplete buckets, partial selection edges and tariff changes within
a quarter use the original intervals instead. Pre-migration energy stays on its
original path, with a watermark preventing double counting.

These summaries serve chart queries only; training and audit calculations use
their own committed source inputs. Summaries do not replace or delete original
history. Existing observations are preserved through transactional
schema migration. Actual annual size and year-query latency must be measured on
the deployment; no Raspberry Pi 5 timing guarantee follows from desktop tests.

## H66 dataset and model roles

The dataset retains **30 H66 variables**. `discharge_temperature` (`0012`) and
`brine_pump_active` (`1A04`) are omitted from new acquisition. Existing historical
rows are not deleted, and old installation verification metadata for those
registers does not prevent startup. Brine pump speed remains; its zero transitions
are always recorded. A separate active-state measurement is not stored.

| Group | Recorded H66 signals | Typical model role |
| --- | --- | --- |
| Temperatures | Indoor, outdoor | House input |
| Heating water | Supply, return, supply target | Equipment context |
| Ground loop | Brine in, brine out, brine pump speed | History/diagnostics |
| Hot water | DHW temperature, DHW routing, DHW start/stop settings | Separate hot-water context |
| Heating activity | Compressor active, heating pump active, heating pump speed, auxiliary output, heating integral | Heat-input attribution and equipment context |
| Runtime counters | Compressor hours, DHW hours, auxiliary 3 kW hours, auxiliary 6 kW hours | Reconciliation/diagnostics |
| Settings/mode | Room setting, operating mode, room influence, heating curve, maximum supply, heat-stop and tariff-reduction settings | Explain controller behaviour/settings changes |
| Alarms | Alarm active, alarm code | Abnormal-operation context |

Garage temperature is additional to those 30 and is history-only initially.
Collecting it does not add another free house-model coefficient.

The house model fits a small regularized thermal response. Ordinary operation can
teach cooling, normal heating response and solar response; it need not wait for a
savings episode. Preheat/reduction/recovery-specific parameters remain constrained
until distinct completed episodes support them. Validation uses later multi-hour
day/episode blocks, with an embargo between training and validation. Representative
older episodes are retained alongside the recent fitting window.

Property and charger phase energies enter persisted sample context with their
coverage. They are not treated as dedicated heat-pump metering: property minus
charger still contains other household loads. Heat input currently depends on
committed compressor duty, auxiliary output and routing with nominal equipment
power assumptions. A future heat pump therefore needs equipment recalibration;
building response can provide initial knowledge, not guaranteed unchanged physical
heat-loss/capacity coefficients. Supply minus return temperature cannot establish
delivered thermal energy without water flow.

## Reproducible learning

The learner consumes completed 15-minute UTC windows reconstructed causally from
committed observations and coverage. It does not train once per event, which would
overweight busy periods. A window records its resolved values, observation and
coverage lineage, forecast version and controller context. It never uses a later
sample to interpolate what the live learner knew earlier.

Samples, complete episode updates and reference-context changes enter an immutable ordered `learning_journal`
with algorithm version, configuration digest and configuration snapshot. Live
updates and rebuilding use the same journal-entry function. The journal stores an
explicit initial seed when adopting an existing model; original discarded source
polls are not required to reproduce subsequent learning. Older imported history is
resampled causally with bounded holds, retaining unknown heating/solar information.

Restart replays durable entries not yet applied to the checkpoint. The internal
`replayLearningJournal(store, input, checkpoint, {rebuild: true})` path can rebuild
from the journal; there is no separate public rebuild CLI. Reproduction requires
the supported recorded algorithm version. A future algorithm upgrade must keep
that version interpretable or explicitly migrate it, rather than pretending new
code reproduces an old model exactly. Later edits to forecast or coverage data do
not change already resolved journal inputs.

## SmartThings migration and interface

Automatic SmartThings acquisition is removed, and old SmartThings connection
options are ignored. Its existing indoor/garage history remains available. H66 can
provide indoor temperature when installed and representative; garage and optional
indoor replacement sensors can publish to exact MQTT topics on the existing broker.
These temperature subscriptions also work without an H66 device configured.
For example, these invented topic names illustrate the configuration shape:

```json
{
  "mqtt": {
    "indoor_temperature_topic": "example/sensors/indoor",
    "garage_temperature_topic": "example/sensors/garage"
  }
}
```

Standalone options also accept `mqtt.temperature_topics` mapping the signal names
`indoor_temperature` and `garage_temperature` to topics. The payload can be a JSON
number in Celsius, or an object such as
`{"value":12.5,"unit":"C","timestamp":"2026-01-01T12:00:00Z"}`. Units `C`, `degC`,
`°C` and `F` are accepted; a supplied timestamp must include its time zone or be
epoch milliseconds. Without a timestamp, a non-retained publication uses labelled
MQTT receipt time. Retained data never gains a new measurement time on reconnect.
No replacement topics or device configuration are guessed from old SmartThings IDs.
Broker disconnection records explicit unavailable transitions for configured
temperature sensors and included H66 signals. Reconnection alone does not recover
their availability; each signal requires a usable new publication. Subscription
failures are recorded separately from unchanged sensor values.

The left drawer lists historical axes in temperature, heating, hot-water,
ground-loop, settings, equipment, runtime, electricity, weather and learning groups.
Recorded and calculated roles are separate from model roles. Recording details
show achieved interval averages, current thresholds, freshness and storage growth;
an average interval is not a fixed poll schedule. Energy-audit details show the
occasional metered comparison without changing the learner.

Views longer than seven days refresh at five-minute intervals. Ordinary raw polls
and recorder checkpoints do not force a history download. Short views react to
new committed data. The chart query runs in a separate worker with bounded memory
and a cancellable queue, so a large query does not block the control event loop.
Timing labels explain their assumptions on hover, keyboard focus or tap; Escape
and tapping elsewhere dismiss them. Meter counters are also selectable under
Meter checks, separately from estimated interval energy.

## Synthetic year benchmark

Run `node scripts/benchmark-recorder.js --days 365 --max-seconds 180` for an
isolated synthetic benchmark. It creates and removes its own temporary database;
it does not open production history or configuration. `--profile` profiles query
work only and reports the hottest functions.

On the development Ryzen host with Node 22.19.0, six electrical series every minute
plus all 30 H66 series every five minutes produced 6,307,200 observations and a
4.02 GB database, including 15-minute energy and hourly scalar summaries. The
power chart took 183 ms for one day, 2.30 seconds for a month, and 17.15 seconds
for a year. The year response was about 1.45 MB and 11,537 points. Peak process RSS
was 316 MiB across population and queries.

This measures the core observation workload, **not total application growth**:
forecasts, learning journals, coverage, checkpoints and event logs add storage.
Population uses bulk inserts with equivalent summary payloads, so its duration
does not measure live recorder write throughput. The workload has no price data;
tariff correctness is tested separately. These are host measurements, not Raspberry
Pi 5 timings. Full-year cold queries remain substantial; the worker and slower
long-view refresh keep them outside the control loop. The live optimizer measures
actual database growth, including those additional tables, against the configured
soft target.
