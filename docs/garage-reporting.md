# Garage reporting and charts

The **Heating** card in **Energy cost comparisons** starts on **Home** and
**Model estimate**, unless a previous **Timing cost** choice was saved. Its
Home / Garage / Total selector changes the display only. Model estimate and
Timing cost remain separate comparisons. Neither is added to Charging or Fireplace.

Home model money keeps its existing scope: attributable space-heating cycles,
including recovery and excluding domestic hot water. A completed cycle contributes
its full frozen assessment on its Finnish completion date. Home's execution
electricity uses a temperature-dependent heat-pump source estimate, not a dedicated
meter reading; this differs from the dated nominal powers used in Home timing.
Garage applies the same completion-date rule to its own frozen normal-reference episodes, stored under
`garage:<input>`. Active, incomplete, unsupported and mixed-scope assessments do
not become completed savings. A cycle that starts before the selected period is
counted once when it completes. No rolling euro-per-cycle mean enters a total,
and charger session costs use a different reporting boundary and reference.
Garage completed estimates remain provisional; recorded electrical inputs do not
make the counterfactual directly measured.

Timing cost uses `DailyTimingBenchmark` in
`src/app/daily-timing-benchmark.js`. Each system's included daily energy is priced
at its original times and at the complete Finnish day's time-weighted all-in
price. The benchmark respects 23-, 24- and 25-hour days and dated tariff
assumptions. Constant prices give zero timing benefit, even with nonzero energy.
Every timing scope requires complete full-day prices even when its recorded
energy covers only part of that day; missing prices are distinct from missing
electrical evidence. All integration happens before chart decimation.

The existing Home timing assessment is reconstructed from recorded equipment
operation and dated nominal powers; it is an operation estimate, including the
domestic-hot-water electricity scope. Its nominal-power estimate is distinct from
the temperature-dependent estimate used for completed Home cycles; neither claims
independent electrical measurement. Combined reports retain that qualification.
Garage timing accepts only dedicated `garage_energy` intervals with known kWh units, complete
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
Details expose the included timing kWh and actual-time/reference costs, or the
completed assessments' execution/reference costs. The difference subtracts the
execution or actual-time cost from its reference; negative values mean extra cost.

The Garage heating configuration follows Home's current-state, temporary-control,
price-control pause, strategy-and-limits and separate heat-model structure.
**Heating strategy & protection** shows Gentle, Balanced or More savings,
effective minimum benefit, benefit retained, minimum planned reduction time,
normal-heating dwell, daily limit and independent reference-pipe assumptions.
**Garage heat model** explains recorded/modelled inputs, learned cooling,
observed normal power, fixed assumptions and the evidence from later outcomes.
It keeps decision rules in the strategy section and does not imply a completion
percentage or validated savings from temperature accuracy alone.
There are two adjustable thermal coefficients, rear/front cooling per hour.
**Validated OFF evidence** reports the duration covered by clean episode checks.
It is never labeled a maximum reduction duration: longer forecasts receive extra uncertainty
margins, and temperatures plus the pipe reserve determine the safe duration.

The Mitsubishi Heat-pump settings fold includes a persistent **Room setting**
down to 5°C when external temperature control is available. Below 16°C the
requested room setting is distinct from the actual native 17°C readback. Status
shows the Garage rear sensor, offset, remote temperature and active or fallback
state; it never infers Mitsubishi i-save. The owning instance retains the chosen
room target without expiry, bound to the configured device; slaves are read-only.
Native settings come from the pump. Enabling or renewing the external feed requires fresh
ON, HEAT and 17°C readbacks; a failed check stops renewals and lets the current
lease expire. Missing or stale source evidence also ends the feed. Internal-sensor
control uses the pump's current native settings, 17°C if unchanged from setup;
blocked renewals cannot be presented as an active low-temperature feed. Native frequency
and activity are not reported as watts. Known charger power has a separate 7.5%
heat assumption; missing input stays unknown. Future opportunities display their
planned start and end even before any effective target is changed.

The pipe reference remains a continuous sensible-heat estimate in kJ/m, with an
independent state at rear and front. No percent indicates a fixed full allowance.
Protection or restoration blockers remain visible independently of learning and
economic qualification. A new cold-door admission reason does not imply that an
open door automatically cancels an already authorized reduction.

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
menu entries, and closed/open layouts at 1440, 390 and 320 pixels. Synthetic
manual external-handover states also check that clear-before-OFF and native-ON restoration and fallback
explanations stay visible, the selection remains requested until confirmation,
and competing heating buttons stay disabled. Screenshots are
left in a reported temporary directory for visual review. No existing browser
session or household service is used.

Manual heating feedback keeps requested selection, fresh native readback and
command outcome distinct. The button area reports external handover, bounded OFF
publication, confirmation and restoration. A delivery failure remains visible
after the manual selection is cleared; a fresh power observation alone does not
claim that a command or queued-work cancellation was confirmed.

Automatic savings have a separate presentation: the saved room setting stays
visible while details identify the effective lower target, its deadline and
external-input acknowledgement. Native power remains ON. The browser smoke
includes both pending and acknowledged automatic target states at 320, 390 and
1440 pixels in both themes. A planning-only window
is not shown as an actual reduction request. Reduced-target confirmation requires
current native ON and a current acknowledged automatic target; native OFF cannot
confirm it. Manual timed OFF still confirms native OFF and displays its independent
clear/restore progress. The lower-target electricity and recovery estimates remain
provisional and separate from historical native-OFF cooling-validation evidence.
