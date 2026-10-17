# Adaptive recording and reproducible house learning

Acquisition, recording and house learning have separate responsibilities. Devices
can be read frequently while history retains a compact approximation. Only
durably recorded values and their saved interpretation feed the learner. Recording a
garage temperature or a diagnostic does not make it a fitted model input.

This release remains in development. Incompatible development SQLite databases
are rejected before mutation and require a deliberate fresh start; they are not
migrated or reset automatically. The only supported historical input is
read-only import of version 0.7.5 `easee.csv` and `st-mq.csv` into the current
schema. Preserve the source files, timestamps, units, quality and import
provenance. An older runtime or database is not a supported upgrade input; see
[CSV import](csv-import.md).

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
| Energy Price Forecast EU, when enabled | Every 30 minutes on the master, independently of connected vehicles | Hourly predictions live only in a bounded expiring RAM cache for the forward chart and charging outlook; no historical price rows or learning input. |

The optional [Finnish electricity-price prediction feed](electricity-forecast.md)
has a separate lifetime from official market prices. Published prices always win
on overlap. Neither routine forecast polls nor their hourly values are recorded;
the session's explicit one-day approval and binding deadline are durable charging
intent, not electricity-price observations. A read-only replica does not fetch
or reconstruct transient predictions from copied history.

The shared provider HTTP transport keeps its original finite request deadline
through response-body consumption. Caller cancellation, provider shutdown and
that deadline also cancel an admitted body reader after headers arrive. A
cancelled read that resolves as end-of-stream is still a failed request, never
usable partial JSON or an acknowledged device write. Diagnostics retain the
existing aborted/timeout codes without provider URLs or response bodies.

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
Shelly EVSE retains `ev2_energy_l1` through `ev2_energy_l3` as estimated phase
allocations of its native accumulated-meter increments. Its measured increment
is allocated using the actual mapped phase powers at the two source endpoints.
All three sources use synchronized three-phase intervals; totals are calculated
by summing a complete valid phase group, with no fourth total-energy series.
Missing phase evidence leaves a gap. An otherwise valid unallocatable Charger 2
meter increment is retained as a diagnostic event, never an invented equal split.
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

Raw current, voltage and power snapshots remain acquisition-only. Current snapshots
can appear in live status, but are not new historical or training signals. The
separate smoothed per-phase voltage estimates below are derived historical signals;
they do not archive raw voltage polls or replace the measurements used for energy.
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

Charts derive interval-average kW as `kWh × 3,600,000 / durationMs`; voltage is not
part of this conversion. Equivalent chart currents divide each phase's estimated
power by its applicable recorded voltage estimate, assuming unity power factor.
They are estimates, not the original current readings. Original current snapshots
retain their amperes; their estimated power uses the same historical voltage
lookup. Missing voltage leaves only the derived conversion unavailable, without
discarding measured currents or energy. The energy path takes over at its recorded
boundary without double-counting current-only history. Missing intervals remain
missing in energy and timing comparisons.

### Smoothed phase voltage

`voltage_estimate_l1` through `voltage_estimate_l3` retain smoothed estimates of
typical phase-neutral voltage in volts. Each phase uses a time-aware exponentially
weighted average with a six-hour half-life, calculated from valid acquisitions
before adaptive recording. The first valid reading seeds each phase's usable
estimate immediately, including in a fresh database. Early estimates have less
observed history behind their smoothing; there is no minimum coverage threshold.
Successive accepted acquisitions must be no more than five minutes
apart. Their original voltage report must remain fresh, or an explicitly online
device's independently recent telemetry must confirm a held reading under the
same bounded telemetry window used for energy integration. Held values keep their
original voltage clock and an explicit confirmation basis. Faster polling never
creates more elapsed coverage; cached receipts, retained messages and restart
cannot renew source validity, and gaps do not count as observed time. The estimator
retains bounded feed state and one shared accumulator per phase, not another
growing raw-observation history.

Feed interruption and invalid-reading boundaries have their own clock. They never
rewrite the last accepted observation's source, receipt or delayed-admission
times. Recovery requires evidence acquired after the boundary, including after
restart, and the first recovered sample adds no coverage across the outage.

Prefer Charger 1 OCPP, then Charger 1 Easee Cloud, then Equalizer Easee Cloud,
independently for each phase. Charger 2 is excluded from shared estimates and
startup voltage because its phase order is not verified against these sources.
Inputs require verified phase-neutral mapping into installation phase order.
A missing phase cannot borrow
another phase's value. OCPP voltage acquisition does not depend on a complete
charger power/current snapshot. It grants no additional electrical/control readiness.
Retain a usable selected feed during brief interruptions; require stable recovery
for five minutes before returning to a preferred feed after elapsed smoothing
coverage has begun. At initial seeding, the source priority applies immediately.
Unverified terminal pairs and remote vehicle voltage cannot establish a household
phase estimate.

Feed changes preserve smoothing while recording their provenance. Each saved
estimate carries a compact contributing-source mask and latest-update source code:
1 is Charger 1 OCPP, 2 Charger 1 Easee Cloud and 4 Equalizer Easee Cloud.
Simulation uses isolated code 8. Contributors remain until the accumulator is
reset because exponential smoothing does not give old inputs
a finite expiry. The latest-update source identifies only that update, not the
exclusive origin of the accumulated value. Source/device context and timestamps
remain attached to the saved record; today's selected feed never relabels history.
Replacing contributing equipment or phase mapping resets affected accumulators
rather than interpreting former equipment as the replacement.

The recording table's voltage-estimate subtitle names only the latest contributing
source, such as **Easee · OCPP** or **Easee · Cloud**; missing provenance is
**Source unknown**. Its popup explains that earlier sources can still contribute
to the smoothed estimate and retains the full contributor list and voltage unit.
The subtitle uses recorded provenance, never today's connection.

The current persisted estimator format is `voltage-ewma-v3`. Unsupported estimator
state is rejected before engine initialization writes, with fresh-development-database
guidance; no migration, backfill or automatic reset is performed.

The adaptive recorder compares each estimate with its last saved value using
`max(0.5 V, learned adaptive threshold)`. Small changes accumulate internally until
the saved-value difference crosses that floor. Source and availability changes
remain semantic boundaries regardless of numeric difference. Constant valid
voltage needs no periodic historical row. The internal smoothing checkpoint keeps
full precision; consumers use the last published database estimate so discarded
subthreshold changes cannot revise the charging schedule. Source provenance adds
no raw measurement log or periodic historical writes.

A synthetic comparison of 12,000 otherwise identical saved estimate records
measured 21 additional JSON bytes per record for the two compact provenance fields.
Both test databases occupied the same number of SQLite pages after compaction;
page allocation depends on record packing and is not a zero-overhead guarantee.
A 24-hour steady-input run at one acquisition per minute saves three voltage
rows total: the initial valid estimate for each of three phases.

A saved value remains a historical estimate during an acquisition gap or
restart; it never establishes fresh electrical or control evidence. Startup may
use valid live local voltage provisionally until the first estimates are saved. With
neither usable estimates nor live voltage, voltage-dependent calculations remain
unavailable rather than inventing nominal voltage. Live power integration, local
current limiting and displays retain their actual measurement requirements. The
recorder shows accumulated valid coverage, whether acquisition is paused,
and original input timing separately from estimate publication. Early estimates
are usable and are not described as failed-quality readings or as waiting for
an hour of observations. The chart's
Phase voltage estimates view uses Voltage estimate L1–L3 labels and saved source
provenance.

Easee recorded evidence retains its cloud or OCPP transport separately from the
provider/device identity, including energy intervals and their pending tails.
Transport changes create recording boundaries. Labels show Easee · Cloud or
Easee · OCPP; missing provenance remains transport unknown. A session's final
meter-reference transport does not imply that every integrated energy interval
came through the same transport.

Historical conversions use the estimate available at their historical time. Only
supported CSV history predating the estimates may use the first usable
database value for each phase, explicitly marked as a retrospective voltage
assumption. Later voltage changes do not revise that fallback. CSV source bytes,
original currents, timestamps and import provenance remain unchanged. No estimate
is a measurement of the voltage that actually occurred throughout an old interval.

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
meter deltas. Its association includes the device, MQTT broker/root, integration profile/service and phase mapping. Duplicate or older source timestamps do not
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
The accumulated total supplies interval energy directly; the controller does not
integrate Shelly power to derive the total. Native session energy and session
duration are not polled or accumulated. The lifetime counter remains a current
recording input, without an additional raw history series.
The integration has
no native individual phase-energy counters. Its three phase increments preserve
the native measured increment in their sum; each individual phase remains an
estimate. Charging progress, cost, charts and household calculations read the
same complete phase group, including its durable pending tail.

A positive valid counter increment with unusable endpoint phase shares creates
an explicit three-phase gap and one `charging-energy-unallocated` diagnostic
event. The event preserves the source, physical association, source interval,
measured kWh increment and reason. It is not an energy series and supplies no
charging progress, cost or household energy credit. Zero increments need no phase
weights. Missing or conflicting phase members must
not become a partial total or be combined across physical sources.

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
without inserting duplicate observations. See
[retained storage costs](#retained-storage-costs) for the durability and
reconstruction data that compact observation counts do not remove.

TeslaMate and BMW remain read-only vehicle evidence for either physical charger.
Their feed health, timestamps, plug events and home scope control applicability
of identity and planning fields. Disabling economic charging never enables a
second electrical recorder. A Tesla away from home cannot provide local voltage,
power or C2 history. Equal-power independent physical chargers both count; a
physical charger plus its vehicle feed counts once.

**Electricity consumption · Easee, Shelly EVSE** separates C1/property acquisition
from physical C2 acquisition. Vehicle logger health is a separate diagnostic.
The native Shelly role/profile and the hardware checks still required are in
[Shelly EVSE capabilities](charging/integrations/shelly.md). Old Tesla-as-C2
configuration/state has no translation path; only the two supported v0.7.5 CSV
import formats retain backwards compatibility.

### Charger current allowances

`charger1_current_allowance` and `charger2_current_allowance` record the minimum
load-balancing current available to each charger. Both use one change-only
observation and compact coverage contract. The numeric value is nonnegative
amperes; explicit metadata distinguishes unrestricted, limited, fallback,
inactive and unknown. Fallback zero remains distinct from ordinary zero. No
negative-value encoding or separate fallback observation stream is used.

Charger 1 uses the minimum of all three reported Equalizer allowances, capped
by its known fixed equipment ceiling. Zero participates in that minimum. The
original Equalizer/cloud source evidence remains attached even when charger
control uses OCPP; a local OCPP status cannot refresh a cloud allowance.
Charger 2 uses the controller's load allowance after property headroom, shared
priority and configured maximum. Effective restrictions and confirmed native
settings remain separate from that load allowance. Neither value grants Start
permission or proves actual charging current.

An unresolved charger command blocks replacement commands, not the independent
load calculation. While that command awaits confirmation, healthy observations
continue updating Charger 2's allowance and coverage; native application remains
pending. Missing load evidence still selects explicit fallback or unknown, and
recovery never fills earlier unobserved periods.

A semantic change stores one exact observation with equipment identity, mode,
allowance, applicable maximum, reason and source evidence. Unchanged valid
observations extend compact coverage in place rather than append duplicate rows
on every poll. Repeated unchanged confirmations update bounded RAM coverage;
the next actual observation at least 60 seconds after the previous coverage
save for Charger 1, or five seconds for Charger 2, persists the endpoint and
accumulated confirmation count. Semantic transitions are saved immediately.
Database-backed charts and replicas can show an unknown recent tail until that
confirmed coverage is saved, even while the live allowance remains available.
Before a transition or an orderly stop with recording authority, confirmed
pending endpoints are flushed with their original source clocks. A crash,
save failure or authority loss may leave the last unchanged tail unsaved;
recovery treats that time as unknown instead of bridging it. Pure unchanged callbacks need no SQLite
write admission. Device observation and command-confirmation cadence are unchanged.
Original measurement clocks are not renewed by reading a cache.
Restart, ownership changes, equipment/source changes and missing observations
must not join unobserved time to a previous known state. Both numeric allowances
continue while cars are unplugged: Charger 1 retains its native reported
allowance; Charger 2 records presently available capacity while preserving active
peer commitments, without inventing a vehicle request or applying an instruction.
Its latest healthy inputs need no timestamp pairing. Asynchronous reports can
temporarily bias calculated headroom; source clocks retain their original meaning.
No previously unobserved periods are backfilled.

Queries are bounded by the requested period and a finite decision budget. Missing
coverage, invalid records and conflicting overlaps remain unknown. Omitted detail
in dense selections remains a gap with an explanation to zoom in; modes and
fallback boundaries are never averaged into a misleading continuous allowance.
The two allowance histories do not expire with unsaved charging-session reports.
They participate in ordinary current-format backup, recovery and inventory.

The **Charging currents** view plots both allowances as step lines, independently
of actual charger draw. Charger 2 fallback periods remain in its single line.
Its allowance bar distinguishes Full allowance, Priority constrained, Property
load constrained, Fallback, Unknown and Inactive from recorded decision evidence.
The top-level allowance reason records the capacity constraint; the nested
limiter reason retains any tighter native or vehicle setting. Ambiguous recorded
reasons remain Unknown in the bar without discarding a known numeric allowance.
Missing allowance evidence leaves a gap in the line.
The property line is the maximum of its three existing phase-current histories
at each timestamp. Native historical currents retain their reconstructed
interval-average meaning; supported imported current snapshots retain their own
basis. All three phases are required. This derived maximum adds no property
recording stream. A matching bar identifies the highest phase using the existing
L1/L2/L3 colours. It uses original phase groups before display reduction, retains
voltage-change boundaries, and shows the lowest phase number for ties with all
tied phases in its details. Missing evidence and omitted detail remain gaps.
Temperature context keeps its existing right axis.

Both charger cards show the same compact allowance beside their footer status.
Full allowance is green, a reduced positive allowance blue, ordinary zero red
and fallback purple, including fallback zero. Unknown/inactive is neutral.
Action messages use a separate reserved line; the allowance stays visible.
The old Shelly-only history strip is removed from all charts. See
[current allocation](charging/current-allocation.md#load-balancing-status-and-history).

### Diagnostic meter and session checks

Equalizer accumulated import energy (`45`) is the only cumulative counter stored
in `energy_audits`. Charger lifetime energy (`124`) and running session counters
(`121`) are neither requested nor recorded. Incompatible native development databases are rejected; completed-session
records, property counters and supported CSV imports have separate provenance. Duplicate property
timestamp/value pairs are not copied. Source timestamps, resets, out-of-order
counters and availability are retained.

The **Recorded energy checks** panel separates meter availability from comparison
results. Property always has a row: it reports no readings, waiting for a second
reading, a decreased or out-of-order counter, incomplete or conflicting energy
coverage, or a completed comparison. The latest cumulative reading retains its
full useful precision and source time; receipt time and coverage are in **Meter
readings and coverage**. A previously successful comparison remains visible with
its own dates when the latest reading cannot be compared. Reading counts and
comparisons belong to the latest reading's source and physical meter; another
meter's history cannot supply a baseline or a successful result.

Property and charger summaries run together in the existing read-only history
worker, against one committed selected-history snapshot. They share the bounded
foreground queue, cancellation and idle shutdown used by charts. A successful
latest property period reads its baseline and count without materializing older
counter rows. Finding an earlier success streams counter pairs and energy once
with bounded memory; there is no history-page cutoff. Long histories may still
take time to inspect, while control, recording and other HTTP requests continue.

Each check names its measurement method. **Property** compares the sum of its
stored, power-integrated phase energies with the Equalizer import-counter
increase over the same window. **Charger 1** compares its stored, power-integrated
phase energies with Easee's final session meter total. These assess power-based
energy estimates against meter references. **Charger 2** has no row in this
panel: it records native lifetime-meter increments directly, so it has no
power-integration estimate to check. Phase-power shares distribute those measured
increments among L1–L3; individual phase energy remains estimated.

Charger 1 reports the direction and percentage of the difference, recorded
and metered kWh, and how many completed sessions contributed. The aggregation
includes all recorded completed sessions;
its percentage is `100 × (sum estimate − sum reference) / sum reference`. Totals
and sample counts expose small amounts of evidence without misleading per-session
averages. An empty Charger 1 history shows one empty state. Incomplete sessions and zero
references are excluded; **excluded · details** explains the reasons and that
reason counts may overlap. Excluded sessions remain recorded. No session list or
new time-series storage is introduced.

**How comparisons work** contains the shared method, time zone and read-only
scope. Disclosure state and keyboard focus survive refreshes; a failed refresh
keeps the last displayed results with an explicit notice. Property cumulative
readings remain available in history.

Charger 1's finalized meter totals remain available through **All series** as
separate points at the session end, directly from its session records. There is
no dedicated session-check view and no Charger 2 session-check series.
The **Property meter counter** view keeps its cumulative meaning separate, using
individual readings without a connecting line.
The explorer's **All series** mode can isolate the Charger 1 session check or a supported cumulative
counter. No duplicate time-series rows are saved. Session readings use hollow
points; a stronger outline identifies references eligible for comparison
averages. Tooltips explain exclusions, identify the physical electricity meter
and show the session period. No continuous power or
lifetime-counter meaning is implied between session points.

**Recording-interval energy** exposes original phase increments for the property
and both chargers, Caravan intervals and qualified dedicated Garage intervals.
Each retains its original duration and source basis; these are not equal-length
period totals. Garage intervals preserve their counter-delta or integrated-power
basis and any provisional accuracy. Its native cumulative counter remains a
separate diagnostic series. Each charger total is the sum of its three phase
increments, not an additional stored contribution.

For Charger 1, Easee observation `129` supplies authoritative finalized session boundaries and
energy; `223` supplies the current session start when available. A new finalized
session flushes pending energy once and compares all three original Easee energy
series over the same period. Duplicate polls cannot create duplicate sessions or
force repeated flushes. Conflicting finalized readings do not rewrite a check.

Charger 2 has no native-session accumulator, comparison event, verification flag,
settlement timer or session-check history axis. Its meter delta recording and
physical connection/control lifecycle remain independent. Removed development
session-check events, state and configuration are rejected; no migration, silent
field stripping or automatic database reset is performed.

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
The ten-GB value is a soft rolling annual target for **estimated adaptive
measurement additions**, not a quota that expires in December or a limit on the
whole database. Exact records, learning history, imports and SQLite overhead
are additional. It never causes historical deletion or an end-of-year squeeze.

The recorder learns each continuous signal's scale from its observed variation
and uses a shared normalized change threshold. That tolerance changes gradually
in response only to the estimated serialized bytes of newly retained adaptive
observations, using smoothed daily and weekly estimates. This includes their
provenance and mandatory quality/gap boundaries; those boundaries are never
suppressed to meet a budget. Exact changes, imports, recovered observations,
learning journals, coverage/state maintenance and index growth cannot increase
this tolerance. Whole-database allocation growth is measured separately and has
no authority over adaptive precision.
Signals are compared with their last saved value. Charger energy has a 10 W
per-channel selection floor to avoid saving idle noise on every acquisition;
this selects interval boundaries, never rounds or discards accepted energy.
Smoothed phase-voltage estimates have a 0.5 V selection floor; internal smoothing
retains unrounded values. Other adaptive signals retain their learned thresholds
without model-importance weights. Native charger counters use a separate instantaneous-power selection
reference, because a counter can remain unchanged between quantized increments.
All room/protection temperatures use exact change recording so learning endpoints
remain actual reported values. A reporting deadline does not itself make other
continuous measurements exact: Caravan air/humidity and native pump diagnostics
remain adaptive. The displayed normalized pre-update change
compares incoming values with the previous saved value, weighted by elapsed time.
It describes variation in adaptive inputs, not reconstruction loss or a
continuous-time accuracy bound. Exact channels have no learned threshold or
normalized variation statistic.

Adaptive accounting starts prospectively when its independent checkpoint is
first written. Existing history is preserved, with no historical backfill or
reinterpretation of a former whole-database tolerance. Total-growth diagnostics
also start an independent current measurement baseline; the earlier combined
budget checkpoint is left unused. Unsupported current accounting state is
rejected before writable database setup, rather than translated or reset.
The byte counter commits
in the same transaction as its observations. It survives restart and does not
advance for rolled-back writes. It estimates logical serialized data, not SQLite
page allocation or physical flash writes. A 10 GB adaptive target therefore
does not imply 10 GB of total filesystem growth, even when other histories are
quiet. Annualized rates begin after an hour of measurement and are estimates
rather than guaranteed annual usage. The total SQLite growth estimate weights
each interval by its elapsed time during startup, so an allocation-heavy first
hour does not seed the following week. After warmup it uses exponential smoothing
with a seven-day time constant; its separate daily diagnostic has a one-day time
constant. This calculation does not change adaptive precision or its accounting.
It annualizes recent allocation growth; it does not predict the database size
next year, report expiry or when SQLite will reuse existing pages. A stable file
can therefore show no new growth while retained records consume reusable pages.

Optional hourly poll, error and availability statistics accumulate in a bounded
RAM buffer. A stream's next receipt after 30 seconds, the existing routine
recorder flush, or an orderly forced flush saves the pending totals in their
original hour buckets. This is not a strict 30-second crash-loss bound for a
quiet stream. Selected records, recorded-byte totals and saved timestamp extrema
commit immediately with their observation; adaptive precision, open energy
intervals, source coverage and learning inputs keep their existing durability.
Live recording statistics include pending totals without writing during a status
read. Replicas and restart see only committed statistics, so optional diagnostic
totals can lag or lose the unsaved tail after a crash. Pending buckets are capped
at 256, and expired statistics cannot be resurrected after a long suspension.

For a repeatable offline comparison, run
`node scripts/benchmarks/recorder-budget.js`. It exercises invented scalar and
three-phase energy streams at the default target and a smaller stress target,
reporting retained rows, logical bytes, total allocation growth and scalar
reconstruction error. It asserts conserved accepted energy and retained outage
boundaries. This short workload is not proof of annual convergence or physical
flash endurance.

Exact states, settings, alarms, runtime counters and availability transitions have
semantic recording rules. They are not blurred into fractional states to meet a
byte target. Equal treatment of continuous measurement error is an objective, not
a guarantee of identical error percentages for every signal at every instant.
Different source precision, availability and rates of change remain visible.

Repeated observations compact into coverage spans that distinguish fresh held
values from unavailable/stale sources. The held historical value is what a later
learner may read; discarded intermediate poll values cannot enter through those
spans. Successful downloads of older timestamps do not renew source freshness.
History recovery may retain a longer fresh span beside its exact shared source
prefix. Readers select one continuous interpretation of those equivalent spans,
using their genuine source/availability endpoints without adding report counts or
duration twice. Independent local recording can continue the original lower-ID
span; historical insertion order never substitutes for source-interval order or
truncates a newer post-gap report. Unavailable and contrary transitions still
terminate coverage at their own source boundary.
SQLite transactions group energy phases, pending sums and acquisition checkpoints
so retries cannot count an interval twice.

When another connection holds the SQLite writer lock, live recording waits in a
bounded memory queue without blocking the event loop. Observations retain their
original receipt and source times. A callback starts only after acquiring the
writer lock; a partially executed operation is never replayed. The dashboard
shows **Waiting for storage**, and reports a failed save if the queue fills.
Pending observations are not durable until committed: a process interruption,
cancelled connection or exhausted queue can leave a recording gap. Queued or
replayed receipts do not establish new freshness or control authority.

A rejected MQTT observation save fences commands until a later current delivery
from the affected configured input or device is successfully committed. Retained,
duplicate, ignored or unrelated messages cannot clear that failure. Multiple
failed inputs recover independently; older queued receipts and completions from a
previous connection cannot clear newer failures. Read-only native status requests
remain available to obtain current evidence. Clearing the storage failure neither
renews old sensor clocks nor bypasses source validity, freshness or control authority.

Physical commands wait for committed intent and recheck current authority,
equipment and expiry after storage admission. An already committed circulation
OFF obligation keeps its deadline while later bookkeeping waits. Native heat-pump
restoration still requires current admitted device evidence; an unavailable
database or device can leave that restoration visibly pending. Storage waiting
does not provide a hard real-time guarantee or permit overwriting a later native
instruction.

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
  outputs and actual tariff relay feedback. Floor series 1–4 describe reported
  GPIO output logic, not relay-contact continuity, valve position, water flow or
  successful heat reduction. They remain unknown without fresh device feedback. See
  [Home floor preheating](floor-preheat.md).
- Hot-water circulation feedback: initial state and exact state, quality or
  availability changes. Unchanged ON/OFF reports extend compact coverage;
  native Shelly reports retain the configured freshness deadline (120 seconds
  by default). Missing or stale feedback is unknown. Raw watts remain live-only;
  requested pulses are separate. A read-only snapshot can show the saved compact
  operation and its original report time, but cannot show live power or confirm
  current pump availability.
- Garage compressor activity and reported defrost: exact state changes. Native
  interpreted temperature and compressor frequency belong in Adaptive measurements. Garage power
  remains live input only. Qualified dedicated garage energy intervals and saved
  original control events retain their own independent history.
- External temperature feed: no numeric history and no routine renewal events.
  Diagnostic events record abnormal onset, changed reason and recovery once.
  Durable local targets and one-shot command results remain distinct.
- Charging session reports: bounded current summaries and observer checkpoints,
  plus append-only diagnostic events with source clocks and planning snapshots.
  All recorded report events survive while their session is retained. Completed
  unsaved reports expire together with their details after the configured number
  of days (30 by default); active and explicitly saved reports are protected.
  Explicit deletion of a completed report affects only its owned diagnostic
  records, not independent energy or learning history. History pages and display
  grouping bound work without discarding stored events. See [charging reports](charging/evidence-and-reporting.md#session-reports).
- Calculated outputs, requests, market/weather snapshots, manual inputs, learning
  journals, session checks, imported rows and provenance, source corrections,
  recovery records, bounded statistics and overwritten operational state each
  have their own saving rules and retention description.
- Current state includes phase-voltage estimator checkpoints, Caravan probe
  power-restoration obligations and device-bound Automatic power choices, and
  paired MQTT source context. Their update dates and current-entry counts are
  separate from retained observation history. Home Automatic/Pause changes and
  scheduled Pause expiry have their own event history; they are permission
  changes, not physical heating measurements.

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
separately from finalized observation counts. The annual target applies only to
estimated adaptive measurement additions. Overall SQLite growth is measured
separately; mandatory exact/history records are never dropped to meet the target.

The current database schema is defined in [`src/storage/schema.js`](../src/storage/schema.js).
An incompatible development
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

An explicit `availability-gap` with null energy describes unavailable source
measurements, not a contradictory measured total. Retain that original evidence
while using complete valid phase cohorts within its bounds. The shared reader
emits unknown spans only for the uncovered remainder, without dividing measured
intervals or changing their energy. This applies to both same-identity and
different-identity history, including pending energy and recovered observations.
Unmarked null data, invalid measurements, incomplete cohorts and genuinely
overlapping measured intervals retain their conservative quality/conflict rules.
Charts, charging accounting and electrical context use this same interpretation.
Previously committed journal payloads remain frozen; electrical context does not
become heat-pump metering or alter the learned-model update function.

## Chart curves and popup meanings

With **Interpolation ON** (the default), every plotted temperature in °C uses
Chart.js' monotone cubic Hermite interpolation on either axis. This includes
measured air and liquid temperatures,
saved temperature inputs, learned temperatures, forecasts, temperature-valued
settings and references, targets and temperature differences. This uses linear
time and storage in the number of displayed points, keeps local extrema and
avoids overshooting neighboring values. Constant or two-point runs naturally
stay flat or straight. Unknown or unavailable intervals break the curve.
Smoothing temperature-valued settings and room boosts is a display choice;
their recorded changes, actual commands, control interpretation and learning
remain unchanged. Prices, energy, power, categorical states and model
coefficients retain their own display semantics.

The compact **Interpolation ON/OFF** button beside **Reset view** and **Save view**
switches every connected line to steps when off, including otherwise linear
series. Turning it back on restores each series' existing interpolation rules.
The browser saves this global display preference across views and reloads;
**Reset view** resets series visibility while retaining interpolation and price
choices. It does not change recording, learning or control. Original interval
edges and explicit gaps survive in step mode. Interpolated viewport boundaries
carry the preceding source value separately so the browser can display a held
step at the edge without retaining the interpolated value or fetching again.
Null boundaries remain null even when that preceding value is known.

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
Click or tap the popup itself to hide it. Selecting another data point moves
the popup to that point.

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
**All series** offers the supported historical projections: recorded
measurements and states, interval energy, counters, saved learning inputs,
replayed coefficients and supported calculations. It includes individual
diagnostics beyond the named views and retains entries with no records in the
current installation or date range. It is a catalogue of defined chart meanings,
not access to every numeric database field or current-state JSON value.

Home retains learning inputs, coefficients and outcome views. Garage shows
original temperatures, compressor/native equipment evidence, measured electrical
history and manual target/protection state. It produces no learned coefficients,
normal-warmth estimates, cooling prediction errors or savings episode assessments.

Search filters labels, units and canonical signal identifiers. Switching modes
or searching leaves the current chart unchanged; choosing a result applies it
and closes the explorer. Reopening starts in the active chart's mode, with each
mode's search retained separately. **Close**, Escape or clicking outside dismisses
the window and returns focus to the selection button; arrow keys with Enter
select a result while searching. Opening or switching modes focuses the mode
button instead of the search field, keeping the touch keyboard closed until
search is selected. The window stays centered on phones and in fullscreen.
Toggling a legend item or refreshing the current view preserves the legend's
scroll position; selecting a different view starts its legend at the top.
An individual-series chart plots the selected series, plus the globally
controlled electricity prices. Categorical series use
an activity row; selecting a sparse series does not manufacture missing history.

The chart icon button beside the selection button opens a view with both date
pickers, gesture navigation and a selected-period navigator. The normal chart is
fixed to the entire selected period, with no zoom controls or navigator.
Landscape chart mode keeps dates at the upper left and selection/Exit at the
upper right on one row when space allows; narrow portrait layouts still wrap.
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
list and **Interpolation**, **Reset view** and **Save view** controls that stay
visible on one footer row. In fullscreen, opening the
fold hides the activity strips; closing it restores them. Short windows also
hide the navigator while the legend is open. Escape inside the legend closes it
and returns focus to the title. Group headings describe their available series:
price-only groups say **Price**, with no temperature label. All activity icons
use the same stripe style and a representative active-state colour. Left-axis
history uses solid lines and right-axis temperatures use dashed lines. Future
forecasts use dash-dot lines and electricity prices remain dotted. All plotted temperatures, including settings
and targets, share monotone cubic interpolation within covered spans while
**Interpolation** is on. Switching it off draws all connected lines as steps. Categorical
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
alignment with the plot at both time-axis endpoints. The **Shelly load balancing**
row accompanies Electrical power, Phase loading and individual Charger 2 power.
Its exact change history uses a hatched Unknown state for missing coverage and
supports Left/Right, Home and End inspection when the strip has keyboard focus.
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

Fine detail can arrive later than the gesture, and some reconstructed series
still require an earlier journal prefix. The current view stays available during
loading or failure. Date and view controls remain available: selecting different
dates cancels the obsolete request and its worker calculation, and late results
cannot replace the new selection. Loading reports the current stage. A percentage
beside reading history or energy describes traversal of that stage's date range,
not elapsed time, estimated time remaining, or completion of the whole chart.
Preparation, transfer and drawing can follow a completed reading stage.

Recent energy requests seek the selected interval ends instead of repeatedly
scanning all earlier retained energy. Long intervals overlapping the selection
remain included. One request reuses energy boundaries, voltage interpretation and
a bounded set of reconstructed energy groups across related chart passes; dense
requests fall back to streaming. These are temporary read caches, not retained
chart summaries, model snapshots or additional recording. Original observations,
gaps, extrema, provenance and exact accounting remain unchanged.

After a short selection of at most seven calendar days finishes drawing, the
browser may prepare one fixed companion view: Electrical power → Phase loading
→ Charging currents → Electrical power, or either Garage view → the other Garage
view. This uses no learned preferences and does not multiply views by adjacent
dates. A selected in-flight companion is reused; obsolete speculation is canceled.
Hidden pages stop speculation, and unused views are not polled repeatedly.
The browser keeps a bounded response cache with the existing freshness and
source/correction invalidation rules.

Requested and speculative queries have separate lazy read-only workers, at most
two per chart service. Speculation starts only when requested work is idle and
cannot occupy its queue. Workers retire after an idle minute. Result encoding
runs on the server worker; browser request parsing and geometry preparation also
run in workers. Unchanged content uses a semantic revision instead of serializing
all chart points again. Theme and ordinary legend changes reuse prepared geometry;
stack visibility and interpolation changes rebuild the affected geometry.
No extra zoom reduction discards loaded vertices. Canvas drawing remains on the
browser thread; measured responsiveness is not a guarantee of zero frame delays
on every history or device.

`/api/chart` supports the same current chart data as JSON or, with
`Accept: application/x-ndjson`, progress envelopes followed by one result envelope.
Authentication and source selection apply to both representations. Speculative
requests use `X-Chart-Prefetch: 1` and are limited to seven calendar days. A chart
read has a separate fifteen-minute upper deadline and can be canceled immediately;
ordinary monitoring reads retain their short timeout.

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
separate [garage manual control and local protection](garage.md).
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

The current algorithm is `committed-house-v17-time-evidence-admission`. Saved configuration retains
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

The model's indoor temperature uses a fixed weighted average of configured rooms.
With all three configured, Bedroom contributes 50%, Upstairs 25% and Downstairs
25%. Automatic membership gives Bedroom twice the relative weight of either other
configured room. Membership is fixed by
configuration, including sensors temporarily missing or stale. It does not change when one
sensor stops reporting. The garage is excluded. Optional
`controller.indoor_sensor_weights` assigns nonnegative weights by indoor signal
name. Its default empty object `{}` selects this automatic configured membership and weighting;
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
thermal and comfort learning across the affected interval. No room is removed from the weights. A separate bounded one-room control estimate
can follow the remaining two rooms from a complete baseline. It is never recorded
as measured temperature or used for reference/model learning or observed validation;
see [one missing room](temperature-sensors.md#one-missing-room). Normal heating stays available.
Sensor changes still require a genuine reading from the new measurement period.
See [SmartThings forwarding](smartthings-temperature-rule.md) for the rule and
physical-driver requirements: configuring an interval alone does not establish
that unchanged genuine reports reach MQTT.

Views offer **Average indoor** as the same configured average used by the model,
retaining its green colour alongside blue Outdoor readings. **Property
temperatures** compares Upstairs, Bedroom, Downstairs and both Garage probes on
one right temperature axis. **Home temperatures & comfort** focuses on home
rooms, the saved average and reference. Each view keeps its own deliberate
temperature choices. Room colours remain distinct; Garage rear uses dark orange
and front a noticeably lighter orange. Caravan air uses the same distinct cyan
throughout its views; Caravan electricity uses the property-power colour.
Temperatures use the same interpolation rules throughout these
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
Sensor replacements, moves and calibrations are recorded under **Home → Home heat model → Model inputs → Average indoor → Sensor changes**. See
[sensor changes](temperature-sensors.md#replacing-moving-or-adjusting-a-sensor)
for their learning boundary and descriptive reason field.
The explorer's **All series** mode groups historical signals into temperature,
heating, hot-water, ground-loop, settings, equipment, runtime, electricity, weather
and learning groups.
Recorded and calculated roles are separate from model roles.

**Recording details describes stored database contents.** Its upper **Recording & storage**
rows show **Recording**, **Storage health**, **Storage & growth** and **Backups**. Each opens its own evidence
and explanation; status labels, attention states and the live or recorded-snapshot
scope remain visible without expanding those details. Opening one status does not
open the others. Refreshes preserve expanded sections and keyboard focus.

**Storage & growth** owns the size and growth figures for the section. It separates
current whole-database allocation, database-file and WAL sizes, retained adaptive
payload and prospective adaptive additions. Separate adaptive and total
**Annualized recent growth** figures show their measurement windows; the total
shows **Still settling** during its first week and then names its seven-day
smoothing. It explicitly excludes forecasting report expiry or next year's
database size. The adaptive target remains
next to adaptive growth, never beside total growth as if it were a total cap.
The prospective adaptive byte counter names its start date. Opening **Storage & growth** or **Other recorded data** requests the shared
cached, read-only inventory in a worker;
its dated estimate covers retained adaptive observations, including recovered
observations and currently excluded recovery evidence. Exact measurements and
CSV import rows belong to **Other recorded data**, outside that estimate. It excludes shared
indexes, page slack and other tables, so it cannot be subtracted from physical
database bytes to calculate an exact fixed-data size. No full-history scan runs on
each status refresh. Inventory refresh failures retain the last successful figures
with their original date and an explicit failure message.

The **Adaptive measurements** fold contains achieved intervals, learned thresholds,
freshness and per-measurement recording counts and payload estimates. Its existing
table keeps source explanations and individual source histories folded within
each row. It does not repeat the section's database totals or annual projections.
Its explanation distinguishes fast acquisition from recording changes against the
last saved value, and describes the shared rolling storage objective. An average
recording interval is not a fixed poll schedule.

Known installation measurements retain one flat row per source, signal, unit
and recording policy, with individual source identities under **Source history**.
Different custom devices remain separate. Counts and approximate storage include
the listed histories in the same reporting windows; current spacing, threshold
and open interval describe the source observed by this recording runtime.
Historical-only rows do not present old thresholds as current activity. Read-only
snapshot views explicitly label their latest recorded source; they do not claim
that this computer is acquiring measurements. Source details retain saved receipt
periods and the separate accepted source timestamp. Grouping changes presentation,
not physical identity, provenance, control permission or energy accounting.

### Recording and backup health

**Recording & storage** groups four expandable summaries: **Recording**, **Storage
health**, **Storage & growth** and **Backups**. Each shows a concise state and its
evidence; explanations stay inside the corresponding fold. Storage health
describes the current writer and observed delays or failures, while disk space
describes filesystem capacity. Database allocation and growth figures have their
single home in the upper **Storage & growth** fold, alongside available disk space.
**Recorded data** contains Adaptive measurements, Other recorded data and Recorded
energy checks; it does not repeat a storage fold. The subtitle names this server
and distinguishes live recording, simulation, a read-only replica and a history
viewer. Local disk and saved-copy information describe this server, even when
its recorded history came from another computer.

The dashboard shows a compact **Recording and storage** summary below its context
line for 15 seconds after the first successful health response. It then disappears
when health is settled; ordinary polling does not make it reappear. Recording
details remains available in the history panel. The summary stays visible while
recording is starting, evidence is unknown, a health refresh fails or the last
health check is more than three minutes old. It also appears for low disk space,
failed database writes, a stalled update loop, unavailable recording sources or a
failed backup. A failed or stopped storage writer remains visible even when its
last save is confirmed and its queue is empty. Ordinary asynchronous saving is
neutral activity and does not introduce a recording warning. Recovery hides the
summary again once the startup introduction has elapsed.
Keyboard focus inside the summary defers hiding until focus leaves it.

The check timestamp comes from the server, while the dashboard uses the browser's
clock. A server timestamp up to three minutes ahead is tolerated within the same
freshness window, preserving the original timestamp. A larger lead keeps the
summary visible with a clock-mismatch explanation and **Last known** labels,
rather than claiming an old check alongside “just now”. Checks more than three
minutes behind the browser remain stale; failed refreshes remain visible.

Recording and local free space have separate labels and links to their evidence.
Each problem has its own explanation and link, with critical failures first;
source loss does not label the database as faulty. Failed or stale health checks
mark retained readings as **Last known** rather than current. A recorded snapshot
or history viewer is explicitly labelled and is not expected to record locally.
The disk meter uses space available to the application's account, excluding
filesystem-reserved blocks. It describes this computer's database filesystem,
including on a replica; it does not imply that another export filesystem has the
same free space. The disk is checked at most once per minute. Low-space attention
starts below the larger of 1 GiB and 5% of capacity, with that percentage allowance
capped at 5 GiB. Critical attention starts below the larger of 256 MiB and 1% of
capacity, with that percentage allowance capped at 1 GiB. These indicators neither
delete history nor change recording precision or control authority.

Write failures remain in memory when the database cannot store an error. Runtime
transaction, state and event writes report sanitized failure categories; successful
no-op updates do not prove that writes resumed. A recovered failure remains visible
for 24 hours within the same application run because a recording gap may remain.
The update loop is considered stalled after three minutes without a completed tick.
Unchanged readings, held/event-only values and durable open energy intervals are
not evidence of a stalled recorder. Before any usable source evidence has arrived,
the first three minutes of a recording run show **Starting recording**, including
when unavailable diagnostic rows have already been recorded. After usable evidence
has arrived, a subsequent source loss warns immediately. This initial wait never
hides write failures or a stalled loop. **Monitoring active** means some observed
recording evidence is usable. Partial loss of an observed source still raises
attention and links to its explanation, even when other sources remain healthy.
Stream labels preserve their measurement and unit, with links to the applicable
recording details, without exposing private source identifiers. **Last source check** dates a source polling attempt, including
an unavailable result, and does not claim a saved measurement or successful write.
The expanded Recording fold separates **Activity** from **Observed sources**.
Activity dates the last completed loop update and source polling attempt. Source
counts distinguish observed streams, usable evidence and streams needing attention;
unknown statuses are identified separately within the attention count. These are
not additive categories: held evidence can remain usable while needing attention.
Each unavailable, stale, failed, unknown or held-attention stream has its own name,
unit, status, reason, source-observation time, polling-attempt time and details link.
Counts describe observed streams, not all configured sources: a never-seen source
can be absent. Source checks retain their own timestamps; unchanged readings and
open energy intervals need no new observation rows. Storage health separately dates
the last successful storage write, which can save settings or events as well as
measurements. This summary is an early warning, not an integrity check or proof
that every measurement was physically correct or every expected source recorded.

Live source warnings and existing measurement rows read current committed source
evidence between controller updates. Recovery or loss therefore appears without
waiting for the next minute's loop; refreshing source evidence runs no control or
recording work and does not renew observation clocks. Recording counts and storage estimates
retain their last completed statistics snapshot. A newly observed stream enters
health immediately and gets a detailed row at its first statistics snapshot.
Caravan state warnings distinguish an unconfirmed power check from missing
appliance evidence; Off requires fresh power, while On also requires a fresh fan
report.
Fresh admitted reports on a newly attached unqualified Caravan capture publish
the current recording gap without refreshing an earlier measurement. A failed
power check therefore remains a qualification warning even while MQTT reports
are available; earlier state and source time remain preserved.

The **Backups** fold lists managed local copies, their filenames, sizes and dates,
with the configured folder and the list's own check time. One shared bounded catalog
also supplies History recovery. Manual exports and complete reset bundles use
`recording.backup_directory`; pinned protected rejoin exports live in that root's
`pair-exports` repository. Only pinned protected exports count as retained copies; routine
rolling pairing snapshots and inactive working databases are not portable backups.
On Home Assistant, **Folder** uses Configuration's verified host mapping under
`/addon_configs/<app slug>` and **Inside app** shows the actual application path.
An unknown mapping or a configured path outside the known `/config` mount is
explicitly unavailable; the UI never invents a host folder. Standalone Linux
shows its actual configured folder.
The catalog is cached for five minutes. **Refresh list** explicitly requests new
metadata discovery. Limits, unavailable locations or changed files produce an
incomplete-list notice; failed refreshes retain the previous list with its date.
SQLite exporter metadata is read in a bounded worker, without scanning full history.
Export dates, original reset-start dates, protected snapshot dates and filesystem
modification times have different labels. An interrupted reset retains its original
date when resumed; this date is not the later verification or snapshot clock.

Listing does not recheck a file's integrity. **Verified during creation** describes
exporter or reset-publication evidence, not the bytes today; the exact creation-check
time is not recorded. **Verify** checks the
selected copy with the shared full verifier, retaining a dated result for that file
identity during the current application run; replacement or modification
invalidates the displayed result. The latest check takes precedence over
creation evidence. Failed checks and changed files raise attention even with
the list folded. Restart does not claim that a previously checked copy was
rechecked. A check
never imports history or grants control authority. **Download** transfers the
selected file; **Review history** opens the existing source review before recovery.
The folder and file inventory, verification and downloads require admin access.
Verification and downloads of existing copies remain available on a read-only
server. Recovery and saving a new local copy retain their active-master checks.

Manual export progress and failures are separate from the inventory. Completion
receipts persist when the writable database permits; an in-memory receipt remains
available if persistence fails. Browser download activity never replaces the latest
saved-copy date, count or save failure. Saving and downloading retain independent
outcomes, so success in one cannot clear failure in the other. Current receipt
format 2 is validated at this diagnostic boundary; earlier or malformed receipts
remain preserved and unknown, without conversion or overwrite. They require a
deliberate fresh development database to establish supported persisted diagnostics;
they do not prevent independent inspection of current backup files.
A completed download proves transfer to the browser,
not durable saving or continued availability on its device. Files elsewhere,
arbitrary CLI output names and Home Assistant-managed backups are not silently
claimed by the catalog. Existing files are never moved into the new backup root.
Use explicit file selection for supported copies outside it. There is no scheduled
backup, automatic retry, age-based overdue rule or automatic deletion.

Ordinary history recovery does **not** create a retained full backup of the master
first. Recovery preserves imported evidence and reversal provenance. Pairing uses
rolling snapshots and protects divergent history; neither is an independent dated
backup. Reset archives and explicit manual exports retain portable copies under
their owning workflows. Keep an independent copy on separate storage to protect
against failure of the database disk.

`GET /api/recording-health` is an authenticated read-only endpoint independent of
the normal controller status. The dashboard can still display storage health when
controller status fails. Filesystem checks time out from the request's perspective
without claiming zero free bytes or blocking ordinary control. A stopped process,
unreachable dashboard or complete host failure cannot report its own condition.
The current version-3 response includes `recording.writer.state`: `ready`, `saving`,
`confirming`, `unavailable`, `stopped` or `unknown`. This is current Store and queue
evidence, independent of saved outcomes and historical windows. A failed worker
with unsettled work reports `confirming`; after settlement it remains
`unavailable`, including when the journal proves the save committed. Missing or
invalid availability evidence remains `unknown`. Snapshot and history scopes
have `recording.writer: null` and do not claim active-master availability.
`recording.runtimeTiming` exposes only the existing bounded in-memory
`observed-event-loop-delay` diagnostics: sample count, maximum and p99 observed
delay, the diagnostic threshold and `hardRealtime: false`. Unavailable or invalid
timing evidence is null. No new timer, recorded series or diagnostic write is
created by health polling.

The **Other recorded data** fold appears immediately after **Adaptive measurements**,
followed by **Recorded energy checks**. **Export database** lives inside **Backups**, alongside the copy list.
**History recovery** and **Verify database** remain under **History tools**, with
their explanations and actions inside their own folds. The data inventory describes the remaining
datasets using field lists, counts, available dates and the way each dataset is
updated; database size figures stay in **Storage & growth**. Groups cover:

- Forecast temperature and radiation versions, shared content and fetch references.
- Spot prices and dated contract components.
- Recorded controller phases, circulation requests and learning chart metrics.
- Learning samples, episodes, replay configuration and assessments.
- Current settings and checkpoints, explicitly distinguished from retained history.
- Easee/st-mq CSV imports, manual counters and historical annotations.
- Recovery contributions, immutable revert/restore decisions and the current history selection.
- Availability coverage, recorder statistics and storage support.

Populated datasets appear first. Empty datasets and entirely empty groups remain
available under labelled folds with counts, without dominating the initial view.
An empty dataset is identified as empty rather than inferred to contain
measurements. The overview does not expose configuration values, private device
identifiers, import paths or arbitrary event payloads. Storage support records
explain database growth without presenting them as additional physical sensors
or model inputs. Purely reconstructed chart values are not listed as independent
stored series; persisted calculated learning results are described as such.
The overview explains that chart point reduction and response caching use RAM,
while the retained SQLite indexes support queries over original records. Storage
accounting enumerates each current physical table once and separately describes
all SQL views; the views add no stored rows. There are no persisted chart summaries
or chart-summary bookkeeping entries. The initial current history-selection entry
is metadata, not a measurement.

Source dataset counts include retained evidence excluded by recovery corrections.
**Recovered history and corrections** separately reports retained source records,
records included in the published selection and excluded original evidence.
Historical and unpublished exclusion references remain storage records without
being mistaken for exclusions in the current charts. Learning journal counts refer
to the selected complete model epoch; other retained epochs have their own count.
No recovery names, private source paths, fingerprints or record payloads are exposed
by this inventory.

Database inventory queries are read-only. Opening the outer Recording details
fold alone performs no full inventory query. The shared cached inventory refreshes while **Storage & growth** or **Other recorded data**
is open. Both folds share one request and cache. A bounded worker query keeps large inventories out of the live
control loop. **Refresh inventory** bypasses the worker cache; ordinary reads retain
its five-minute cache. Missing or unreadable database-file sizes remain unknown;
an absent WAL is zero. A fresh inventory owns the allocation figures consistently
in both the summary and its details. Database replacement, scope change and logout
clear previous inventory and energy-check results and fence late responses.
Expand/collapse state and keyboard focus survive updates. Meter-accuracy details
show the property cumulative-meter check and the Charger 1 session summary
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
energy interval. Chart queries use bounded worker queues and temporary caches;
history reconstruction and response serialization run outside the control event
loop. A separate speculative lane keeps companion fetching out of the requested
chart's queue.
The **Energy cost comparisons** fold starts closed beneath the chart, alongside
**Recording details**. Its **Comparison period** has independent start/end
calendars with the same single-day and explicit end-selection behavior as the
chart. The initial period is today. **Last 7 days** includes today; **Last month**
and **Last year** select complete calendar periods; **This year** runs from
January 1 through today. All dates use Finnish time and stay fixed across
midnight until the reader chooses again. A comparison-date change does not move
the chart, and chart navigation does not change comparisons. While loading or
after a failed request, the status identifies the dates of any retained results;
failed requests offer Retry. The section uses its own cancellable request cache
and the current chart API's unreduced comparison calculations, with ordinary
short/live and long/historical refresh intervals.
When recovery publishes a new history selection, comparisons invalidate cached
and pending results for every period, including historical dates. The selected
period and controls remain in place; late replies from the previous selection
cannot replace the refreshed results.
**Heating**, **Charging** and **Fireplace** summary boxes
align in three columns when space allows and stack on narrow screens.
Heating starts on **Home** and **Model estimate**, restoring a saved **Timing cost**
choice. It offers Home / Garage / Total; Charging offers Charger 1 / Charger 2 /
Total for timing comparisons. Their details folds expand independently for
cost operands, included energy, sources, timestamps and coverage. Shared
explanations appear in **How these comparisons work**. The folds support keyboard and
touch and keep their state across chart refreshes and date changes.

The Heating model view sums supported frozen cycle assessments on their Finnish
completion date, including recovery and excluding domestic hot water. Its evidence
is assessed-cycle counts, not elapsed-time coverage. Home's execution electricity
uses a temperature-dependent heat-pump source estimate; Home timing instead uses
recorded operation and dated nominal powers, including hot-water operation. Neither
is a dedicated meter reading. Garage provides recorded electrical timing only;
there is no Garage model-savings assessment. These period totals differ from the Learning view's rolling €/cycle
mean and from charger session costs.

Timing coverage means included time divided by selected elapsed time; future
hours do not enter that denominator. Heating Total combines Home and Garage
system-time, and Charging Total combines charger-time. Charging includes only recorded periods
above 100 W with complete daily prices; idle periods at or below 100 W contribute
neither energy nor time to its comparison. Missing readings remain unknown, rather
than idle. Heating continues to include valid zero-consumption time. Source and
rate-assumption percentages describe shares of included timing time.
Every timing scope requires complete prices for the full Finnish day's average,
even when only part of the day's energy is included. These rules affect the
comparison only; original energy records, chart series and CSV import interpretation
remain unchanged.

Fireplace is a separate estimated difference in space-heating electricity under a
paired normal-heating reference, with free wood, a scenario range and explicit
coverage. It is not included in a combined total with the other comparisons.
Remaining forecast cost and electricity differences are separate from past estimates;
negative prices can make avoided electricity increase cost. Unlike frozen cycle
assessments, this retrospective estimate can change after corrections to logged
wood or the reconstructible model. All fireplace chart and savings data are
derived on demand without new telemetry or daily savings rows;
see [fireplace logging](fireplace.md#visibility-and-estimated-savings).

The **Property meter counter** view and Charger 1's **All series** session check
preserve these distinct quantities independently of recorded interval energy.

## Synthetic year benchmark

Run `node scripts/benchmarks/recorder.js --days 365 --max-seconds 180` for an
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
long-view refresh keep them outside the control loop. Whole-database growth,
including those additional tables, is displayed separately; the configured
adaptive target responds only to prospective adaptive observation estimates.

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
remain live-only. The single `caravan_dehumidifier_state` series records the
reported combined state: Off (0), Low (1), Medium (2) or High (3). Off requires
fresh reported power off; each fan level requires both fresh power on and the
corresponding native fan report. Unknown, unsupported fan or offline data stays
a gap. These categories do not prove water removal. Commands, separate fan
settings, humidity targets and the appliance's own temperature/humidity are not
recorded as measurements.

State history retains the appliance identity, required power/fan receipt clocks
and qualification provenance (test method/version, source clocks, measured
deltas and meter signature), without duplicating native sensor readings or
settings. A native On/Off location test must show a corresponding Caravan meter
power rise and fall before any state is recorded, even with Automatic power
disabled. The minimum response is 3 W in each direction, allowing a small fan
load when dehumidifying is unnecessary; meter noise can raise that threshold.
Qualification uses advancing reports, never cached republications; a failed or
inconclusive test leaves a gap and a
new appliance or meter connection repeats the test. Both must remain fresh after
a pass, and restart requires a new test after outstanding restoration. Native
power is restored to its prior setting before normal temperature control resumes,
with a durable restoration obligation.
Enabled automatic cold protection defers or aborts the test until warmer
temperature evidence arrives. An independent native power change supersedes
the test's captured setting; restoration respects that newer choice.
Humidity is not a qualification requirement. Coverage stops at the earliest
required evidence expiry; testing and unresolved restoration remain gaps.
A bounded required-report timestamp wait also remains a gap. For an already
recorded state in the same qualified connection, admission resumes coverage
prospectively with a separate availability event and the original native clocks;
it does not require an additional unchanged appliance report. Electrical power
or meter expiry and actual feed loss still invalidate qualification and require
the normal fresh check. Fan-history expiry requires fresh fan evidence without
repeating a still-valid electrical check.
This gate does not suppress the independent BLU or Caravan energy series.
Both Caravan views and the series explorer show the same four categorical labels;
retired dehumidifier series have no alias or
conversion into this contract.

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


## Chart projections and retained evidence

The explorer separates everyday electricity, room, caravan and garage pump views
from Home saved learning inputs, replayed coefficients and equipment
diagnostics. Each choice states its unit and basis. A plot is not a promise of
another database channel: power, phase-current estimates, indoor average,
front–rear difference, coefficients, fireplace response and compressor activity rows
are projections of existing observations, energy intervals or journal inputs.

The retained data has distinct responsibilities:

| Data | Why retained |
| --- | --- |
| Phase/total energy intervals | Original integration result; acquired current, voltage and power polls are not separately archived. |
| Smoothed per-phase voltage and bounded estimator state | Stable published forecast inputs and time-local historical conversion estimates; source/quality remain distinct from live voltage observations. |
| Adaptive source measurements and compact coverage | Values, original measurement times and proven report continuity; freshness cannot be reconstructed from value changes alone. |
| Learning journal, compact manual corrections and seeds | Frozen normalized inputs, source/configuration meaning and deterministic replay; a later query must not substitute today's input interpretation. |
| Dated power assumptions and controller auxiliary estimates | Historical equipment interpretation and the estimate actually available to control; not separately measured heat-pump electricity. |
| Learning outcome assessments and cycle events | Original assessment known at that time, kept distinct from corrected replay. |
| Meter/session checks | Independent reference evidence for accuracy; not duplicate energy contributions. |
| Charger allowances and compact coverage | Exact nonnegative allowances with explicit mode, source evidence and restrictions; separate from actual draw and charging-report retention. |
| Native garage pump interpreted indoor temperature/frequency | Adaptive observed diagnostics with explicit validity bounds; separate from room/protection sensor measurements. |
| Native garage compressor activity and defrost | Exact observed state changes; no inferred fault or defrost interpretation from arbitrary diagnostic bytes. |
| External feed diagnostics | Abnormal onset, changed reason and recovery events; no numeric feed series or healthy renewal log. |

**Garage temperatures & compressor** offers native compressor activity, heat-pump
defrost reports and door contacts as separate activity rows, with defrost above
the doors. **Garage protection & electricity** combines saved/effective targets,
pipe estimates, protection states and recorded electricity intervals. Frost
override appears there, separately from the heat pump's defrost cycle. There is
no separate Garage electricity view; its energy series remains available in the
combined view and series explorer. Garage series retain the same colours in all
views, including distinct front/rear pipe-estimate colours. Native states follow
their recorded availability deadlines; unknown periods remain unknown, never
inferred off.
The pump's interpreted indoor reading is available beside the front/rear probes
and independently in the explorer's **All series** mode. It may incorporate its external feed
and is not relabeled as a physical room sensor. Hot-water circulation requests
and recorded electrical or switch feedback have separate rows; neither proves
water flow. Floor override series describe GPIO output readback, not physical
contact continuity, valve position or heating delivery. External feed failures and recoveries remain
diagnostics outside adaptive measurements. These views add no heat estimates
or learning inputs.
Chart projections do not replace retained evidence or backfill history from
current live readings.

## Recover history from a backup or paired computer

Open the **History recovery** fold within **Recording details**, then choose
**Review history** to review and recover missing history. Its description and
launcher stay inside that fold. Standalone controllers and active paired masters
use this same window.
**Paired computers → Review history** opens it with the other computer selected.
The **Review source** view holds source selection, the source check and its
action. **Previous recoveries** holds earlier operations and their revert/restore
reviews. The window follows the Fireplace dialog's open/close behavior; closing
it does not cancel work already running on the server. Admin access is required, and
read-only computers cannot apply history changes.

Choose a verified reset-archive backup, a local copy from the configured export
folder, an uploaded self-contained SQLite backup, or the paired computer. Reset
backups and ordinary exports have the same `.sqlite` format. Only the current
schema and learning contract are supported; recovery does not migrate older
development databases. Keep the original backup. Uploaded copies are temporary
working sources and do not replace an independent backup.

For a backup, confirm **This backup contains this household’s history**, then select
**Check backup**. A source sharing this database's transaction lineage is checked
at its exact hash-linked checkpoint. The check inventories changed source rows
since the shared checkpoint, including the referenced evidence needed by those
rows; it does not recount unchanged history. A paired divergent source can be
reviewed directly from its consolidated configured-peer transfer, using a private
overlay of changed rows without copying either database. The shared peer anchor
survives short transaction retention; offline duration never forces a full copy.
An unrelated backup, or an independent backup whose shared checkpoint is older
than the retained transaction window, requires an exceptional full inventory: format, integrity, input
scope, source counts, category date ranges and potential coverage are assessed
from its self-contained file. The confirmation asserts household identity;
it is not an assertion about software versions and cannot bypass automatic format
validation. Matching format alone cannot establish household identity.
For an incremental check, **Changes since the shared checkpoint** shows category counts and
first/last dates for those changed records and their required references. This
restores useful source identification without scanning unchanged history. The
checked time and scope remain visible. **Changed source record counts** includes
known zero categories when other checked history is present; these are never
database totals. When no supported history changed, a concise message explains
that unchanged shared history is not counted, instead of listing all-zero totals.
A populated source can therefore report no changed history, and the result does
not establish whether the slave has received newer master records. These dates
do not establish continuous coverage or missing entries.

For a protected paired source, a validated empty incremental check at the exact
shared/source checkpoint hides **Recover history** and offers **Resume mirroring**
to verify and bring the other computer up to date with the master. The result says
**No additional history to recover from this checked source**. All actual changed
records, supported-table counts and available source categories must be zero;
unsupported records, skipped learning inputs or an incomplete result cannot be
presented as nothing to recover. A previous mirroring verification failure remains
separate and visible until mirroring succeeds. Nonempty checks retain their category
counts, recorded date ranges, checked time, details and limitations.

Availability reports have a separate collapsed
diagnostics fold: a point event has one timestamp and unknown duration, while a
report period ends at the last saved evidence, not a confirmed recovery time.
Neither is labeled a computer outage. Diagnostics group only records with the
same source, exact evidence bounds, status and reason; expanding a group shows
the affected measurements. Retained-message reasons remain visible. The latest
100 energy intervals, 100 diagnostic periods and 100 point groups have independent
limits, so reconnect notifications cannot crowd energy gaps out of the report.
Category totals and omitted counts refer to evidence records, not inferred incidents.
Sparse observations never establish gaps,
and relevant source records do not prove continuous coverage, physical identity
or import acceptance. The check uses pinned read-only snapshots and does not run
a trial import or change recorded history. For a nonempty source, missing entries,
conflicts and model changes remain unknown until you confirm **Recover history**.
Recovery compares and imports
history once, then rebuilds the model only when accepted history affects learning.
Its result reports imported, conflicting, already present and skipped entries
and the recovered period. Existing local history takes
precedence over conflicting source records. Recovery imports supported source
evidence with provenance; it does not restore the backup's configuration,
dashboard permissions, pairing role or equipment-control state. A normal paired
slave is available for source checking only; protected paired history also requires
the separate [resume-mirroring decision](pairing.md#protected-history-and-manual-recovery).
The paired source shows the current paired operation and its saved outcome;
an earlier backup recovery cannot stand in for that status. A normal slave
source check does not offer gap recovery or imply that it is needed.

When protected changes exist, the alternative **Resume without recovery** retains
the explicit warning that unrecovered source history will not be merged. A proven
empty source uses **Resume mirroring** without suggesting that history is skipped;
its successful outcome records that no recovery was needed. Both decisions retain
the existing donor identity, freshness, authority and verification checks.

Switch to **Previous recoveries** for later review of a recovery. Select
**Review revert**, inspect its effect, then confirm **Revert recovery** to exclude
its accepted evidence from current history. The model is rebuilt only when the
changed selection affects learning. **Review
restore → Restore recovery** includes that evidence again where current evidence
permits; later local evidence wins new conflicts. These actions apply
to a whole recovery, have no time limit, and preserve later independent records
and corrections. Original evidence and immutable decisions remain stored; a
revert does not reclaim their disk space. The previous selected history and model
remain available until the replacement is ready for atomic publication. See the
[recovery source-correction contract](reconstruction-and-versioning.md#recovery-source-corrections).

Each previous recovery shows its source, operation time, accepted record count
and original recorded dates. The revert/restore review distinguishes that original
period from the dates and categories affected by the proposed selection. It
separates contributions from dependent records, identifies restore records that
remain excluded, and reports whether learning needs rebuilding. A date range
spans the first and last affected records; it does not mean every record between
them changes. Original evidence remains retained.

**Verification** belongs to the source check/recovery or the selected revision
review. **Standard checks** use the normal checkpoint and source validation;
**Also verify full snapshot** adds an independent full database read and may take
longer. It does not turn a source check into a trial import or establish how far
mirroring has caught up. **Reload results** only fetches saved checks, progress,
available sources and the recovery list. The window updates automatically without
changing button labels or availability during background reads. **Reload results**
remains available for an immediate retry, with progress shown only for that explicit
request. Use **Check backup**, **Check other computer** or a revision review to run
new work. The received time describes the last results response, not a new source
check or confirmation that mirroring has caught up.

Interrupted recovery can retain valid accepted entries. Reopen the window to
review its saved outcome, revert its contribution or check the source again to
finish. If a request's response was lost, **Recheck the same request** resolves
that request before another history change. Model reconstruction runs in the
background while control remains available; a failed or stale rebuild does not
publish a partial replacement model.

Progress reports identify the current phase, measured work when available and
elapsed time. A fraction applies only to that phase; unknown totals remain
indeterminate. Progress is transient and does not write a database receipt for
every update; job transitions and completed outcomes remain durable. The summary
rediscovers an accepted job after a reload, and previous-recovery totals are read
in a bounded background worker. Large accepted recovery jobs have no fixed
one-hour cutoff; shutdown and authority loss still cancel them. Revert/restore
reviews pin a read-only source transaction and write only private temporary
selection rows. Reverse source-reference indexes restrict dependency checks to
affected evidence. A history-only correction keeps the existing model epoch and
checkpoint. A learned correction reuses the last matching durable model checkpoint
before the affected input. Compact epoch ranges retain the unchanged journal
prefix with its original row identities, and the same reconstruction function
replays only the affected suffix. Recent saved checkpoints are reconstructed
from the retained reversible transaction changes; they are validated against
their selected input prefix and source revisions. Independent sparse checkpoint
caches preserve supported committed model boundaries every 256 learning entries
or six hours of learning-input time, and at a new source revision or epoch.
These are replaceable caches alongside the complete learning inputs, never a
replacement for them and never per-minute snapshots. Recovery publication also
preserves its verified unaffected prefix under the newly selected source
revisions. A later revert or restore can reuse that prefix after transaction
compaction. A sensor reversal begins at the original sensor change; a fireplace
removal begins at the original load, rather than the correction's later report
time. Reuse of a checkpoint with different source revisions additionally proves
that every changed interpretation begins at or after the affected boundary,
including the saved history selection and original sensor-change identities.
Only a correction reaching before an available matching checkpoint needs
replay from the retained seed. The permanent learning inputs, seed, source
revisions and recovery decisions remain available, so transaction expiry does
not impose a time limit on recovery revert or model reconstruction. This work
stays separate from scanning unrelated observations or copying the database.

**Verify with full snapshot** adds the independent full verifier to a manual
operation. Manual verification and scheduled background checks use the same
verifier and admission queue as pairing and recovery operation checks. At most
one full verifier runs in an application process; waiting checks hold no pinned
database reader, and cancelling one removes its pending request or joins its
active worker before source files are released. Separate application or CLI
processes have separate queues. Recording details show the active operation,
phase and pending count without disclosing database paths. It compares data only
at matching transaction checkpoints: continuing
recording cannot turn different source times into a false mismatch. Verification
results do not grant device authority or replace an independent dated backup.

## Single-file database export

Open **Recording details → Backups → Export database** and choose:

- **Save local copy** saves on the server, in `recording.backup_directory`.
  Its default empty setting selects `<database directory>/backups`, including
  `/config/st-mq/backups` on Home Assistant. An explicitly configured absolute or
  home-relative directory selects another root. The folder also contains reset
  bundles and the paired export repository; changing it requires restart. Existing
  copies stay intact in their original locations. The saved path is shown after success.
- **Download database** saves to the browser's computer. Supporting browsers
  prompt for a destination and stream directly to the selected file. Other
  browsers buffer the response and use their usual download settings.

**Download sent** confirms that the server finished sending the snapshot. Check
the browser's download or selected file to confirm that it was saved; the server
cannot verify the browser's final file or its durability.

Both actions use the same filename format, for example
`stmq-2026-09-25T15-04-32-123Z.sqlite`: date, time, milliseconds and `Z` for UTC.
The browser file picker suggests the download's start time; the download fallback
uses the server's snapshot filename. An existing server export is never overwritten;
simultaneous timestamp collisions get a distinguishing suffix.

The SQLite online backup API copies the current committed database, including WAL
pages, into one private file. Recording continues; the file represents a consistent
snapshot and does not promise to include later writes. Only the copy switches to
DELETE journal mode, so it can be opened without WAL/SHM companion files. Downloads,
server copies, CLI backups and reset-archive recovery backups use this same snapshot
generator and current `.sqlite` format. File-backed copying and current-schema,
saved-state and integrity validation run in a worker before publication. A damaged
WAL header, including its checksum, is rejected before SQLite opens the source;
the original database and its companions remain intact. A pinned
reader fixes the copied boundary while later WAL writes continue. After copying
and finalizing, the private standalone copy passes the same independent full
verification used by manual checks: saved-data contracts, retained journal and
current row fingerprints, recovery source references, SQLite integrity, foreign
keys and identifier high-water marks. Its transaction checkpoint must match the copied source boundary. These
checks share the application's bounded verification queue; waiting or scanning
the private copy holds no live-source reader. Publication waits for successful
verification. Cancellation joins the worker before removing staging. Full checking
adds work proportional to retained data to each explicit backup or restore; routine
startup and healthy handover keep their bounded checks. Diagnostic
exporter metadata describes the software that made the copy; it neither replaces
format validation nor proves household identity. There is no checkpoint or overwrite of the running
database. Server copies use mode `0600`;
new export directories use mode `0700`. Backup, offline restore and final server
export share the sequence: flush the completed file, publish without replacing an
existing destination or SQLite companion, then flush the final parent directory.
A publication whose directory flush failed is never acknowledged as successful.
The complete published file remains available for diagnosis and a later verified
copy, including when saving from the dashboard; its power-loss durability is
unconfirmed. Ordinary cancelled exports still clean their private staging files.
Authorization revoked during an otherwise successful web publication still
removes that unacknowledged export. No caller overwrites the live database.

Recovery-reference checking requires every authoritative learning root and cycle
to have exactly the reverse references derived from its retained payload. Unknown
owners, missing owners and unjustified extra references fail verification without
repairing the source. Current learning projections may have no index references
when inserted, or populated references after sensor-reversal remapping; any
references present must match that projection's payload. The root's complete
references remain required in either case. Checksums and this semantic check
detect covered damage; they cannot prove that lost WAL frames or missing files
never contained later committed data. Keep independent dated backups.

The offline `test/extended/backup-storage-scale.test.js` fixture measures copying,
verification, concurrent committed writes, local history reads, event-loop gaps
and process memory with growing synthetic databases. For example:

```sh
STMQ_BACKUP_SCALE_MIB=16,64,256 node --test test/extended/backup-storage-scale.test.js
STMQ_BACKUP_SCALE_MIB=16,64 STMQ_BACKUP_WRITE_INTERVAL_MS=50 STMQ_BACKUP_BASELINE_MS=3000 node --test test/extended/backup-storage-scale.test.js
STMQ_BACKUP_SCALE_MIB=64 STMQ_BACKUP_WRITE_INTERVAL_MS=50 STMQ_BACKUP_SETTLE_MS=10000 STMQ_BACKUP_BASELINE_MS=30000 node --test test/extended/backup-storage-scale.test.js
```

Its timings qualify only the machine and filesystem tested; process termination
and injected filesystem errors do not simulate a physical power cut or establish
Raspberry Pi flash durability.
Use `TMPDIR` on the target storage. The default 5 ms offered write interval is a
stress workload; repeat with measured installation-relevant rates. Separate
recording-only, copying and verification results include actual committed writes
per second, BEGIN/body/COMMIT costs, heartbeat delays and allocated WAL bytes.
An optional settling period after fixture creation and a longer recording-only
baseline help distinguish copy pressure from storage latency already present.
WAL allocation is not the number of outstanding frames, and a passing consistency
check does not by itself establish acceptable control latency.

`/api/status` exposes `recordingHealth.recording.storageTimings` for the open
Store: transaction attempt/commit counts and the last, maximum and p99 BEGIN,
body, COMMIT and total elapsed durations over the last 128 attempts. Dedicated
runtime writer BEGIN and COMMIT durations include message dispatch and awaiting
completion; body includes bounded synchronous dependent statement calls. Journal
sealing and native COMMIT are measured on the worker that owns SQLite. The
current `journalSealMs` and `nativeCommitMs` fields separate journal sealing from
the raw SQLite COMMIT call, with measured sample counts for each stage. The
existing `commitMs` still measures the complete COMMIT wrapper, including both
stages and its dispatch overhead. An unreached stage, or bootstrap before journal
instrumentation is installed, is null rather than an inferred zero. Failed
attempts retain only reached stages; nested savepoints are part of their outer
attempt, never separate native commits. These
in-memory diagnostics reset when the Store opens and never write extra history.
Sealing includes synchronous validation, serialization, hashing, peer-index and
journal SQL work. SQLite COMMIT time includes native synchronization and filesystem
wait. The dedicated writer disables automatic checkpoints and schedules PASSIVE
checkpoints as separate background turns, outside this COMMIT duration. Direct
connections can still perform automatic checkpoint work within COMMIT; Storage
health reports the owning connection's policy. Neither stage isolates CPU or fsync.
The latest transaction date does not date an earlier rolling maximum. Queue depth and `waitingSince`
remain separate asynchronous-admission evidence. Slow successful writes do not
prove corruption, and these timings do not grant device authority.

`storageTimings.slowAttempts` retains the last 16 main Store attempts whose
measured total duration reached one second, with a cumulative count for this
Store run. It is memory-only diagnostic evidence, not another warning threshold
or a persisted transaction format. Each entry preserves its original `startedAt`
and `finishedAt` wall dates, committed outcome and the measured stages above;
wall-clock changes do not alter monotonic durations. These dates never renew
source observations. Fast attempts can age out of the 128-attempt summary without
erasing the separately bounded slow entries.

The optional `journal` summary contains only the already-prepared journal date,
attempted sequence, coalesced row-change count, existing serialized byte count
and trusted table names. It adds no SQL query and contains no row keys, values,
device identities, hashes or error text. A successful seal with no net journal
effects reports zero changes and bytes, with null date/sequence; this does not
prove that SQLite wrote no pages. Uninstrumented or unsuccessful sealing is
unknown. A failed native COMMIT can retain prepared effects, but `committed:false`
does not claim that their sequence became durable. A successful committed outcome
does not prove command receipt or physical actuation. The ring is available in
the existing authenticated health response; the dashboard's historical summaries
retain their existing scope. Restart and read-only reopen start a new local ring,
and independent worker connections are not attributed to this Store.

### Storage health

The authenticated transient health and writer-history contracts are version 3;
the nested process-local operations contract is version 2. Current producers,
dashboard consumers and fixtures use these contracts directly; older transient
shapes are unknown. There is no decoder or persisted migration for earlier shapes. Persisted backup receipts and database,
journal and learning formats are independent and unchanged.


The **Storage health** summary belongs to **Recording & storage**. Its current state
and dated **Earlier problems** occupy separate summary fields. The historical
indicator always covers the past day, independently of the selected diagnostic
period, and also appears on the outer Recording details summary. It is a history
indicator, not a current fault. Authoritative writer and feature owners still
report unresolved faults. A later success does not erase an earlier failure. **Caught up** requires usable
current writer and queue evidence with no monitored work outstanding. Background
storage identifies its active owner instead of being labelled as a save; queued
saves remain waiting until that turn finishes. Ordinary **Writing** activity is
neutral, while an actual writer-lock wait has its own state. **Confirming last save** reports unresolved durability after worker loss without
claiming a failed save. **Writer unavailable** takes precedence even if the last
save committed successfully and the queue drained. **Writer stopped** reports
closed admission. Missing or malformed evidence cannot establish readiness.

Opening the fold separates **Current activity** (writer availability, backlog,
lock wait, last confirmed write and active local tasks) from **Monitored history**.
One past-day/past-week selector applies to writer and local-task history. The
period overview separates save queue delay, whole transaction duration and, when
the runtime schedules them separately, WAL checkpoint calls. The latest
three dated problems are shown directly; additional retained problems have a
shared disclosure. Each keeps type, date, context, outcome and any established
recovery separate. Full writer counters, including observed zeroes, belong under
**Save outcomes**. A confirmed save retains its original success clock
when the worker becomes unavailable; checking health neither renews that receipt
nor resumes recording or command authority.
It uses the existing authenticated health responses and updates with
ordinary dashboard refreshes. Its summaries are held solely in memory for at
most seven days; opening a new Store, including application restart, starts a
new monitoring period. Nothing is saved to SQLite, a file, browser storage,
backups or replicas. An earlier period is unavailable, not a period with zero
failures. Snapshot and history viewers cannot report the active master's
memory-only history.
These writer summaries describe the main Store, including its dedicated runtime
writer. Separate export, reconstruction and publication workers have their own
operation results and are not silently included in these timings.

The past-day and past-week views distinguish the duration monitored in this run
from the duration included in the summaries. The oldest partly overlapping
five-minute bucket is omitted, so the summarized span can be up to five minutes
shorter than the selected period. Bounded summaries supply averages,
approximate 95th percentiles and worst
durations. Queue wait measures how long successfully completed queued work
waited until their callback starts, including successful writer admission.
Transaction duration begins at its BEGIN attempt and includes transaction building,
journal sealing, durable commit, confirmation and follow-up overhead. Queue delay
and transaction duration therefore overlap during admission and must not be added.
Separate checkpoint calls do not belong to either transaction or commit duration.
Commit time is included in the transaction. Neither measures the complete delay of a physical device
action or isolates an fsync. Live pending count, oldest queued work, contention
episodes and time, and peak backlog describe pressure separately from successful
write timings. Durations use a monotonic clock; wall times only date evidence.

Recognized storage failures and queue-full rejections remain distinct from
successful lock retries, intentional cancellation and stale-work rejection. A
failure after a confirmed commit is a follow-up failure, not proof that the save
was lost. These counters describe this Store's observed operations; they do not
count every household reading, establish who held a competing writer lock, or
prove missed equipment actions. Independent workers' transaction durations are
outside this Store's timings, although their contention can delay its queue.
The device-command count covers instrumented mutation attempts for heat-pump,
switch, door/cover, Garage, floor, Caravan, and both charging adapters through
MQTT, OCPP and Easee cloud writes. A passive attempt follows required intent
persistence, admission, rollback and actual transport dispatch. It counts once
only when a required save fails, dispatch is demonstrably refused by pending
recording, or the existing command deadline expires during an explicit storage
wait before transmission. A validated mutation discarded by its parent's
storage-caused rollback retains a safe cause; the dependent publication is not
counted as another SQLite save. Calling MQTT publish alone does not prove that
bytes reached its stream.

Queries, source-clock admission waits, unrelated cancellation, changed authority
or identity, native restrictions and unconfirmed readback do not establish a
known-unsent command. Once dispatched, a timeout cannot establish that a command
was not sent. The count describes concrete attempted mutations, never inferred
missed schedules or physical actions. Command-family coverage begins at owner
registration; disabled or absent instrumentation cannot establish zero failures
for an earlier period.

A separate counter records supported authenticated dashboard control requests
refused by storage. Such a request can fail before any native command exists;
it does not establish valid actuator intent or permission. Requests, commands,
save attempts and queue refusals describe different boundaries and can overlap.
Do not sum them. Request-shape rejection, unauthorized access and non-storage
failures are not storage-blocked requests. An expired command remains counted
when later control succeeds.

Recent problems retain at most the latest incident of each of five kinds: failed
save, queue refusal, command not sent, control request blocked by storage and
follow-up failure after a successful commit. Context and reasons use fixed safe categories, without private device
identifiers, topics, payloads or raw error messages. A failed transaction may
contain several readings, so failed saves cannot be relabelled as lost readings.
Where an input is discarded, its incident can say that the update was not
retained for retry. Where an existing retained-update retry proves the original
update was saved, the incident can show that recovery. A later successful save
means saving resumed; a newer reading cannot prove recovery of missing history.
Historical failure counts remain after recovery and are separate from current
writer status.

**Local tasks** is separate process-local evidence, available on this computer
even while it displays a snapshot or runs as standby. Current activity lists
running or queued work regardless of the selected history period. The diagnostic
disclosure shows task types with activity or outcomes, grouped as **Backups &
checks**, **Learning & recovery**, **Synchronization & maintenance**, and **Queries
& inventory**. Idle registrations and unobserved task types belong under
**Monitoring coverage**, alongside device-command coverage. The dashboard does
not present every registered kind as a permanently empty operation row.

Coverage includes backup saving/downloading, copy creation, verification,
saved-copy discovery/inspection, learning/rebuild, correction publication,
checkpoint cache, recovery, journal maintenance, replication/pairing tasks,
reset archives, history queries and inventory owners. A direct database download
remains running through transfer and owned cleanup; saving a copy remains running
through final publication and cleanup. Success of an inner copy or verification
cannot establish success of that outer action. Unconfirmed directory durability
preserves the artifact and reports an unconfirmed result. Transfer completion
does not prove durable retention on the receiving device.

CSV import/export workers are observable only in their own process; separate
command-line invocations and unobserved peer work are outside this dashboard.
Unregistered CSV task rows are omitted in favor of one scope explanation. The
existing CLI CSV export writes selected active observations and their source,
receipt, unit, quality and import provenance fields. It does not export the whole
database, learning journal or saved application state and is not a backup.
Pure computation and provider credential/configuration files remain outside
these database-operation families.

Families register when their owner is constructed or first used. Missing
registration is unobserved, not zero; each family reports its own monitoring
start and summarized coverage. Underlying admitted work counts once: shared
waiters, cache hits, repeated starts and coalesced snapshots dropped before
execution add no completed tasks. Existing queue-capacity refusals have a separate
outcome and no execution-duration sample. Fixed categories distinguish completed,
failed, cancelled, superseded and unconfirmed outcomes. A failed cache does not
mean committed learning inputs were lost, and a follow-up failure cannot erase
a confirmed publication. Cancellation requires the actual abort reason or an
explicit abort error; an independently reported I/O failure remains failed even
if the signal also became aborted.

Task elapsed time uses a monotonic clock, includes queue and owned cleanup,
and ends after the owner has joined any worker. It includes computation, transfer
and cleanup where applicable; it is neither SQLite transaction time nor isolated
disk latency. Parent tasks can include separately observed verification or
publication tasks. Pairing creation, individual snapshot chunks and receiving
are separate observed tasks, as are file publication, pinning and maintenance.
The labels do not imply one count per user action. Counts and durations are not additive and are not
merged into runtime writer timings. Existing feature views remain authoritative
for detailed results and physical/control meaning.

The observer performs no I/O, schedules no work and cannot change admission,
control, deadlines, cancellation or operation results. Sparse five-minute
aggregates, the latest finished result and the latest dated problem per fixed
family expire after seven days of elapsed time. A success can replace the latest
result without replacing the problem. Refusals have a dated problem receipt but
no execution duration. Each period includes its latest problem using the same
monotonic five-minute boundary as its counters, so browser/server clock changes
cannot change period membership. At most 128 active summaries are retained; omitted details are
reported while all observed job counts continue, without imposing an execution
limit. Background history survives Store replacement until this application
exits. Each operation retains its original local scope and cannot update a
replacement Store's writer history. Health polling reads the RAM snapshot and
launches no additional scans or persisted diagnostics.

**Storage scheduling** reports the active local Store's writer execution, journal
mode, synchronous setting and checkpoint policy. These are read from the owning
SQLite connection when it opens; the dedicated writer supplies its own settings,
not those of the parent's read connection. Queue and checkpoint policy values
come from the same constants used by execution. Health polling performs no SQL.
The nested `recording.storage` contract is version 1, scoped to `local-store`;
it is distinct from the active master's memory-only save history. Standby can
show its own local queue and policy without borrowing the master's measurements.
Missing or unsupported evidence remains unknown.

The shared queue has control, normal and background lanes, each with current
waiting/running counts and oldest pending age. The active turn reports only a
fixed safe kind and elapsed duration. Control yields to normal work after eight
consecutive control turns when normal work is waiting. With no control request
waiting, background work gets a turn after 32 foreground turns. Limits are 2048
admitted operations and 8 MiB of caller-declared payload, not total process memory.
Priority never interrupts an active native query, checkpoint or synchronization.
Mirroring, recovery, history reads and learning reads can consume many short
turns; computation outside those turns does not own the storage queue. Other
processes and uncoordinated tasks remain outside this scheduler.

The dedicated writer uses `synchronous=FULL`, disables automatic checkpoints and
requests PASSIVE checkpoints through the background lane. When SQLite supports
status-only inspection, a request is eligible at 50 outstanding frames or after
five seconds of observed remaining work, checked every 250 ms. These are triggers,
not hard frame or wall-time bounds: queue waits and pinned read snapshots can let
frames accumulate. Without status-only inspection, the supported SQLite runtime
uses PASSIVE calls no more often than once per second, with no frame trigger.
The dashboard displays the actual selected policy. Direct, unmanaged connections
report their actual automatic checkpoint threshold; read-only connections own no
checkpoint schedule.

Checkpoint duration measures only executed native PASSIVE calls, including calls
that leave frames outstanding. Skipped or throttled polls add no checkpoint sample.
It excludes queue wait and message overhead. The background-turn duration includes
that overhead and all admitted work, including finished failed turns. Background
queue-delay samples cover successful turns only. The last frame observation and
last completed checkpoint keep their own timestamps; a throttled poll cannot renew
them. Outstanding frame counts are not allocated WAL file size. Failed checkpoint
requests have their own current warning and historical counter; they do not turn
an earlier confirmed commit into a failed save. Background failures, cancellation
and queue refusals are counted separately from foreground saves. A checkpoint
failure can also count as a background-turn failure; these are not additive.

**Save stages** places **Writer admission**, **Transaction building**, and **Commit
& confirmation** within the whole **Transaction**, with **Journal sealing** and
**SQLite COMMIT** nested within commit. Callback and dependent SQL time is measured
as building; asynchronous learning between transactions is outside it. Indentation
and explicit labels preserve this hierarchy on phones. The summaries show averages,
approximate 95th percentiles and maxima for the selected monitored period; different
rows can have different sample counts and maxima from different transactions.
**Save outcomes** holds foreground outcomes, while **Storage scheduling** holds
priority waits, lock contention, peak backlog, background outcomes and checkpoint
evidence. **Local tasks** continues to describe complete operations, including work
outside shared storage turns. **Monitoring coverage** retains task and command
coverage; **About these measurements** explains scope and retention.

No observer adds persisted diagnostics, changes command deadlines, or grants control
authority. The current memory-history API remains version 3; earlier history shapes
are unsupported rather than translated. The additional fixed metrics use the same
bounded five-minute aggregates and seven-day retention, resetting on Store reopen.

The separate **Application responsiveness** disclosure shows maximum and p99
observed event-loop delay and the sample count since the application process
started. These measurements cover the whole process run, independently of the
past-day/past-week storage selection or a replacement Store's monitoring period.
They include all application work and cannot attribute a delay to SQLite or
prove device response time. No samples remains explicit; missing evidence stays
unknown. They introduce no automatic warning threshold. Snapshot and history
views do not present these local timings as the master's current responsiveness.

The web API accepts no destination path: authenticated `POST /api/database-export`
with an empty JSON object saves in the configured server folder, and authenticated
`GET /api/database-export` downloads a temporary snapshot. Temporary files are removed
on completion, failure or disconnection. Only one export runs at a time across
the application's direct and ingress listeners. Normal web/ingress authentication applies and is checked again before the
copy is saved or sent. Slave exports hold the verified snapshot they began with
until the operation completes.

An export includes private history and saved application state. Retain the matching
software version for model replay. **Recover history** can import supported gaps
into the active database; a full restore remains the offline operation into a new
database path. The export does not contain the separate private configuration file
or external token files.
The export action shows a dated receipt for up to 24 hours, or until the next
export action. Logout clears it and aborts any browser transfer still in progress.
Browsers with a file picker stream directly to the chosen file; other browsers
receive the complete file before offering their normal download handling, as
explained beside the action. Closing a fold does not cancel an accepted server
operation.

Within this application run, full database verification results belong to the database that was checked,
including when a replacement uses the same path. A known integrity failure
remains attention-worthy through an unsuccessful retry until a successful check
of that database. Global verifier activity separately includes backup, pairing
and recovery checks. Status polling pauses while the verification fold, its parent
or the page is hidden; an accepted check continues, and reopening reads its result.

## Retained storage costs

Unchanged scalar receipts from H66, the Garage adapter and the voltage estimator
share one bounded metadata flush, normally within 30 seconds. Their original
source/receipt endpoints, coverage samples, sampler state and poll totals are
coalesced together. A value, quality or reporting-policy change, a real gap or an
explicit force flush first saves that stream's preceding endpoint. Every accepted
electrical interval still saves its energy and acquisition cursor immediately.
Normal shutdown/handover flushes the remaining metadata. An abrupt crash may
lose the unsaved unchanged-report endpoint/count tail; restart does not invent
continuity or healthy device evidence from it. Read-only recording status describes
committed endpoints and does not force a write.

Recovery, revert and restore flush the pending metadata before changing history.
Confirmations remain immediate for that operation, so its worker compares current
committed coverage. Ordinary batching resumes after success, failure or cancellation.

Charging history records meaningful physical, planning, native instruction and
restriction changes. A brief input-persistence processing gate stays visible in
live command readiness without becoming another shared-history event on every
receipt. Real source loss and native permission holds retain their events. An
active report's current checkpoint supplies its public summary; closing the
connection freezes a final summary for historical listing. Checkpoint field order
keeps large unchanged comparison context ahead of frequently changing fields so
the existing reversible journal splice can leave that prefix untouched.

Durable charging plans retain execution periods, allocations, published prices,
estimated delivery/cost, assumptions and reference provenance. Candidate scenario
vectors remain in the live planner and are rebuilt from the current source
history; they are not retained as a second large runtime/replica cache. Search
accuracy and the complete in-memory planning inputs are unchanged. This does not
remove Home learning inputs or introduce an older storage decoder.

The annual recording budget is a soft objective for estimated adaptive additions,
not a hard storage cap. Exact changes, imports, learning journals, source revisions,
diagnostics and SQLite overhead add growth on top of it. Adaptive selection limits
new measurement rows while preserving required boundaries and accepted energy.
Transaction compaction removes only disposable transaction history; neither
mechanism deletes required observations or learning inputs. Freed SQLite pages
can be reused without shrinking the file or establishing physical flash-write
savings.

Charging reports retain unchanged price arrays and shared forecast context once
per report, with original event references preserving their interpretation.
These owned contexts follow the report's existing retention: completed unsaved
reports expire after the configured period (30 days by default) measured from
session end; active and saved reports remain. Expiry frees pages for reuse and
does not by itself shrink SQLite allocation. This retention is not anticipated
by the annualized recent-growth figure. The inventory describes Caravan shutdown
restoration events as historical unconfirmed outcomes, separately from whether a
restoration obligation remains active now.

The explicit storage inventory separates observation pages, other retained
history, current state and derived caches, disposable transaction history, pending peer catch-up storage,
protected branches, indexes, SQLite overhead and reusable pages. Page statistics
run in the inventory worker, never on recorder or control ticks. Reusable pages
remain inside the allocated SQLite file; they do not mean the file has shrunk.
The live WAL, backups and private transfer staging add separate disk use. The
bounded recent transaction suffix is not a total storage cap: peer catch-up
retains one entry and original value per changed record, including deletions,
until the peer acknowledges it; protected divergence remains preserved.

Every accepted electrical interval durably updates its pending sum and acquisition
cursor. Deferring these writes would risk loss or double counting after a crash.
SQLite WAL/FULL synchronization and atomic publication remain part of that
contract. Learning inputs retain resolved configuration, seeds and original
meaning even when another record has the same configuration digest.

Decision events retain each controller decision. Their current use also supplies
replica status freshness, so deduplicating repeated summaries requires a separate
heartbeat design. Disposable state versions and hourly recording statistics have
their own bounded retention. Sparse supported learning checkpoints remain
available independently; neither retention policy deletes reconstruction inputs.
Recovery indexes also consume space on scalar observations. Any index or journal
representation change needs current-schema validation and an intentional fresh
development database when incompatible; no cleanup should add a migration or
silently remove evidence.

Current physical schema 32 includes a chronological coverage index for seeking
the next boundary in one source/device/signal stream. Charts retain the original
recovery selection, equal-start ID precedence and full successor timestamps,
including boundaries beyond the drawn range. They do not materialize all retained
coverage or impose a historical lookback that could discard a long span.
The index is not created by a chart request or by opening an incompatible database.
For this index only, the owner approved a one-time controlled installation upgrade
on 2026-10-15, preserving all table rows, journal/checkpoint identity and learning
history, with verified backups, strict current validation and rollback. This adds
no general migration or startup repair. Journaled data layout 30 is unchanged;
the physical schema identifier does not redefine journal hashes. Schema 32 also
restricts the journal record index to model-checkpoint/epoch/selection reversal
and the recovery-energy index to rows with interval ends. Other journal reverse
queries retain their complete results without indexing every recorder or charger
receipt. The earlier exception does not authorize this schema-32 installation
transition; existing incompatible files are rejected before mutation.

## History CLI backups and exports

These commands operate on the current database contract:

```sh
npm run history -- export --output /tmp/indoor.csv --signal indoor_temperature
npm run history -- backup --output /tmp/st-mq-backup.sqlite
```

Select `--db <path>` when the default database is not the intended source.
Backups use the same verified, self-contained SQLite snapshot generator as dashboard
exports and reset archives. They publish only a completed copy without requiring
WAL/SHM companions. Restore
to a new path while the target application is stopped; validate the result before
switching the configured database. Keep backups on separate storage. An existing
incompatible or malformed database is rejected before mutation.

To inspect a restored copy, choose a new directory and use the runtime's database
filename, `st-mq.sqlite`. For example:

```sh
npm run history -- restore --input /tmp/st-mq-backup.sqlite --db /tmp/stmq-history-view/st-mq.sqlite
STMQ_TOPOLOGY=standalone STMQ_INPUT=offline STMQ_DATA_DIR=/tmp/stmq-history-view STMQ_DATABASE_DIR=/tmp/stmq-history-view STMQ_PORT=1235 npm start
```

The explicit directory makes the viewer open the restored copy. Setting only
`STMQ_INPUT=offline` would open `st-mq.sqlite` in the usual configured database
directory instead. Offline input starts no device providers; standalone topology
keeps this inspection separate from pairing. Remove the temporary copy only after
finishing the inspection; retain the original backup separately.

Raw observation queries are bounded to 5,000 observations; `/api/history` limits
a request to 31 days. `/api/chart` accepts inclusive calendar dates with a named
`view` or an individual `left` projection, not both. Its 100–2,000 drawing buckets
per series summarize up to 3,660 calendar days without deleting source history.
There is no general automatic history deletion policy. Monitor growth and use
tested backups/exports. For supported old exports, see [0.7.5 CSV import](csv-import.md).
