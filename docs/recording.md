# Adaptive recording and reproducible house learning

Acquisition, recording and house learning have separate responsibilities. Devices
can be read frequently while history retains a compact approximation. Only
committed history and its recorded interpretation feed the learner. Recording a
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
| Easee charger and Equalizer | REST every 15 seconds; one batched observations request per configured device | The endpoint returns last-reported observations. Polling faster does not force new measurements. |
| TeslaMate | MQTT on the existing broker; integration checked every five seconds | Changed fields arrive separately. Live health and increasing session energy can confirm unchanged retained charging power. |
| Indoor/garage sensors | Configured local MQTT topics | The publisher determines its measurement frequency; retained messages are marked explicitly. |
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
TeslaMate adds one scalar `ev2_energy` for the portable charger; its phase
distribution is unknown and is never inferred from a phase-count field.
Each value is an **estimated kWh increment over an explicit interval**, not an
instantaneous power reading or a cumulative phase meter.

Every usable acquisition contributes to integration, including polls between
database records. The acquisition accumulator retains only its preceding power
snapshot, source freshness, availability and audit-counter heads. The recorder
retains the three pending energy sums. Both checkpoints have bounded size;
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
   changes in phase power, quality and elapsed interval, while accumulating all
   intervening energy. Constant power therefore continues consuming energy even
   when no numerical change triggers a record.

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
Restart state does not authorize integration over a long outage: the default
maximum gap between usable polls is 60 seconds. Direct total-power measurements
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
intervals, independently of chart point reduction and the selected left axis.

The imported CSV formats do not contain the necessary H66 equipment readings.
They remain useful for their recorded temperatures, prices, requests and phase
currents, but do not establish historical heat-pump consumption. The previous
standalone controller-estimate curve is not required as a migration input.

Learning samples and cycle records still contain their resolved power estimates
and provenance for replay. They are documented as learning records in the
database overview; they are not a second adaptive power series. Removing the
standalone chart series does not change the house learner's input selection.

### TeslaMate portable-charger capture

Enable the connection in the add-on options (or standalone options), using the
same broker credentials already configured under `mqtt`:

```json
{
  "teslamate": {
    "enabled": true,
    "car_id": "1",
    "home_geofence": "Home",
    "namespace": "",
    "charger_assignment": "auto",
    "charger_identification": false,
    "max_age_seconds": 180
  }
}
```

Restart st-mq after changing permanent options. TeslaMate's own database remains
its responsibility: st-mq subscribes to MQTT only and never queries PostgreSQL.
The topic prefix is `teslamate/cars/<car_id>/`, or
`teslamate/<namespace>/cars/<car_id>/` when a namespace is configured.

Capture requires an exact `Home` geofence match, healthy live charging evidence
and usable total `charger_power` in kW. Missing or different geofences prevent
portable-charger recording. Coordinates are not copied or archived. TeslaMate
publishes separate fields when they change; MQTT receipt time is not an atomic
vehicle snapshot or a source measurement timestamp. Retained power alone cannot
start recording. Live health plus increasing `charge_energy_added` can confirm
steady power after startup; that first partial session is excluded from averages.

The previous accepted total power is integrated up to each message receipt and
maintenance tick. New power is never applied backwards. Only compact scalar kWh
intervals and bounded acquisition/session state are retained, with explicit
estimate, receipt-time and held-value quality. No raw power/current MQTT archive
is created. The power chart derives **Charger 2** kW from those intervals.
There is no separate total-interval-energy selector or phase-current series for
Charger 2. The existing Charger 1 timing comparison retains its original scope.
**Data & settings → Connections & settings → Electricity consumption · Easee,
Teslamate** includes these total power and energy series alongside the Charger 2
session check. The source overview uses the same combined electricity group,
while diagnostics identify Easee property/Charger 1 readings separately from
TeslaMate Charger 2 capture. Charger 2's session reference is battery energy
added, not an input electricity meter. Grouping these sources changes neither
capture, integration, recording nor model-learning semantics.
Power fills stack auxiliary heating, Charger 1 and Charger 2 in that order.
Charger 1 uses the total-property-power color, and Charger 2 uses violet in both
themes. Hiding a load removes it from the stack; unavailable lower readings leave
gaps rather than invented zero power. Each tooltip shows the load's own kW.

The installation currently has no solar or battery. Fresh, comparable property
import bounds Tesla power and the combined separately counted chargers, allowing
1 kW for rounded Tesla power. New source measurements need five seconds after a
Tesla power change to settle. Unchanged power is also comparable when the same
device has confirmed telemetry within 17 minutes and the latest successful poll
is within 60 seconds; this preserves the original power timestamp. Such held
power requires a successful poll at least 20 seconds after the Tesla power change
before comparison. A recent HTTP receipt alone cannot make old power usable.
An impossible overlap immediately suppresses new Tesla energy and
records an uncertain gap. A later increase in household power cannot on its own
revive the suppressed Tesla reading. Stale, disconnected and missing-stop periods
remain incomplete; restart does not integrate across downtime.

With `charger_identification` disabled, `auto` retains passive detection only:
it suppresses a matching Easee/Tesla overlap when their sum cannot fit the
fresh property reading, while allowing two cars when their sum does fit. Power
and location cannot identify the physical connector in every case: high household
load or missing comparable property/Easee measurements can leave attribution
ambiguous. Set `charger_assignment` to `easee` for a Tesla session known to use
Charger 1; it then creates no Charger 2 consumption. `bmw` identifies intended portable
charging but retains the physical-overlap safeguards. A future solar/battery
installation requires revisiting the import-power bound before using it.

Set `charger_identification` to `true` to allow active identification. This is an
explicit opt-in to **real Charger 1 control**, independent of the heat-pump
controller's monitoring, shadow or active mode. It requires the configured Easee
credentials and a live provider connection. No charging commands are sent when
this option is disabled.

When the Tesla is charging at Home and Charger 1 is also delivering power, an
unknown connection is checked after both readings become fresh and stable. The
check does not require an impossible property-power overlap: unrelated household
consumption can hide double counting. The preferred test substantially reduces
Charger 1's current for one minute, for example from 16 A to approximately 10 A.
If actual charging current is already too close to minimum for a useful reduction,
the test instead applies a temporary 0 A limit for one minute. It never raises
current to make a test possible. The pause fallback is selected from the initial
current and expected reduction. An unexpectedly weak measured response, missing
telemetry or conflicting control leaves the test inconclusive; it does not
automatically trigger a second pause. Another test on that connection requires an
explicit request.

Only a charger-level dynamic limit with a finite expiry is used. Existing lower
dynamic charger limits prevent the test, and unstable load balancing or stale
readings defer it. Static limits, circuit limits and load balancing are not
changed. Expiry clears the temporary charger restriction; it does not restore an
earlier dynamic restriction, which is why another controller's lower limit must
not be overwritten. Charging recovery remains subject to the available current
and the car. See [Easee's temporary-current command](https://developer.easee.com/reference/charger_set_dynamic_charger_current)
and [current-limit hierarchy](https://developer.easee.com/docs/current-limits-and-control).

An accepted command alone is insufficient. Charger 1 must actually reduce power,
and fresh Tesla current and power must follow both the drop and the recovery to
identify Charger 1. Conversely, continued Tesla charging and fresh energy
progression while Charger 1 responds support Charger 2. Missing messages, failed
recovery or inconsistent responses leave identification unknown. The Tesla
current used for this comparison comes from the documented
[`charger_actual_current` MQTT topic](https://docs.teslamate.org/docs/integrations/mqtt/).

Test stages, command bookkeeping, identification results and the bounded buffer
of unresolved ordinary energy intervals stay in memory. Once identified as
Charger 2, buffered intervals can enter the normal recorder; if identified as
Charger 1, they are discarded to prevent double counting. Unresolved coverage
remains a gap if it cannot be resolved within the buffer bound. Silence never
becomes evidence for Charger 2. Identification is remembered for the current
connection and cleared on disconnection, departure, a new Tesla charging session,
MQTT reconnection or restart. An MQTT interruption clears the verdict but retains
the in-memory attempt limit for the existing connection, avoiding repeated tests
when the broker is unstable.
An intentional test pause and its recovery remain within the existing session.

No probe records, confidence scores, command history, extra observations or raw
current archive are written to the database. Ordinary measured power, integrated
energy and finalized session references continue through their existing recording
paths, including the real dip caused by the test. No artificial values hide that
dip. A Tesla identified on Charger 1 does not create an additional Charger 2
session comparison; Charger 1's normal finalized session check covers that charge.

### Diagnostic meter and session checks

Equalizer accumulated import energy (`45`) is the only cumulative counter stored
in `energy_audits`. Charger lifetime energy (`124`) and running session counters
(`121`) are neither requested nor recorded. Obsolete experimental charger counter
rows are removed when the development database opens; completed-session records,
property counters and original CSV imports remain separate. Duplicate property
timestamp/value pairs are not copied. Source timestamps, resets, out-of-order
counters and availability are retained.

The existing **Meter accuracy checks** panel shows the latest property-meter
comparison, a **Charger 1** session summary, and a **Charger 2** session summary.
There is no session list. Each charger row reports compared, excluded and recorded
session counts; mean estimated/reference kWh per compared session; and the
energy-weighted difference `100 × (sum estimate − sum reference) / sum reference`.
Incomplete sessions and zero references are excluded, with no invented zero-percent
accuracy. Property cumulative readings remain available in history.

The left-axis **Meter checks** group contains the property counter and exactly
one **Charger 1** and one **Charger 2** entry. Each charger selection plots the
final reference kWh of its recorded sessions as separate points at the session
end, directly from the existing session records. No duplicate time-series rows
are saved. Hollow points identify references excluded from comparison averages;
tooltips distinguish metered electricity from energy added and show the session
period. No continuous power or lifetime-counter meaning is implied between points.

For Charger 1, Easee observation `129` supplies authoritative finalized session boundaries and
energy; `223` supplies the current session start when available. A new finalized
session flushes pending energy once and compares all three original Easee energy
series over the same period. Duplicate polls cannot create duplicate sessions or
force repeated flushes. Conflicting finalized readings do not rewrite a check.

Charger 2 retains one final `charge_energy_added` reference per observed charging
period, alongside integrated energy and coverage. Its charging-period boundaries
can differ from an Easee session that includes pauses. Missed starts/stops, counter
resets, location changes and ambiguous attribution exclude the comparison.
Terminal messages have a 45-second settling window. A comparable final reference
must arrive near the end or afterward; an older last-known counter is not treated
as a confirmed final reading.
Tesla's reference describes energy added to the battery, not a lifetime electricity
meter. Its difference includes charging losses and is labelled an **energy
difference**, not meter accuracy. Neither source's summary implies a measured
accuracy percentage for incomplete coverage.

Recording diagnostics compare a valid counter increment with the sum of committed
phase-energy estimates over the same source-time period. Missing coverage prevents
a valid comparison. If an edge cuts through a recorded interval, its energy is
prorated using that interval's average and the comparison is marked as using an
estimated boundary. Differences appear in kWh and percentage; zero metered energy
does not produce a division-by-zero percentage.

**Audit values never correct history, calibrate integration, tune the house model
or determine per-signal recording thresholds.** Cumulative comparisons are computed
when diagnostics are read; finalized session comparisons are frozen after matching
energy intervals have been committed. A cumulative counter update does not force
an extra energy record.

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
    "electricity_telemetry_max_age_seconds": 1020,
    "electricity_max_gap_seconds": 60
  }
}
```

Acquisition schedules and recording settings are independent. GB means decimal
gigabytes. The five-minute recording value is a maximum interval **when fresh
source data exists**, not a promise to invent readings from an unavailable source.
Periodic indoor MQTT temperatures are exempt: equal reports extend coverage,
while every value change is saved exactly.
The ten-GB value is a soft rolling annual growth target, not a quota that expires
in December. It never causes historical deletion or an end-of-year squeeze.

The recorder learns each continuous signal's scale from its observed variation
and uses a shared normalized error tolerance. That tolerance changes gradually
in response to measured SQLite growth, using smoothed daily and weekly estimates.
Signals are compared with their last saved value. There are no hand-assigned
accuracy targets or model-importance weights for those approximated signals.
Periodic indoor temperatures use exact change recording so coverage always
refers to the actual reported value.

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

Charts are constructed from original committed history at every date range.
The database does not store hourly scalar summaries or 15-minute chart-energy
copies. Electrical power is calculated from each original recorded energy
interval, and timing comparisons split that interval at the applicable price
and day boundaries. Partial selection edges and missing periods retain their
original meaning. Imported CSV history keeps its original timestamps, units,
quality and provenance.

Database indexes locate the required signals and periods. Phase-energy streams
are merged in chronological order, avoiding a large intermediate SQL sort.
Chart point reduction happens in memory: endpoints, extrema and gap markers
keep the response bounded without determining energy or costs. The worker's
bounded response cache also lives only in memory. Learning and meter-audit
calculations continue to use their own committed source inputs.

Schema 8 removes the obsolete chart-cache tables. Freed SQLite pages are
available for reuse; the database file is not automatically vacuumed. Actual
annual size and year-query latency must be measured on the deployment; no
Raspberry Pi 5 timing guarantee follows from desktop tests.

## Fullscreen chart exploration

The chart's **Fullscreen** button, immediately right of the left-axis selector,
opens a view with zoom, pan, reset and a selected-period navigator. The normal
chart is fixed to the entire selected period, with no zoom controls or navigator.
**Exit fullscreen** or Escape restores that fixed chart. Reopening fullscreen
resumes its previous zoom and position while the selected dates remain the same.
On desktop, the fullscreen heading is one compact row with zoom controls centered
and the axis selector and exit button on the right. Narrow phones use two compact
rows; landscape phones keep the controls in one row.
Landscape shows the entire selected time window at baseline zoom. Portrait uses
the full available chart height and shows a narrower time slice; drag sideways
or use the navigator to move through the selection even at baseline zoom.
Rotation preserves magnification and the visible center where the date boundaries
allow it. Axes and controls stay within the screen.

In fullscreen, pinch or the mouse wheel zooms around the gesture position, dragging
pans, and tapping inspects a value. With the fullscreen chart focused, +/− zoom,
arrow keys pan, and Home resets. Outside fullscreen, wheel, keyboard and touch
retain their normal page behavior and do not zoom or pan the chart. The applied
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
viewport, while returned points and visible bounds remain clipped.

Initial multi-year loading is unchanged. Fine detail can arrive later than the
gesture, and some reconstructed series still require an earlier journal prefix.
The current view stays available during loading or failure. No chart summary
tables, model snapshots or additional recorded history are introduced. Browser
checks use synthetic data in desktop, portrait and landscape viewports; they do
not establish a frame-rate guarantee for physical phones or slower servers.

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

The local Upstairs, Bedroom and Downstairs sensors are recorded separately from
H66 acquisition; H66 indoor is the Upstairs fallback when no dedicated topic is
configured. The house model uses the configured indoor average described below.
Garage temperature is also additional to those 30 and is history-only initially.
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

The current algorithm is `committed-house-v5-fireplace`. Configuration epochs retain power
and control-policy interpretation; changed equipment assumptions invalidate old
equipment/cost calibration. Checkpoint digests and journal-prefix identity detect
accidental corruption and trigger replay. They are integrity checks, not authentication.
Older algorithm entries remain archival rather than being silently relabeled.

Restart replays durable entries not yet applied to the checkpoint. The internal
`replayLearningJournal(store, input, checkpoint, {rebuild: true})` path can rebuild
from the journal; there is no separate public rebuild CLI. Reproduction requires
the supported recorded algorithm version. A future algorithm upgrade must keep
that version interpretable or explicitly migrate it, rather than pretending new
code reproduces an old model exactly. Later edits to forecast or coverage data do
not change already resolved journal inputs.

The fireplace source is a compact immutable load/removal log. Its selected revision
is also required for replay; resolved fireplace inputs are derived without copying
the log into each learning entry. Corrections rebuild in a worker and publish a
complete caught-up checkpoint. See [the mandatory reconstruction and versioning
contract](reconstruction-and-versioning.md) and [fireplace behavior](fireplace.md).
This does not expand the storage contract to full control-choice replay.

## Local MQTT temperature sensors and interface

Indoor and garage temperature acquisition uses exact topics on the existing local
MQTT broker in both `providers` and `mqtt` input modes. These subscriptions work
without an H66 device configured. The room mapping is:

| Local sensor | MQTT configuration field | Recorded signal | Display name |
| --- | --- | --- | --- |
| Smoke channel 1 | `indoor_temperature_topic` | `indoor_temperature` | Upstairs |
| Smoke channel 2 | `bedroom_temperature_topic` | `bedroom_temperature` | Bedroom |
| Smoke channel 3 | `downstairs_temperature_topic` | `downstairs_temperature` | Downstairs |
| Optional garage sensor | `garage_temperature_topic` | `garage_temperature` | Garage |

These fields belong under `mqtt` in private configuration or add-on options.
An empty topic disables that subscription. All indoor locations are recorded
separately; an individual sensor failure does not replace the other readings.
The existing indoor signal, imported CSV meaning and original temperature history
remain unchanged. H66 can supply indoor temperature when installed and
representative if no dedicated Upstairs topic is configured.
The three smoke channels use these exact topics. The optional garage topic below
is an invented example; replace it with the actual local topic or leave it empty:

```json
{
  "mqtt": {
    "indoor_temperature_topic": "stmq/smoke/1/temperature",
    "bedroom_temperature_topic": "stmq/smoke/2/temperature",
    "downstairs_temperature_topic": "stmq/smoke/3/temperature",
    "temperature_report_interval_minutes": 15,
    "temperature_report_grace_seconds": 120,
    "garage_temperature_topic": "example/sensors/garage"
  }
}
```

Standalone options also accept `mqtt.temperature_topics` mapping the signal names
`indoor_temperature`, `downstairs_temperature`, `bedroom_temperature` and
`garage_temperature` to topics. The payload can be a JSON
number in Celsius, or an object such as
`{"value":12.5,"unit":"C","timestamp":"2026-01-01T12:00:00Z"}`. Units `C`, `degC`,
`°C` and `F` are accepted; a supplied timestamp must include its time zone or be
epoch milliseconds. Without a timestamp, a non-retained publication uses labelled
MQTT receipt time. Retained data never gains a new measurement time on reconnect.
Retained data can be displayed with its original timestamp, but does not confirm
a new sensor report or establish usable periodic coverage. Without a source
timestamp, retained data cannot establish a new reading.
Give each sensor a distinct exact local topic; the per-room fields do not accept the wildcard
`stmq/smoke/+/temperature`.
Broker disconnection records explicit unavailable transitions for configured
temperature sensors and included H66 signals. Reconnection alone does not confirm
a fresh sensor measurement. Periodic indoor coverage ends immediately on a known
outage. Garage and nonperiodic indoor sources retain their last-known-reading
policy. Outdoor temperature and H66 control signals retain their own freshness
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

Indoor MQTT topics default to a genuine report every 15 minutes with 120 seconds
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
availability boundary and waits for a genuine report under the new policy;
earlier missing intervals stay missing. Garage and H66 indoor readings use the
last-known-value policy by default. Periodic
indoor outages instead make the configured average unavailable and suspend
thermal and comfort learning across the affected interval. No room is removed
from the weights or estimated from another room. Normal heating stays available.
Sensor changes still require a genuine reading from the new measurement period.
See [SmartThings forwarding](smartthings-temperature-rule.md) for the rule and
physical-driver requirements: configuring an interval alone does not establish
that unchanged genuine reports reach MQTT.

The right axis has one **Average indoor** series: the same configured average
used by the model, retaining its green colour alongside blue Outdoor readings.
The **Home temperatures** drawer section contains only **All home temperatures**,
which adds Upstairs, Bedroom and Downstairs to the left axis. Both axes use the
same numeric range in that view, including visible prices, so equal temperatures
align. Room colours are distinct: terracotta Upstairs, amber Downstairs and violet
Bedroom. Garage remains a shared right-axis series with its existing colour and legend control.
Average indoor reads the resolved value already included in each existing
15-minute learning journal record; it creates no additional temperature recorder
channel or chart-history table. V8 additionally requires indoor report coverage
through the window; other missing learning inputs do not hide a covered indoor
average. Missing indoor coverage and missing windows remain gaps. Earlier
algorithms retain their recorded chart interpretation. Changing
configured weights does not recalculate historical inputs. The journal
retains the original endpoints, weights and configuration needed for model replay.
Historical CSV `temp_in` remains an Upstairs reading and is never presented as a
three-room average. Saved learning-input tooltip rows use a short marker without
repeating their journal source and interval beside each value. New saved-average
tooltips additionally identify held rooms, actual observation times and whether
the window was excluded from learning.
Sensor replacements, moves and calibrations are recorded under **House model →
Explore learning → Model inputs → Average indoor → Sensor changes**. See
[sensor changes](temperature-sensors.md#replacing-moving-or-adjusting-a-sensor)
for their learning boundary and descriptive reason field.
The left drawer lists historical axes in temperature, heating, hot-water,
ground-loop, settings, equipment, runtime, electricity, weather and learning groups.
Recorded and calculated roles are separate from model roles.

**Recording details describes stored database contents.** The first fold,
**Adaptive measurements**, contains achieved intervals, learned thresholds,
freshness and growth. Its explanation distinguishes fast acquisition from
recording changes against the last saved value, and describes the shared rolling
storage objective. An average recording interval is not a fixed poll schedule.

The **Other recorded data** fold appears after **Meter accuracy checks**. It
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
accounting lists the 15 physical tables; there are no persisted chart summaries
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
download. Short views react to new committed data. The chart query runs in a separate worker with bounded memory
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

The property counter and finalized Charger 1 / Charger 2 session references are
selectable under Meter checks, separately from estimated interval energy.

## Synthetic year benchmark

Run `node scripts/benchmark-recorder.js --days 365 --max-seconds 180` for an
isolated synthetic benchmark. It creates and removes its own temporary database;
it does not open production history or configuration. `--profile` profiles query
work only and reports the hottest functions. It also measures the uncached
database overview and seeds nominal power assumptions to exercise heat-pump
reconstruction from the synthetic H66 records.

On the development Ryzen 5 1600 host with Node 22.19.0, six electrical series every
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

Sensor-change recording leaves acquisition and stored observations intact. Under
`committed-house-v9-reversible-sensors`, learning saves the original temperature
inputs needed to undo a reset's exclusions as a compact patch on affected samples.
Periodic report coverage remains bounded to the original window; undo cannot
fill genuine sensor outages. The journal, its seed/configuration and selected
sensor/fireplace corrections reproduce the model without rereading mutable
provider state. **Revert and relearn** runs in the background and preserves both
the original maintenance event and its reversal. See
[temperature sensors](temperature-sensors.md#replacing-moving-or-adjusting-a-sensor)
for the indoor and outdoor maintenance controls, confirmation and rebuild status.
