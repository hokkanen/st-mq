# Adaptive recording and reproducible house learning

Acquisition, recording and house learning have separate responsibilities. Devices
can be read frequently while history retains a compact approximation. Only
durably recorded values and their saved interpretation feed the learner. Recording a
garage temperature or a diagnostic does not make it a fitted model input.

This version is still in development. Existing experimental SQLite contents do
not require compatibility work. The eventual production migration starts from
the old Easee and st-mq CSV exports; the existing 0.7.5 installation continues
running independently until that migration. CSV parsing, source timestamps,
units, quality flags and import provenance remain supported.

## Acquisition schedules

| Source | Default acquisition | Important distinction |
| --- | --- | --- |
| H66 | Continuous MQTT publications, plus GETALL every 60 seconds | GETALL republishes the gateway's known values; receipt time is not proof of a new sensor measurement. |
| Easee charger and Equalizer | SignalR observations, sampled as complete cached snapshots every 15 seconds; REST backup and 15-minute reconciliation | Each field retains its last-reported source time. Sampling faster does not force new measurements. |
| Shelly EVSE (Charger 2) | MQTT notifications and five-second role/status reads | Source-clocked native accumulated-kWh deltas; requires the configured physical association. |
| TeslaMate / BMW | Read-only vehicle MQTT | Identity, SoC and vehicle constraints only; never another home-energy contribution. |
| Indoor/garage sensors | Configured local MQTT topics | The publisher determines its measurement frequency; retained messages are marked explicitly. |
| FMI outdoor observations, Open-Meteo backup | Every five minutes | A successful fetch can contain the same older station or model timestamp. |
| FMI/Open-Meteo forecast | Every 30 minutes | Actual forecasts update on provider/model schedules; unchanged content is referenced rather than copied. |
| ENTSO-E/Elering prices | Hourly, with 15-minute checks when the available horizon is shorter than the next 24 hours | Native hourly/quarter-hour delivery intervals remain unchanged. Missing current-day coverage and failed requests have separate backoff. |

One SignalR connection subscribes to the configured Charger 1 and Equalizer,
requesting their current observations when it connects and subscribing again
after reconnect. The cache keeps each field's original measurement timestamp.
Acquisition samples a complete usable snapshot every 15 seconds, so unchanged
power still contributes to the existing bounded integration. Individual incoming
fields do not create partial electrical samples or new history channels.

When the stream is unavailable or a required reading is missing, that device uses
one batched REST observations request at the normal acquisition cadence. Healthy
streaming reconciles with REST every 15 minutes. Reconciliation can update fields
already received on the current stream connection; it cannot establish stream
readiness or fill fields that the stream has never supplied. Schedules,
configuration and commands retain their REST routes.
This supports the existing one Easee charger and one Equalizer configuration.

Streaming and REST share token loading, refresh and persistence. Two devices
falling back to REST every 15 seconds require 40 observations requests in five
minutes. The shared REST request gate allows at most 90 requests per rolling five
minutes, leaving margin below the documented limit of 100. Authentication retries
consume the same allowance. HTTP 429 delays and ordinary failure backoff are
respected; devices are not polled in overlapping batches. No charger settings are
changed by this acquisition path. Provider diagnostics identify live streaming,
REST backup or a mixture; working backup does not itself require attention.

Provider references:

- [Husdata MQTT specification](https://husdata.se/docs/h60-manual/home-assistant-integration/mqtt-specification/)
- [Easee observations endpoint](https://developer.easee.com/reference/getobservations)
- [Easee charger observation IDs](https://developer.easee.com/docs/charger-observation-ids)
- [Easee Equalizer observation IDs](https://developer.easee.com/docs/equalizer-observations)
- [Easee streaming guidance](https://developer.easee.com/docs/introduction)
- [Established Easee SignalR client and subscriptions](https://github.com/nordicopen/pyeasee/blob/master/pyeasee/easee.py)
- [TeslaMate MQTT fields and geofence topic](https://docs.teslamate.org/docs/integrations/mqtt/)
- [FMI time-series access](https://en.ilmatieteenlaitos.fi/open-data-manual-time-series-data)
- [FMI model updates](https://en.ilmatieteenlaitos.fi/numerical-weather-prediction)
- [Open-Meteo model updates](https://open-meteo.com/en/docs/model-updates)
- [Elering API](https://dashboard.elering.ee/v3/api-docs)

These references describe interfaces, not a verified update cadence for a
particular installation. The offline tests use invented observations and never
contact providers or use private credentials.

## Electricity: recorded interval energy

The electrical dataset contains `ev1_energy_l1` through `ev1_energy_l3` for the
Easee charger, and `property_energy_l1` through `property_energy_l3` for property import.
Shelly EVSE retains scalar `ev2_energy` from its native accumulated meter and
`ev2_energy_l1` through `ev2_energy_l3` as estimated phase allocations. Its measured
total increment is allocated using the actual mapped phase powers at the two
source endpoints. Missing phase evidence leaves phase history unavailable while
the independently valid measured total remains recorded. No equal split is invented.
Each value is a **kWh increment over an explicit interval**, not an instantaneous
power reading or a cumulative phase meter. Property and Charger 1 are integrated
estimates; Charger 2 and Caravan totals are measured counter differences. Charger 2
phase allocations remain estimates even though their sum preserves the measured total.

Every usable acquisition contributes to integration, including polls between
database records. The acquisition accumulator retains only its preceding power
snapshot, source freshness, availability and audit-counter heads. The recorder
retains the pending energy sums and their latest genuine source/receipt bounds. Both checkpoints have bounded size;
there is no growing log of raw current/voltage/power polls.

The Easee and Equalizer calculation is:

1. Prefer reported active total power: charger observation `120` or Equalizer
   observation `40`, both in kW.
2. Divide that total among phases using their voltage × current shares. If usable
   phase-neutral voltage is unavailable, use current shares and record that basis.
   The sum of the phase powers preserves the reported total.
3. Integrate consecutive phase-power estimates with the trapezoidal rule and
   actual elapsed receipt time. Polling delay, asynchronous source updates and
   holding a last-reported value remain estimation limitations.
4. Pass those energy increments to the recorder. It decides when to save from
   changes in phase power, quality and real acquisition/session boundaries, while
   accumulating all intervening energy. Constant power continues consuming energy
   without forcing periodic historical rows. An open interval is durable current
   state and remains visible to chart, accounting and charging readers.

If active total power is unavailable but all three currents and verified
phase-neutral voltages are usable, voltage × current supplies a fallback explicitly
labelled **unity power factor assumed**. It estimates real consumption from
apparent power; that assumption can be wrong. Positive total power with no usable
phase shares is missing data, not an invented equal split. Fresh zero total power
can produce three zero increments without requiring phase shares.

Phase currents may keep older timestamps while reported total power continues
updating. With usable reported total power, older valid currents may supply
estimated phase shares, labelled `last_reported_phase_weights` for nonzero values
and `last_reported_zero_phase_weights` for zeros. An aging allocation weight or
voltage must not discard usable aggregate consumption. Original phase timestamps
remain unchanged, and asynchronous inputs stay labelled. Failed, invalid or future readings cannot
supply shares. Voltage × current fallback still requires fresh currents and
verified voltages because those measurements establish consumption themselves.

Equalizer IDs `31–33` are phase currents and `34–36` are phase-neutral voltages.
Charger current IDs are `183–185`. Charger voltage IDs describe terminal pairs;
the default requested IDs `194–196` are **not used as phase-neutral voltages until
the installation mapping has been verified**. `easee.charger_voltage_ids` can then
specify three distinct IDs from `190–199`, in L1/L2/L3 order. An empty list uses
current shares with reported active power. Do not copy a terminal mapping from a
different grid or installation without checking it.

The same batched request also reads cloud connection observation `250` and, for
the charger, telemetry IDs `130`, `132`, `136` and `150` (signal strength and maximum
temperature). Only validated timestamps and connection state are retained as
metadata; diagnostic values are discarded and no new series are recorded.
Unchanged total power, including zero while idle, can remain usable when the
connection is explicitly online and a valid electrical or charger diagnostic
observation from the same device is still recent. A cloud reconnect does not
reset the timestamps of unchanged electrical values. The newest observation
supplies a separate `telemetryAt` clock, including across checkpoint restart.
The original power and phase timestamps remain unchanged. Confirmed device
telemetry is labelled `device_telemetry_confirmed`; holding older power adds
`held_power_with_live_telemetry`.

A cached online flag, HTTP receipt time, cumulative counter, or another device's
readings cannot establish that freshness. Invalid or future observations cannot
provide confirmation, and an explicit disconnection ends availability immediately.
Charger terminal-pair voltages can confirm that the device is reporting even when
their mapping is unsuitable for phase allocation or VI-only power estimation.

Current, voltage and power snapshots remain acquisition-only. Current snapshots
can appear in live status, but are not new historical or training signals.
Stream loss clears electrical continuity and records a gap, even if reconnect
finishes before the next acquisition. Restart also requires a new starting
snapshot; it cannot bridge the interval without an active stream. Recovered
state never fills the missing interval. The default maximum gap between usable
samples is 60 seconds. Direct total-power measurements
and all currents/voltages on the VI fallback path expire after five minutes.
Independently confirmed device telemetry has a separate 17-minute default,
following [Easee's documented online-detection window](https://developer.easee.com/changelog/ocpp-15).
This is a bounded continuity estimate, not a promise that electrical fields are
republished on every poll. Configure the window with
`acquisition.electricity_telemetry_max_age_seconds` (default `1020`). Repeated
cached API values keep their original source age; successful HTTP polling alone
cannot extend an old total-power reading. Failures, expiry, backwards timestamps
within the same measurement basis and recovery leave explicit gaps;
there is no unbounded last-value hold. Pump/phase zero transitions bypass the
numerical change threshold.

An isolated transient Easee REST backup failure retries after the configured poll
interval (15 seconds by default). Repeated failures double that delay up to
30 minutes. Authentication errors retain their 30-minute cooldown;
rate limits and other HTTP client errors retain the normal provider backoff,
and an explicit `Retry-After` is always respected, including across restart.
The strictest failed device determines a shared account cooldown. The failed
device's actual missing interval remains missing; a successfully read sibling
continues while consecutive polls remain within the integration gap limit.
Stream recovery can resume cached acquisition during a REST cooldown without
issuing requests that bypass that cooldown.

There is no time-triggered energy flush. History readers include the durable
open interval only through its latest accepted source endpoint and after its
receipt time. The UI identifies ongoing intervals; reads neither finalize them
nor extrapolate through an outage. Real power/quality changes, acquisition gaps,
session completion and shutdown finalize appropriate intervals. A charger session
boundary closes only that charger's groups, not unrelated property or Caravan data.
Open and finalized intervals share overlap, quality and source-identity checks;
long intervals are not dropped or cut off by an arbitrary history duration limit.

Charts derive interval-average kW as `kWh × 3,600,000 / durationMs`. This conversion
does not use 230 V. Equivalent chart currents divide estimated phase kW by `0.23`;
they assume 230 V and unity power factor and are not the original current readings.
Older current-only history keeps its existing 230 V estimation basis. The new
energy path takes over at its recorded boundary without double-counting the older
path. Missing intervals remain missing in energy and timing comparisons.

### Heat-pump power reconstructed from history

The application no longer records a standalone `heat_pump_power` observation.
Its chart and daily timing comparison reconstruct estimated electrical input
from committed compressor activity and auxiliary output:

`power kW = compressor activity × (nominal compressor kW + circulation kW) + auxiliary kW`

Auxiliary output uses the same configured capacity and stage interpretation as
the committed learning input. This is a nominal electrical estimate, not a heat
meter, measured heat-pump consumption or property consumption minus charging.
Requested hot-water circulation alone does not establish actual energy use.

Power assumptions are recorded when first used and whenever they change, with
an effective time and calculation version. Historical calculations use those
saved assumptions instead of today's settings. Source verification, freshness
and availability bound every reconstructed interval. Missing source data or
missing historical power assumptions leave gaps; the chart does not fill them
with live model predictions. The timing calculation uses the underlying
intervals, independently of chart point reduction and the selected view.

The imported CSV formats do not contain the necessary H66 equipment readings.
They remain useful for their recorded temperatures, prices, requests and phase
currents, but do not establish historical heat-pump consumption. The previous
standalone controller-estimate curve is not required as a migration input.

Learning samples and cycle records still contain their resolved power estimates
and provenance for replay. They are documented as learning records in the
database overview; they are not a second adaptive power series. Removing the
standalone chart series does not change the house learner's input selection.

### Charger 2 physical capture and vehicle feeds

Charger 2 records only the configured Shelly EVSE's source-timestamped native
meter deltas. Its association includes the device, MQTT broker/root, commissioned
model/firmware and phase mapping. Duplicate or older source timestamps do not
advance energy. A counter reset, implausible jump or excessive gap establishes a
new baseline and keeps missing coverage visible. Pause/resume does not split a
physical plug connection. No counter from a vehicle supplies home electricity.

Current provider status also exposes the documented Shelly `phase_info` currents,
voltages and active powers for L1–L3, mapped with the installation's `phaseMap`,
along with total active power. Native watts are converted to kW. These readings retain source and receipt times and become unavailable on source
expiry, retained delivery or disconnection. Raw snapshots remain live-only; valid
phase powers also allocate the measured total increments into adaptive phase
energy. Historical equivalent phase currents are derived from interval energy,
using the same presentation as Charger 1, and are labeled estimates.
The accumulated total and native `energy_charge` session diagnostic are kept
distinct from interval energy and finalized session checks. The integration has no native individual phase-energy counters; `ev2_energy`
remains the authoritative measured total, separate from the three estimated
phase-energy series. The phase sum and total must never both be counted as demand.

Charger standby remains measured even when automatic charging is disabled.
Changes at or below the 10 W selection floor can share a durable open interval;
the kWh include all accepted standby consumption. Routine fresh/held source-clock
flags accumulate conservatively within the interval. Real gaps, source/transport
changes and different measurement bases retain separate boundaries. Exact zero
does not require phase weights, so its absence of weight metadata alone does not
split an otherwise unchanged reported-power interval. Material starts/stops and
phase-use changes still create boundaries. Closing a session or reporting an
outage flushes its accepted tail; ordinary ticks do not append timed zero rows.

Charts read both finalized intervals and eligible durable tails. Zero is known
covered consumption, while missing telemetry remains a gap. Estimated auxiliary
power and heat-pump operating rows also use compact scalar coverage, stopping at
the last confirmed report's deadline. Extending a span refreshes chart caches
without inserting duplicate observations. See the
[27 September recorder audit](audit/RECORDER-IDLE-2026-09-27.md) for storage
findings, the retained recording costs and synthetic validation.

TeslaMate and BMW remain read-only vehicle evidence for either physical charger.
Their feed health, timestamps, plug events and home scope control applicability
of identity and planning fields. Disabling economic charging never enables a
second electrical recorder. A Tesla away from home cannot provide local voltage,
power or C2 history. Equal-power independent physical chargers both count; a
physical charger plus its vehicle feed counts once.

**Electricity consumption · Easee, Shelly EVSE** separates C1/property acquisition
from physical C2 acquisition. Vehicle logger health is a separate diagnostic.
The native Shelly role/profile and the hardware checks still required are in
[provider capabilities](charging-provider-capabilities.md). Old Tesla-as-C2
configuration/state has no translation path; only the two supported v0.7.5 CSV
import formats retain backwards compatibility.

### Diagnostic meter and session checks

Equalizer accumulated import energy (`45`) is the only cumulative counter stored
in `energy_audits`. Charger lifetime energy (`124`) and running session counters
(`121`) are neither requested nor recorded. Incompatible native development databases are rejected; completed-session
records, property counters and supported CSV imports have separate provenance. Duplicate property
timestamp/value pairs are not copied. Source timestamps, resets, out-of-order
counters and availability are retained.

The existing **Meter accuracy checks** panel shows the latest property-meter
comparison, a **Charger 1** session summary, and a **Charger 2** session summary.
There is no session list. Each charger row reports compared, excluded and recorded
session counts; mean estimated/reference kWh per compared session; and the
energy-weighted difference `100 × (sum estimate − sum reference) / sum reference`.
Incomplete sessions and zero references are excluded, with no invented zero-percent
accuracy. Property cumulative readings remain available in history.

The **Charging session checks** view compares both chargers' final reference kWh
as separate points at the session end, directly from existing session records.
The **Property meter counter** view keeps its cumulative meaning separate, using
individual readings without a connecting line.
The explorer's **All series** mode can isolate either session check or a supported cumulative
counter. No duplicate time-series rows are saved. Session readings use hollow
points; a stronger outline identifies references eligible for comparison
averages. Tooltips explain exclusions, identify the physical electricity meter
and show the session period. No continuous power or
lifetime-counter meaning is implied between session points.

**Recording-interval energy** exposes original phase increments, Charger 2's
authoritative total, Caravan intervals and qualified dedicated Garage intervals.
Each retains its original duration and source basis; these are not equal-length
period totals. Garage intervals preserve their counter-delta or integrated-power
basis and any provisional accuracy. Its native cumulative counter remains a
separate diagnostic series. Charger 2 phase allocations are alternative views of
its total, never additional electricity to add to that total.

For Charger 1, Easee observation `129` supplies authoritative finalized session boundaries and
energy; `223` supplies the current session start when available. A new finalized
session flushes pending energy once and compares all three original Easee energy
series over the same period. Duplicate polls cannot create duplicate sessions or
force repeated flushes. Conflicting finalized readings do not rewrite a check.

Charger 2 diagnostic checks belong to the physical Shelly association and plug
epoch. They compare native accumulated-meter deltas with a power-based estimate
over that exact connection. Missing start/end samples, counter resets or gaps
exclude the comparison. The native session-energy role is retained as diagnostic
telemetry until actual reset semantics are commissioned. Tesla battery-added
energy is never labeled as a C2 electricity-meter reference. Incomplete coverage
does not imply a measured accuracy percentage.

Recording diagnostics compare a valid counter increment with the sum of committed
phase-energy estimates over the same source-time period. Missing coverage prevents
a valid comparison. If an edge cuts through a recorded interval, its energy is
prorated using that interval's average and the comparison is marked as using an
estimated boundary. Differences appear in kWh and percentage; zero metered energy
does not produce a division-by-zero percentage.

**Audit values never correct history, calibrate integration, tune the house model
or determine per-signal recording thresholds.** Cumulative comparisons are computed
when diagnostics are read, including eligible durable open energy with an explicit
ongoing-interval marker; finalized session comparisons are frozen after matching
energy intervals have been committed. A cumulative counter update does not force
an extra energy record.

## Recording optimizer and storage

Permanent options:

```json
{
  "recording": {
    "annual_budget_gb": 10
  },
  "acquisition": {
    "easee_poll_seconds": 15,
    "weather_poll_minutes": 30,
    "outdoor_poll_minutes": 5,
    "market_poll_minutes": 60,
    "market_retry_minutes": 15,
    "electricity_source_max_age_seconds": 300,
    "electricity_telemetry_max_age_seconds": 1020,
    "electricity_max_gap_seconds": 60
  }
}
```

Acquisition schedules and recording settings are independent. GB means decimal
gigabytes. There is no maximum recording interval, and the retired
`max_interval_minutes` configuration is rejected. Source reporting deadlines and
acquisition schedules remain independent. No elapsed recording time can create a
new value or extend an expired source. Equal reports extend compact coverage.
The ten-GB value is a soft rolling annual growth target, not a quota that expires
in December. It never causes historical deletion or an end-of-year squeeze.

The recorder learns each continuous signal's scale from its observed variation
and uses a shared normalized change threshold. That tolerance changes gradually
in response to measured SQLite growth, using smoothed daily and weekly estimates.
Signals are compared with their last saved value. Charger energy has a 10 W
per-channel selection floor to avoid saving idle noise on every acquisition;
this selects interval boundaries, never rounds or discards accepted energy.
Other adaptive signals retain their learned thresholds without model-importance
weights. Native charger counters use a separate instantaneous-power selection
reference, because a counter can remain unchanged between quantized increments.
All room/protection temperatures use exact change recording so learning endpoints
remain actual reported values. A reporting deadline does not itself make other
continuous measurements exact: Caravan air/humidity and native pump diagnostics
remain adaptive. The displayed normalized pre-update change
compares incoming values with the previous saved value, weighted by elapsed time.
It describes variation in adaptive inputs, not reconstruction loss or a
continuous-time accuracy bound. Exact channels have no learned threshold or
normalized variation statistic.

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
re-downloads. The historical **Solar estimate** selects the latest valid estimate
known at each plotted time, using the archived forecast and its source provenance.
It is not duplicated as a synthetic one-minute solar observation or labelled as
house-measured radiation. Fetch and issuance evidence must meet the six-hour
freshness bound; that age limit is not a six-hour forecast horizon. Later
forecasts cannot revise an earlier plotted estimate or replace the version saved
with an earlier learning sample. Historical Solar estimate uses a dashed line;
the separate future **Solar forecast** uses a dash-dot line.

Charts are constructed from original finalized history and eligible durable
ongoing energy at every date range.
The database does not store hourly scalar summaries or 15-minute chart-energy
copies. Electrical power is calculated from each original recorded energy
interval, and timing comparisons split that interval at the applicable price
and day boundaries. Partial selection edges and missing periods retain their
original meaning. Imported CSV history keeps its original timestamps, units,
quality and provenance.

Historical eligibility requires both the observation's source time and receipt
time to be at or before the selected as-of time. CSV observations also require a
completed current-format import whose publication time is at or before that
cutoff. Eligibility is applied before choosing a price winner, seeding a held
value, or selecting the first recorded-energy interval. Original imported rows
remain stored; charts consume the canonical representation produced at import.
Old development import records with absent publication metadata are unsupported.

Prices retain their publication identity and revision across fetches. Within one
source document, a later fetch of a lower revision cannot replace a higher one.
ENTSO-E is primary; Elering fills uncovered periods. Equally authoritative
conflicting prices leave the overlap unavailable. Omission from a partial
publication does not establish withdrawal of earlier periods.

Energy is grouped by logical property, Charger 1, or Charger 2 scope. Original
records with overlapping interval geometries or source identities cannot both
contribute to one scope: an unresolved overlap is unavailable, and the original
rows remain for diagnosis. Exact-edge source changes retain additive energy.
Combined charging timing sums the two physical scopes and measures coverage in
charger-time; one hour of simultaneous charging is two charger-hours. The separate
charger breakdowns retain ordinary elapsed-time coverage. Missing Charger 2 data,
including the absent Charger 2 history in v0.7.5 CSVs, stays unknown.

Database indexes locate the required signals and periods. Phase-energy streams
are merged in chronological order, avoiding a large intermediate SQL sort.
Chart point reduction happens in memory: endpoints, extrema and gap markers
keep the response bounded without determining energy or costs. The point target
sets display buckets, not an exact count of returned marks. A bucket retains up
to eight gap markers; if that bound is exceeded, its affected interior is marked
unavailable instead of connecting finite values across a missing period. Power
selection includes extrema of every subset of auxiliary power and both chargers.
Interval kWh series use separate marks, with their original interval metadata.
The worker's bounded response cache also lives only in memory. Meter-audit and
finalized-session revisions invalidate it, as do newly eligible receipts and
import publications when the as-of clock changes. Unrelated operational events
do not invalidate history. Learning and meter-audit calculations continue to use
their own committed source inputs.

The current schema has no persisted chart-cache tables. Actual
annual size and year-query latency must be measured on the deployment; no
Raspberry Pi 5 timing guarantee follows from desktop tests.

## Recording policies and complete database inventory

`src/domain/recording-policy.js` is the shared policy catalogue used by the writer,
status API and database inventory. Each recorder observation saves its policy.
**Adaptive measurements** lists only streams actually observed with a learned
numeric threshold: equipment/weather continuous measurements, Caravan air and
humidity, and property/charger/Caravan interval energy. It does not populate
unobserved chart options or mix exact contacts into the adaptive table.

**Other recorded data** accounts for every other physical table and writer:

- Room and garage protection temperatures: initial value and every real change,
  plus availability/quality transitions; unchanged reports extend coverage.
- Equipment states, alarms, settings and runtime/meter counters: every change,
  without a numeric tolerance. This includes the four individual floor override
  outputs and actual tariff relay feedback. Contact readback proves an electrical
  output, not valve position, water flow or successful heat reduction.
- Hot-water circulation feedback: initial state and exact state, quality or
  availability changes. Unchanged ON/OFF reports extend compact coverage;
  periodic feeds retain their configured deadline and event-only feeds retain
  their last reported state until a new report or explicit outage. Raw watts
  remain live-only; requested pulses are separate.
- Garage compressor activity and reported defrost: exact state changes. Native
  interpreted temperature and compressor frequency belong in Adaptive measurements. Garage power
  remains live input only. Qualified dedicated garage energy intervals and saved
  garage learning inputs retain their own independent history.
- External temperature feed: no numeric history and no routine renewal events.
  Diagnostic events record abnormal onset, changed reason and recovery once.
  Current command/restoration state remains durable separately.
- Calculated outputs, requests, market/weather snapshots, manual inputs, learning
  journals, session checks, imported rows and provenance, source corrections,
  recovery records, bounded statistics and overwritten operational state each
  have their own saving rules and retention description.

The inventory reports actual stream and event-type counts, units/basis, dates,
write behaviour and retention. It lists unregistered stored writers explicitly
instead of silently guessing that they are adaptive. Physical-table counts provide
an independent completeness check; overlapping views and provenance counts must
not be added to those totals. No private device identifiers, topics, credentials,
source paths or payload values are exposed by the inventory.

Multiple devices with the same signal/source have stable opaque stream references.
A changed unit or recording policy creates a separate stream so earlier adaptive
history stays visible with its own units, threshold and saving statistics.

Average saving intervals use the first/last actual saved receipt timestamps within
the selected one-hour/day/week window, and require at least two records. Exact
hourly metrics plus indexed partial-hour boundaries avoid repeated full-week
scans on control ticks. Approximate
byte and variation metrics remain labeled as such. Current open energy is shown
separately from finalized observation counts. The annual target measures overall
SQLite growth; mandatory exact/history records are never dropped to meet it.

This recording contract uses database schema 15. An incompatible development
schema is rejected before mutation with fresh-database guidance; no migration,
backfill or automatic reset is provided. Supported read-only v0.7.5 CSV import,
current-version restart, backup/restore and deterministic journal replay remain.

Current-format history recovery also reads the frozen donor's durable open energy.
Accepted intervals become immutable observations with recovery provenance; donor
accumulators and live control state are not copied. Energy phase cohorts are
accepted together or rejected together. Existing master history and its durable
open intervals win conflicts, and retries cannot duplicate accepted energy.
If a later live acquisition straddles recovered history, that indivisible local
interval is skipped, its uncovered remainder stays explicitly unknown, and the
next acquisition resumes from its own new endpoint. No donor total is prorated
to fill a partial overlap. The inventory lists saved adaptive datasets even when
recovery intentionally did not copy their original recorder checkpoints.

## Chart curves and popup meanings

Every plotted temperature in °C uses Chart.js' monotone cubic Hermite
interpolation on either axis. This includes measured air and liquid temperatures,
saved temperature inputs, learned temperatures, forecasts, temperature-valued
settings and references, targets and temperature differences. This uses linear
time and storage in the number of displayed points, keeps local extrema and
avoids overshooting neighboring values. Constant or two-point runs naturally
stay flat or straight. Unknown or unavailable intervals break the curve.
Smoothing temperature-valued settings and room boosts is a display choice;
their recorded changes, actual commands, control interpretation and learning
remain unchanged. Prices, energy, power, categorical states and model
coefficients retain their own display semantics.

Runtime readings and native cumulative counters appear as individual hollow
points without connecting lines; a reading does not prove a value throughout the
time between reports. Interval-energy totals and session checks also use larger
hollow markers, with expanded hover and touch targets. Eligible session checks
have a stronger marker outline. Isolated actual samples receive a visible hollow
marker too. Synthetic display boundaries and carried-forward tails do not acquire
observation markers. Manual additions and daily outcomes keep their existing
distinct shapes and status meanings.

Hovering or tapping a point selects the nearest target in both screen directions,
instead of letting a vertically aligned reading in another series take its
tooltip. Larger report markers keep their expanded hit area against dense price
samples. Away from point targets, the shared nearest-time comparison remains.

Interval-based temperature curves use original interval-start values as knots,
with the final held edge retained; artificial duplicate hold edges do not force a
staircase. Periodic coverage endpoints likewise retain their recorded availability
bounds without forcing a separate plateau at every repeated report. Original
intervals remain available in the popup. Curves are
display interpolation, not additional measurements. The journal, recordings,
CSV imports, energy calculations and learning inputs are unchanged. Clipped
display boundaries and held tails are identified as such; a curve cannot provide
more measurement detail than its source samples.

Every series uses the same popup structure: its timestamp or actual recorded
interval appears in the title in Finnish time, with year and UTC offset; the
body gives **name: value and unit**, followed by applicable source, estimate,
quality or model details. Matching intervals share one title. When shared hover
includes different intervals or endpoint readings, the title groups and names
those periods so values can still be compared without repeating dates after
each value. An original sensor observation time or model-update time is a
different event and keeps its explicit provenance label. Text wraps to the
available chart width. Desktop popups work in both views; touch devices show
them only in fullscreen, in portrait and landscape, and clear them on exit.

**Eligible for learning** means that a *saved learning input* passed the original
recorded quality checks. It does not claim that a fit used it or changed the model.
**Excluded from learning** means those checks rejected that input. A saved indoor
average can therefore remain visible while its learning window was rejected for
another missing input. Missing/rejected interval inputs still appear as gaps.
Inputs without recorded eligibility say **learning eligibility unavailable**.

These labels apply to saved inputs, not to every plotted sensor, forecast,
coefficient or model assessment. An unlabelled point does **not** imply inclusion
in training: the saved input journal determines eligibility for each learning
window. Calculated fireplace release retains its separate calculated-input
description. Meter checks and Caravan plug readings explicitly say **not used
for learning**; inclusion/exclusion in *session averages* concerns only the
meter comparison and is independent of learning. No learning gates or algorithm
versions change for this presentation update.

## Chart exploration and fullscreen

The button at the chart's top right shows the active view or series and opens a
centered explorer. Its **Views** mode offers searchable, grouped named comparisons;
**All series** offers the 124 supported historical projections: recorded
measurements and states, interval energy, counters, saved learning inputs,
replayed coefficients and supported calculations. It includes individual
diagnostics beyond the named views and retains entries with no records in the
current installation or date range. It is a catalogue of defined chart meanings,
not access to every numeric database field or current-state JSON value.

Search filters labels, units and canonical signal identifiers. Switching modes
or searching leaves the current chart unchanged; choosing a result applies it
and closes the explorer. Reopening starts in the active chart's mode, with each
mode's search retained separately. **Close**, Escape or clicking outside dismisses
the window and returns focus to the selection button; arrow keys with Enter
select a result. The window stays centered on phones and in fullscreen.
An individual-series chart plots the selected series, plus the globally
controlled electricity prices. Categorical series use
an activity row; selecting a sparse series does not manufacture missing history.

The chart icon button beside the selection button opens a view with both date
pickers, gesture navigation and a selected-period navigator. The normal chart is
fixed to the entire selected period, with no zoom controls or navigator.
**Exit** restores that fixed chart. Reopening chart view
resumes its previous zoom and position while the selected dates remain the same.
The Garage chart shortcut opens the same view.

Chart view requests page fullscreen when available. If the dashboard was already
in page fullscreen, **Exit** keeps it there; otherwise **Exit** leaves page
fullscreen. Leaving fullscreen through Escape or another browser action keeps
chart view open. **Exit** then leaves the dashboard outside page fullscreen.
If page fullscreen is re-entered before **Exit**, the original entry state once
again determines whether fullscreen is kept. The header's fullscreen icon follows
page fullscreen changes from any control. Browser-level fullscreen such as F11
is separate and cannot be tracked or controlled consistently by the page.

The chart view keeps its selection button, Exit button and two compact date pickers
visible. Selecting the first date immediately shows that day; the second extends
the inclusive range. **Legend** is a fold on every screen size, with a scrollable
list and a **Reset view** button that stays visible. In fullscreen, opening the
fold hides the activity strips; closing it restores them. Short windows also
hide the navigator while the legend is open. Escape inside the legend closes it
and returns focus to the title. Group headings describe their available series:
price-only groups say **Price**, with no temperature label. All activity icons
use the same stripe style and a representative active-state colour. Left-axis
history uses solid lines and right-axis temperatures use dashed lines. Future
forecasts use dash-dot lines and electricity prices remain dotted. All plotted temperatures, including settings
and targets, share monotone cubic interpolation within covered spans. Categorical
states and electrical power retain steps. Events, session checks and original
interval-energy totals remain points. Charger fills retain their electricity
meaning. In **Phase loading**, charger currents stack only within their own
phase and only where the original evidence overlaps; property-phase lines remain
independent references. Control and equipment states use labeled rows below the
plot. The **Home compressor** row combines verified stopped, space-heating,
hot-water and running-with-unknown-routing intervals. Compressor and routing
reports expire independently: expired routing can leave a fresh running
compressor with unknown routing, while missing, stale or unverified compressor
data stays blank. Off is shown only when reported, never inferred from silence.
Every row title expands to explain its evidence and all colour and pattern
meanings, including missing intervals. Wide layouts also show a compact key
beside the title; phones keep the colours inside the fold. Hovering or dragging
a strip moves the shared time cursor, including by touch. Its separate segments
appear only in the plot and visible strips, leaving titles and gaps clear.
Scrolling the activity rows or opening their explanations preserves their exact
alignment with the plot at both time-axis endpoints.
Landscape shows the entire selected time window at baseline zoom. Portrait uses
the full available chart height and shows a narrower time slice; drag sideways
or use the navigator to move through the selection even at baseline zoom.
Rotation preserves magnification and the visible center where the date boundaries
allow it. Axes and controls stay within the screen.

In chart view, pinch or the mouse wheel on the plot zooms around the gesture
position, and dragging the plot pans. Indicator strips inspect time without
zooming or panning. With the chart focused, +/− zoom,
arrow keys pan, and Home resets. Outside chart view, wheel, keyboard and touch
retain their normal page behavior except for touch inspection on the strips;
they do not zoom or pan the chart. The applied
Finnish dates are fixed until another date, preset or date-navigation action is explicitly applied,
including across midnight. Zooming, theme/series changes, refresh and fullscreen
transitions never expand those dates. Reset restores baseline zoom; portrait still
shows a movable slice. Native browser fullscreen is used when available, with a
viewport-filling fallback for browsers and embedded views that do not allow it.

Gesture frames transform the currently rendered plot bitmap and activity strips.
After movement settles, the chart redraws from loaded data and requests finer
detail for an overlapping, bounded viewport when useful. The detail loader keeps
one request in flight, coalesces later movement, ignores obsolete results and
retains eight responses in memory for 30 seconds. Routine observation updates do
not repeatedly abort slow historical detail queries. Selection/source changes and
model corrections invalidate detail; closing the chart cleans up pending work.

Zooming retains every already loaded point in the visible interval, including
neighboring step edges, missing-data breaks and tooltip provenance. It does not
apply another drawing reduction or lower precision when a redraw is slow.
Refinement keeps the initial 800-bucket target and requests an overlapping window
when its buckets improve on the finest cached covering response by about 20%.
All series and activity tracks use one complete response at that resolution;
late coarser responses cannot replace finer covering data. Expired detail stays
visible while it refreshes. Aligned stepped load and phase fills are drawn in one
pass through their supported segments, avoiding repeated searches across gaps.
Zoom currently stops at a one-minute visible interval, independently of network
latency. This does not imply one-minute observations: source cadence, daily totals,
committed learning intervals and missing history retain their existing meaning.
Tooltips identify clipped interpolated/held scalar boundaries as display points.

`/api/chart` optionally accepts both `viewFrom` and `viewTo` as integer UTC
milliseconds within the selected `start`/`end` dates. A detail response has the
queried `range`, the full calendar `selection`, and `meta.detail: true`. It omits
`timingBenefit`, `heatingBenefit` and `firewoodBenefit`; existing cost comparisons
continue to describe the full selection. Daily firewood outcome points still use
their whole-day calculation. Necessary source context can be read around a
viewport. Temperature series retain at most eight neighbouring vertices on each
side, marked `displayContext`, so fetched detail uses real source knots for cubic
tangents. The visible viewport remains fixed; these neighbours do not become
extra observations or extend the selected dates. Other series remain clipped.

Initial multi-year loading is unchanged. Fine detail can arrive later than the
gesture, and some reconstructed series still require an earlier journal prefix.
The current view stays available during loading or failure. No chart summary
tables, model snapshots or additional recorded history are introduced. Browser
checks use synthetic data in desktop, portrait and landscape viewports; they do
not establish a frame-rate guarantee for physical phones or slower servers.

## H66 dataset and model roles

The dataset retains **28 H66 variables**. Outdoor register `0007` remains a live
pump diagnostic but is excluded from temperature history and learning. The unused indoor sensor (`0008`),
`discharge_temperature` (`0012`) and
`brine_pump_active` (`1A04`) are omitted from new acquisition. Existing historical
rows are not deleted, and old installation verification metadata for those
registers does not prevent startup. Brine pump speed remains; its zero transitions
are always recorded. A separate active-state measurement is not stored.

| Group | Recorded H66 signals | Typical model role |
| --- | --- | --- |
| Temperatures | Outdoor register excluded | No weather or learning input |
| Heating water | Supply, return, supply target | Equipment context |
| Ground loop | Brine in, brine out, brine pump speed | History/diagnostics |
| Hot water | DHW temperature, DHW routing, DHW start/stop settings | Separate hot-water context |
| Heating activity | Compressor active, heating pump active, heating pump speed, auxiliary output, heating integral | Heat-input attribution and equipment context |
| Runtime counters | Compressor hours, DHW hours, auxiliary 3 kW hours, auxiliary 6 kW hours | Reconciliation/diagnostics |
| Settings/mode | Room setting, operating mode, room influence, heating curve, maximum supply, heat-stop and tariff-reduction settings | Explain controller behaviour/settings changes |
| Alarms | Alarm active, alarm code | Abnormal-operation context |

The local Upstairs, Bedroom and Downstairs sensors are recorded separately from
H66 acquisition. H66 indoor register `0008` is ignored and cannot supply a fallback.
The house model uses the configured indoor average described below.
Garage rear and front temperatures are additional to those 29 and feed the
separate [garage learner and protection controller](garage.md).
Collecting another temperature does not add a free house-model coefficient.

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

Windows retain input segments at control, source, compressor, routing and AUX
changes. Controller context is an immutable dated request, distinct from physical
heat readback. Joint compressor/routing integration preserves mixed space-heating
and DHW periods. Missing earlier context cannot be supplied by today's phase.
Coverage prefixes remain stable when later polls extend a span; delayed arrivals
do not retrospectively fill a period when no fresh information was available.

Samples, complete episode updates and reference-context changes enter an immutable ordered `learning_journal`
with algorithm version, configuration digest and configuration snapshot. Live
updates and rebuilding use the same journal-entry function. The journal stores an
explicit initial seed when adopting an existing model; original discarded source
polls are not required to reproduce subsequent learning. Older imported history is
resampled causally with bounded holds, retaining unknown heating/solar information.

The current algorithm is `committed-house-v13-scoped-sensor-changes`. Saved configuration retains
source-output assumptions, selected-slab priors, the relative ROOM increase and the
bounded recovery policy. Changed equipment assumptions invalidate affected
equipment/cost calibration. Checkpoint digests and journal-prefix identity detect
accidental corruption and trigger replay. They are integrity checks, not authentication.
Only this current native algorithm and segmented sensor-input payload are supported. Older development algorithms and checkpoints are rejected; they are neither archived for execution nor translated.

Restart replays durable entries not yet applied to the checkpoint. The internal
`replayLearningJournal(store, input, checkpoint, {rebuild: true})` path can rebuild
from the journal; there is no separate public rebuild CLI. Reproduction requires
the supported recorded algorithm version. Before v1.0.0, incompatible algorithm
changes require a deliberate fresh development database and optional read-only
v0.7.5 CSV re-import. There is no older algorithm interpreter or migration. Later edits to forecast or coverage data do
not change already resolved journal inputs.

The fireplace source is a compact immutable load/removal log. Its selected revision
is also required for replay; resolved fireplace inputs are derived without copying
the log into each learning entry. Corrections rebuild in a worker and publish a
complete caught-up checkpoint. See [the mandatory reconstruction and versioning
contract](reconstruction-and-versioning.md) and [fireplace behavior](fireplace.md).
This does not expand the storage contract to full control-choice replay.

## Local MQTT temperature sensors and interface

Indoor and garage temperature acquisition uses the existing local MQTT broker in
both `providers` and `mqtt` input modes. H66 is not required. Public topic defaults
are in `config.json` under `options.equipment.devices`, with one explicit connection
line per device:

| Equipment entry | Connection format | Recorded signal | Display name |
| --- | --- | --- | --- |
| `upstairs` | `mqtt:<exact topic>` | `indoor_temperature` | Upstairs |
| `bedroom` | `mqtt:<exact topic>` | `bedroom_temperature` | Bedroom |
| `downstairs` | `mqtt:<exact topic>` | `downstairs_temperature` | Downstairs |
| `garage` | `shelly:<native prefix>` or `mqtt:<exact topic>` | `garage_temperature` | Garage temperature |

See [MQTT equipment](mqtt-equipment.md) for setup, the second garage probe, door
states, and the device list schema. The connection line selects the handler;
there is no protocol detection or source fallback. Broker credentials stay in the
private configuration and topics need not be duplicated there. Retired individual
`mqtt.*_temperature_topic` fields are rejected; use current equipment entries.

All indoor locations are recorded separately; an individual sensor failure does
not replace the other readings. Existing signals, CSV meanings, reporting metadata
and original temperature history remain unchanged. H66 cannot provide an indoor
input. The indoor reporting contract
remains controlled by these shared settings:

```json
{
  "mqtt": {
    "temperature_report_interval_minutes": 70,
    "temperature_report_grace_seconds": 300
  }
}
```

The installed room sensors can take 70 minutes to report an unchanged value.
The five-minute grace gives an exact 75-minute expiry. No age warning is raised
before that deadline; at the deadline the reading is outdated and unavailable
for learning. This changes the report deadline, not temperature row spacing or
15-minute learning windows.
See [the timing and installation instructions](smartthings-temperature-rule.md#matching-the-st-mq-report-deadline).
Installing the driver does not add a recorded input or forwarding Rule; configure
each intended source and its model membership separately.

Current `equipment.devices` entries select a `mqtt:` connection and the canonical
signal: `indoor_temperature`, `downstairs_temperature`, `bedroom_temperature`,
`garage_temperature` (rear) or `garage_temperature_2` (front). The payload can be a JSON
number in Celsius, or an object such as
`{"value":12.5,"unit":"C","timestamp":"2026-01-01T12:00:00Z"}`. Units `C`, `degC`,
`°C` and `F` are accepted; a supplied timestamp must include its time zone or be
epoch milliseconds. Without a timestamp, a non-retained publication uses labelled
MQTT receipt time. Retained data never gains a new measurement time on reconnect.
Retained data can be displayed with its original timestamp, but does not confirm
a new sensor report or establish usable periodic coverage. Without a source
timestamp, retained data cannot establish a new reading.
Give each sensor a distinct exact local topic; the per-room fields do not accept the wildcard
`stmq/home/+/status/temperature`.
Broker disconnection records explicit unavailable transitions for configured
temperature sensors and included H66 signals. Reconnection alone does not confirm
a fresh sensor measurement. Periodic indoor coverage ends immediately on a known
outage. Garage readings expire two minutes after their last genuine report,
whether the single configured connection uses Shelly or MQTT. Direct Shelly
status is requested every 30 seconds; a standard MQTT publisher should report
within one minute, including unchanged values. A broker heartbeat does not renew
the measurement clock. Outdoor temperature and H66 control signals retain their own freshness
and availability requirements. Subscription failures are recorded separately from
unchanged sensor values.

The model's indoor temperature defaults to an equal average of Upstairs
and each configured extra indoor sensor: Upstairs, Bedroom and Downstairs each
contribute one third when all three are configured. Membership is fixed by
configuration, including sensors temporarily missing or stale. It does not change when one
sensor stops reporting. The garage is excluded. Optional
`controller.indoor_sensor_weights` assigns nonnegative weights by indoor signal
name. Its default empty object `{}` selects the automatic equal average;
omitting the whole setting has the same meaning. Within a nonempty map, omitted
or zero-weight sensors do not contribute. At least one weight in that map must
be positive, and positive weights require the relevant extra sensor to be
configured. For example, with both extra sensors configured,
`{"indoor_temperature":1,"downstairs_temperature":2,"bedroom_temperature":2}`
gives Upstairs one fifth of the contribution. Weights are normalized and
saved with learning configuration using logical signal names, without private
device identifiers or MQTT topics. Adding or changing contributing sensors changes the
measurement setup; it must establish the corresponding learning boundary.

Indoor MQTT topics default to a genuine report every 70 minutes with 300 seconds
of grace. The interval and grace settings above are independent of recorder
spacing. An unchanged report extends a compact coverage span; only value changes
and quality/availability transitions require temperature observation rows. A
missed deadline ends the chart line, and recovery starts a new segment even at
the same value. No fixed five- or fifteen-minute duplicate temperature writes
are needed. Repeated source timestamps, MQTT retransmissions and retained data
cannot renew coverage. Timer-based cached republishes must not feed these topics.

Set `temperature_report_interval_minutes` to `0` for indoor publishers that only
report changes. After the next genuine report, this selects their old indefinite
last-known-value behavior. Enabling or changing a periodic deadline records one
forward-only configuration boundary. A recent genuine report can remain valid
under the new deadline from that boundary onward; no old gap is filled and no
new sensor report is invented. Explicit acquisition failures and sensor-change
exclusions still require recovery evidence. Periodic
indoor outages instead make the configured average unavailable and suspend
thermal and comfort learning across the affected interval. No room is removed
from the weights or estimated from another room. Normal heating stays available.
Sensor changes still require a genuine reading from the new measurement period.
See [SmartThings forwarding](smartthings-temperature-rule.md) for the rule and
physical-driver requirements: configuring an interval alone does not establish
that unchanged genuine reports reach MQTT.

Views offer **Average indoor** as the same configured average used by the model,
retaining its green colour alongside blue Outdoor readings. **Property
temperatures** compares Upstairs, Bedroom, Downstairs and both Garage probes on
one right temperature axis. **Home temperatures & comfort** focuses on home
rooms, the saved average and reference. Each view keeps its own deliberate
temperature choices. Room colours remain distinct; Garage front and rear use
related shades. Temperatures use the same interpolation rules throughout these
views, while missing and expired coverage still breaks the curves.
Average indoor reads the resolved value already included in each existing
15-minute learning journal record; it creates no additional temperature recorder
channel or chart-history table. V8 additionally requires indoor report coverage
through the window; other missing learning inputs do not hide a covered indoor
average. Missing indoor coverage and missing windows remain gaps. Unsupported
development algorithms are rejected; only the current journal contract is replayed. Changing
configured weights does not recalculate historical inputs. The journal
retains the original endpoints, weights and configuration needed for model replay.
Historical CSV `temp_in` remains an Upstairs reading and is never presented as a
three-room average. Saved learning-input tooltip rows use a short marker without
repeating their journal source and interval beside each value. New saved-average
tooltips additionally identify held rooms, actual observation times and whether
the window was excluded from learning.
Sensor replacements, moves and calibrations are recorded under **Home → Heating configuration → Home learning → Model inputs → Average indoor → Sensor changes**. See
[sensor changes](temperature-sensors.md#replacing-moving-or-adjusting-a-sensor)
for their learning boundary and descriptive reason field.
The explorer's **All series** mode groups historical signals into temperature,
heating, hot-water, ground-loop, settings, equipment, runtime, electricity, weather
and learning groups.
Recorded and calculated roles are separate from model roles.

**Recording details describes stored database contents.** The first fold,
**Adaptive measurements**, contains achieved intervals, learned thresholds,
freshness and growth. Its explanation distinguishes fast acquisition from
recording changes against the last saved value, and describes the shared rolling
storage objective. An average recording interval is not a fixed poll schedule.

The **Other recorded data** fold appears immediately after **Adaptive measurements**,
followed by **Meter accuracy checks** and **Export database**. It
describes the remaining datasets using field lists, counts, available dates and
the way each dataset is updated. Groups cover:

- Forecast temperature and radiation versions, shared content and fetch references.
- Spot prices and dated contract components.
- Recorded controller phases, circulation requests and learning chart metrics.
- Learning samples, episodes, replay configuration and assessments.
- Current settings and checkpoints, explicitly distinguished from retained history.
- Easee/st-mq CSV imports, manual counters and historical annotations.
- Availability coverage, recorder statistics and storage support.

An empty dataset is identified as empty rather than inferred to contain
measurements. The overview does not expose configuration values, private device
identifiers, import paths or arbitrary event payloads. Storage support records
explain database growth without presenting them as additional physical sensors
or model inputs. Purely reconstructed chart values are not listed as independent
stored series; persisted calculated learning results are described as such.
The overview explains that chart point reduction and response caching use RAM,
while the retained SQLite indexes support queries over original records. Storage
accounting lists all 18 physical tables and separately identifies the three SQL
views; there are no persisted chart summaries
or chart-summary bookkeeping entries.

Database inventory queries are read-only and requested when the other-data fold
is open. A bounded worker query and cache keep large inventories out of the live
control loop. Expand/collapse state survives updates. Meter-accuracy details
show the property cumulative-meter check and the two charger session summaries
without changing the learner.

Selecting the house model's inputs and explaining their source dependencies,
transformations and averaging windows is a separate interface concern. The
database inventory does not claim that recording a parameter makes it a fitted
model input.

Views longer than seven days normally refresh at five-minute intervals. Periodic
temperature reports and availability changes refresh any view containing today
promptly, including unchanged reports, so a cached deadline cannot create a false
gap. Ordinary raw polls and recorder checkpoints do not force a long history
download. Short views react to new committed data, including the durable open
energy interval. The chart query runs in a separate worker with bounded memory
and a cancellable queue, so a large query does not block the control event loop.
The **Energy cost comparisons** fold starts closed beneath the chart, alongside
**Recording details**. **Heating**, **Charging** and **Firewood** summary boxes
align in three columns when space allows and stack on narrow screens.
Their details folds expand independently for energy sources, timestamps and coverage. Shared
explanations come last in a centered column. The folds support keyboard and
touch and keep their state across chart refreshes and date changes.

Both headline percentages mean included time divided by the selected elapsed time;
future hours do not enter that denominator. Charging includes only recorded periods
above 100 W with complete daily prices; idle periods at or below 100 W contribute
neither energy nor time to its comparison. Missing readings remain unknown, rather
than idle. Heating continues to include valid zero-consumption time. Source and
rate-assumption percentages describe shares of included time for either device.
The daily average price still spans the full Finnish day. These rules affect the
comparison only; original energy records, chart series and CSV import interpretation
remain unchanged.

Firewood is a separate estimated reduction in space-heating electricity under a
paired normal-heating reference, with free wood, a scenario range and explicit
coverage. It is not included in a combined total with the timing comparisons.
Remaining forecast savings are separate from past estimates. All fireplace chart
and savings data are derived on demand without new telemetry or daily savings rows;
see [fireplace logging](fireplace.md#visibility-and-estimated-savings).

The **Property meter counter** and **Charging session checks** views preserve
these distinct quantities. The explorer's **All series** mode can isolate either charger's
session reference, independently of recorded interval energy.

## Synthetic year benchmark

Run `node scripts/benchmark-recorder.js --days 365 --max-seconds 180` for an
isolated synthetic benchmark. It creates and removes its own temporary database;
it does not open production history or configuration. `--profile` profiles query
work only and reports the hottest functions. It also measures the uncached
database overview and seeds nominal power assumptions to exercise heat-pump
reconstruction from the synthetic H66 records.

The following older benchmark predates the current recording contract and its
additional Charger 2 phases and indexes. It is retained as a dated comparison,
not a measurement of the current recorder. On the development Ryzen 5 1600 host
with Node 22.19.0, six electrical series every
minute plus all 30 H66 series every five minutes produced 6,307,200 observations
and a 2.88 GB database using original history only. The previous equivalent
workload with chart summaries occupied about 4.02 GB: removing those summaries
saves approximately 1.15 GB, or 28%, at the same recording cadence.

With heat-pump reconstruction enabled, one power-chart query took 208 ms for a
day, 1.06 seconds for a week, 4.18 seconds for a month, and 48.71 seconds for a
year. Queries bypassed the application response cache and used the worker's
8 MiB SQLite cache and file-backed temporary storage settings. They ran in that
order after population; operating-system cache state was not controlled, so
these are single-run timings, not guaranteed cold-query latencies. The year
response was about 1.21 MB and 12,512 points. The uncached database overview took
8.60 seconds to summarize all 15 tables and returned about 38 kB. Its worker
caches the result for five minutes and reports the original snapshot time. Peak
process RSS was 186 MiB across population and queries, excluding the operating
system's file cache.

This measures the core observation workload, **not total application growth**:
forecasts, learning journals, coverage, checkpoints and event logs add storage.
Only one initial nominal-power configuration is included in this workload.
Population uses bulk inserts of original observations, so its duration does not
measure live recorder write throughput. The workload has no price data;
tariff correctness is tested separately. These are host measurements, not Raspberry
Pi 5 timings. Full-year cold queries remain substantial; the worker and slower
long-view refresh keep them outside the control loop. The live optimizer measures
actual database growth, including those additional tables, against the configured
soft target.

### Reversible sensor changes

Sensor-change recording leaves acquisition and stored observations intact. Learning saves the original temperature
inputs needed to undo a reset's exclusions as a compact patch on affected samples.
Periodic report coverage remains bounded to the original window; undo cannot
fill genuine sensor outages. The journal, its seed/configuration and selected
sensor/fireplace corrections reproduce the model without rereading mutable
provider state. **Revert and relearn** runs in the background and preserves both
the original maintenance event and its reversal. See
[temperature sensors](temperature-sensors.md#replacing-moving-or-adjusting-a-sensor)
for the indoor and outdoor maintenance controls, confirmation and rebuild status.

## Caravan monitoring

Caravan temperature and relative humidity are separate recorded Shelly BLU H&T
series with the configured source deadline; battery and Bluetooth signal strength
remain live-only. One categorical dehumidifier series combines reported power and
fan setting: Off, Low, Medium, High or Auto. Unknown/offline data stays a gap;
commands and other dehumidifier settings are not recorded as measurements.

Caravan energy uses the same adaptive interval recorder as property and charging
energy. Its input is the measured difference between successive meter counters,
not an estimate from watts. The recorder chooses interval lengths from changes in
the measured interval power and the shared recording budget. There is no maximum
recording interval. A durable open interval remains available to history readers
without forcing extra observations.
All measured increments are conserved when compacted. First reports establish a
baseline; counter resets, excessive gaps and implausible jumps interrupt coverage.
Pending increments are checkpointed with the counter and daily total. Caravan
measurements do not enter either heating learner.

The **Caravan power** view shows interval-average power in kW alongside air temperature
and the reported dehumidifier state. Power is calculated from each original
metered energy increment divided by that interval's own duration; adaptive
intervals need not have equal lengths. Gaps remain gaps, pending intervals keep
their pending marker, and point inspection retains original boundaries and meter
provenance. Live watt readings cannot supply this history. Original kWh increments
remain available through **Recording-interval energy** and the explorer's **All series** mode.
This projection creates no new recordings and does not enter household demand,
charger timing comparisons or heating learning.


## Chart and storage review (September 2026)

The explorer separates everyday electricity, room, caravan and garage pump views
from Home/Garage saved learning inputs, replayed coefficients and equipment
diagnostics. Each choice states its unit and basis. A plot is not a promise of
another database channel: power, phase-current estimates, indoor average,
front–rear difference, coefficients, fireplace response and compressor activity rows
are projections of existing observations, energy intervals or journal inputs.

The retained data has distinct responsibilities:

| Data | Why retained |
| --- | --- |
| Phase/total energy intervals | Original integration result; acquired current, voltage and power polls are not separately archived. |
| Adaptive source measurements and compact coverage | Values, original measurement times and proven report continuity; freshness cannot be reconstructed from value changes alone. |
| Learning journal, compact manual corrections and seeds | Frozen normalized inputs, source/configuration meaning and deterministic replay; a later query must not substitute today's input interpretation. |
| Dated power assumptions and controller auxiliary estimates | Historical equipment interpretation and the estimate actually available to control; not separately measured heat-pump electricity. |
| Learning outcome assessments and cycle events | Original assessment known at that time, kept distinct from corrected replay. |
| Meter/session checks | Independent reference evidence for accuracy; not duplicate energy contributions. |
| Native garage pump interpreted indoor temperature/frequency | Adaptive observed diagnostics with explicit validity bounds; separate from room/protection sensor measurements. |
| Native garage compressor activity and defrost | Exact observed state changes; no inferred fault or defrost interpretation from arbitrary diagnostic bytes. |
| External feed diagnostics | Abnormal onset, changed reason and recovery events; no numeric feed series or healthy renewal log. |

The Garage view offers native compressor activity, supported defrost reports and
door contacts as separate activity rows. **Pump power readback** uses the saved
fresh native on/off report. **Managed pause** records that savings control or a
timed-off request held the pump paused; it does not prove measured savings or an
automatic-only cause. These two saved-input rows keep reported power distinct
from the recorded reason for a control pause. Native states follow their recorded
availability deadlines; unknown periods remain unknown, never inferred off.
The pump's interpreted indoor reading is available beside the front/rear probes
and independently in the explorer's **All series** mode. It may incorporate its external feed
and is not relabeled as a physical room sensor. Hot-water circulation requests
and recorded electrical or switch feedback have separate rows; neither proves
water flow. Floor override contacts describe electrical readback, not valve
position or heating delivery. External feed failures and recoveries remain
diagnostics outside adaptive measurements. These views add no heat estimates
or learning inputs.
This review does not delete historical evidence, introduce a second schema, or
backfill charts from current live readings.

## Single-file database export

Open **Recording details → Export database** and choose:

- **Save local copy** saves on the server, in `recording.export_directory`.
  The default `"~"` means the home folder of the operating-system account running
  the application, including inside an add-on/container. Set an absolute path or
  a home-relative path such as `"~/database-exports"` in configuration to choose
  another location. The saved file's full path is shown after success.
- **Download database** saves to the browser's computer. Supporting browsers
  prompt for a destination and stream directly to the selected file. Other
  browsers buffer the response and use their usual download settings.

Both actions use the same filename format, for example
`stmq-2026-09-25T15-04-32-123Z.sqlite`: date, time, milliseconds and `Z` for UTC.
The browser file picker suggests the download's start time; the download fallback
uses the server's snapshot filename. An existing server export is never overwritten;
simultaneous timestamp collisions get a distinguishing suffix.

The SQLite online backup API copies the current committed database, including WAL
pages, into one private file. Recording continues; the file represents a consistent
snapshot and does not promise to include later writes. Only the copy switches to
DELETE journal mode, so it can be opened without WAL/SHM companion files. There is
no checkpoint or overwrite of the running database. Server copies use mode `0600`;
new export directories use mode `0700`. A copy is published only after completion.

The web API accepts no destination path: authenticated `POST /api/database-export`
with an empty JSON object saves in the configured server folder, and authenticated
`GET /api/database-export` downloads a temporary snapshot. Temporary files are removed
on completion, failure or disconnection. Only one export runs at a time per web
server. Normal web/ingress authentication applies and is checked again before the
copy is saved or sent. Replica exports hold the verified snapshot they began with
until the operation completes.

An export includes private history and saved application state. Retain the matching
software version for model replay; restore remains the existing offline operation
into a new database path. The export does not contain the separate private
configuration file or external token files.
