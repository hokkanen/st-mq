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

The equipment area adds a closed Mitsubishi heating fold with separate front/rear
readings, remaining heat reserve in kJ/m, limiting location, native readbacks, health,
accepted lease and unresolved restoration. Its nested settings fold shows the
three owner preferences using the application's existing configuration-and-reload
workflow. Freezing protection shows the 1°C protection margin, 21 mm reference
pipe diameter, assumed 1 mm wall, 20 W/m²·K heat-transfer estimate and fixed 2×
safety factor. It briefly explains the pipe reference for protecting pipes and
stored liquids, independent local allowances and continuous temperature-dependent
recovery. No percentage suggests a fixed full allowance, and the old air hard
limit, degree-minute allowance, recovery temperature, warm-up duration and fixed
repayment controls are removed. An End garage pause action releases only an owned restoration obligation;
it stays disabled on replicas, without compatible actuation capability, or when no
managed pause needs restoration. Home and Garage each have a closed learning summary in their heating configuration,
above the pause controls. Each uses matching
outcome, input and coefficient sections with values and provenance visible in expandable rows.
Garage separates pause readiness, learned references and model records from the
detailed episode checks under Validation & evidence. Input definitions distinguish
reported temperatures, the calculated front–rear difference, modeled building warmth
and protection context. Coefficients are grouped by rear air, front–rear difference,
pump electricity and fixed building assumptions. Evidence includes complete cooling
and recovery episodes and prediction errors, without a completion percentage.

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
