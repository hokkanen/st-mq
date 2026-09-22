# Garage reporting and charts

The existing Heating savings card starts on **Home**. Its small Home / Garage /
Total selector changes the display only. Model estimate and Timing cost remain
separate comparisons. Neither is added to Charging or Fireplace savings.

Home model money keeps its existing scope: attributable space-heating cycles,
including recovery and excluding domestic hot water. A completed cycle contributes
its full saved assessment on its Finnish completion date. Garage applies the same
completion-date rule to its own frozen normal-reference episodes, stored under
`garage:<input>`. Active, incomplete, unsupported and mixed-scope assessments do
not become completed savings. A cycle that starts before the selected period is
counted once when it completes. No rolling euro-per-cycle mean enters a total.
Garage completed estimates remain provisional; recorded electrical inputs do not
make the counterfactual directly measured.

Timing cost uses the existing `DailyTimingBenchmark`, extracted unchanged into
`src/app/daily-timing-benchmark.js`. Each system's included daily energy is priced
at its original times and at the complete Finnish day's time-weighted all-in
price. The benchmark respects 23-, 24- and 25-hour days and dated tariff
assumptions. Constant prices give zero timing benefit, even with nonzero energy.
All integration happens before chart decimation.

The existing Home timing assessment is reconstructed from recorded equipment
operation and dated nominal powers; it is an operation estimate, including the
existing domestic-hot-water electricity scope. This feature preserves that
calculation and labels its qualification in combined reports. Garage timing
accepts only dedicated `garage_energy` intervals with known kWh units, complete
coverage, explicit timing eligibility and a qualified counter-delta or power
integration basis. Intervals may be at most fifteen minutes. Coarse totals,
unknown scaling, stale/retained source evidence and overlapping intervals are
excluded. Every member of an overlapping group is excluded, including nested
source duplicates. Live and simulation observations remain separate. Simulation
never acquires a measured-energy label.

Garage temperature learning does not require a meter. Without qualifying
electrical intervals, its timing comparison is unavailable; temperature learning
and provisional counterfactual assessment can still continue. Native power,
cumulative energy and frequency remain separately named live equipment values.
Frequency is never converted into recorded watts.

`heatingSavings` in the chart response contains `home`, `garage` and `total`, each
with separate `model` and `timing` fields. Existing `heatingBenefit` and
`timingBenefit` fields retain their original Home/Charging meaning. The common
reporting layer accepts euro period totals with matching periods, calculation
time, method, completion/elapsed stage and aggregation basis. Only explicitly
separate Home heat-pump and Garage heat-pump scopes can form a total. Overlap,
unknown scope or incompatible units/basis makes the total unavailable.

Missing evidence is not zero. A supported contribution with the other system
missing appears as a **partial total**, naming the missing component. Negative
money is preserved. A supported zero is distinct from missing evidence. The
breakdown shows each scope's assessment count or elapsed-time coverage and source
qualification. Combined timing coverage divides included Home plus Garage time
by their combined elapsed time; it does not imply that the same hours were
observed in both systems. Missing periods are never scaled up.

The Garage heating configuration follows Home's control, pause and learning
structure. Savings & protection lists explicit minimum benefit, minimum planned OFF time,
normal-heating dwell, daily limit and reference-pipe assumptions. Garage learning
has four matching sections: **Learning outcomes · Calculated**, **Model inputs ·
Recorded & modeled**, **Model coefficients · Current values**, and **Planning &
safeguards · Decisions & limits**. Rows distinguish learned cooling, observed normal
power, fixed assumptions and unavailable readings without a completion percentage.
There are two adjustable thermal coefficients, rear/front cooling per hour.
**Validated OFF evidence** reports the duration covered by clean episode checks.
It is never labeled a maximum pause: longer forecasts receive extra uncertainty
margins, and temperatures plus the pipe reserve determine the safe duration.

The Mitsubishi Heat-pump settings fold includes a permanent **Room setting**
down to 5°C when external temperature control is available. Below 16°C the
requested room setting is distinct from the actual native 16°C readback. Status
shows the Garage rear sensor, offset, remote temperature and active or fallback
state; it never infers Mitsubishi i-save. The owning instance persists the target;
replicas are read-only. Stale source evidence leaves the native 16°C fallback and
cannot be presented as an active low-temperature feed. Native frequency
and activity are not reported as watts. Known charger power has a separate 7.5%
heat assumption; missing input stays unknown. Future opportunities display their
planned start and end even before a live OFF lease exists.

The pipe reference remains a continuous sensible-heat estimate in kJ/m, with an
independent state at rear and front. No percent indicates a fixed full allowance.
Protection or restoration blockers remain visible independently of learning and
economic qualification. A new cold-door admission reason does not imply that an
open door automatically cancels an already authorized pause.

The chart selector includes separate Garage model input and coefficient groups.
Inputs come from the original normalized immutable garage journal, preserving
rear-only prefixes, front gaps and outdoor provenance. Coefficients use the same
ordered `applyGarageEntry` function and explicit correction context as runtime
rebuilding. Unknown algorithms, missing seeds, checksum failures and dependent
invalid tails leave gaps. Replay stops before the first future journal entry,
including when a later record has an earlier timestamp. The chart worker never
writes observations, checkpoints or commands. Per-axis replay caches are bounded
to four timelines of at most 25,000 compact events and resume immutable prefixes;
a selection older than a retained cache prefix replays from its saved seed.

Tests cover DST timing, zero/negative prices, qualified and absent electrical
data, delayed arrivals, overlapping sources, partial and incompatible totals,
completion dates, assessment cache invalidation, rear/front identity, deterministic
coefficient replay, source gaps and read-only chart behavior. UI tests retain the
Home default, comparison choice, keyboard focus and native disclosure state while
switching scopes. These are software and simulation checks, not installed adapter
commissioning, meter calibration or evidence of realized savings.


`node scripts/browser-garage-smoke.js` starts its own disposable simulated app and
isolated Chromium profile. Build the browser assets first. Set `STMQ_CHROME_BIN`
when Chrome/Chromium is not installed at `/opt/google/chrome/chrome`. The smoke
checks scope arithmetic, disabled release without an owned episode, the new chart
menu entries, and closed/open layouts at 1440, 390 and 320 pixels. Screenshots are
left in a reported temporary directory for visual review. No existing browser
session or household service is used.
