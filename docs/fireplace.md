# Fireplace logging

Press the **Fireplace** icon at the top right of the **Home** card to open the
fireplace window. Choose a whole number from **2 to 10 kg**, initially **8 kg**,
and press **Record firewood now**. The server records
the current time. Each deliberate press records another load, including simultaneous
fires and extra wood. The two similar masonry fireplaces share one response model.
Use the weight of dry firewood consistently; this is a manual fuel estimate, not a
measurement of combustion efficiency or delivered heat.

The panel lists unremoved loads from the past 48 hours in Finnish local time, newest
first. **Remove** corrects a mistaken entry. Its explanation says whether learning
must be updated and that the original record remains saved. Family access can
remove a load for 15 minutes after it was recorded; older removals require admin
access. A corrected amount is
entered as a new load. There is no backdating interface. An unconfirmed save can be
retried with the same request identifier, including after reloading the page,
without creating another load. Separate deliberate saves have different identifiers.

When rebuilding is necessary, the panel reports that it is updating the model while
heating control continues. The worker builds the replacement in the background and
the engine swaps it when it has caught up. See the
[reconstruction contract](reconstruction-and-versioning.md) for exact semantics.
On a read-only view, a saved reconstruction request is labelled as recorded;
current worker progress remains unknown. Action receipts stay visible for 24
hours, while an unresolved save remains available to retry.

## How the model uses a load

Fuel is a pooled delayed input: a fixed response with a two-hour burn time and an
18-hour release time models gradual warming and cooling of masonry. Its normalized
release tail lasts 120 hours. The 48-hour list is only the interface window; it does
not discard heat that is still being released. Overlapping loads add together.
The initial effective response is 0.15 degrees C per released kg. This is a
provisional model coefficient, not a measured room-temperature rise or kWh/kg.

Only the effective fireplace gain is fitted. The response timing stays fixed until
there is evidence to justify a richer model. Meaningfully fire-affected intervals cannot teach
the normal comfort baseline or substitute for clean observations of the house's
heat loss and compressor response. Candidate and normal-heating forecasts include
the same fireplace release, so wood heat is not credited as tariff-control savings.

Learning the gain requires an established house model, independently informative
firing groups in training, and at least three later firing groups for validation.
The house model can be anchored by at least 96 known clean intervals in the fitting
window or by previously validated, unchanged house coefficients. With the latter
anchor, only the fireplace gain is fitted; daily fires do not require another 96
new clean intervals. Multiple loads within a day do not count as
independent experiments. Old periods before logging began are not proof of no fire.
Sauna use, cooking, open doors, omitted loads and variable wood moisture remain
unmeasured disturbances; logging a fire does not make all heat inputs identifiable.

Until the fireplace response is validated, meaningful remaining influence keeps
automatic price-shifting cycles and trials on normal heating. Comfort protection
still runs. Control sums overlapping loads: expected remaining warming plus a
structural uncertainty allowance must be at most 0.1 degrees C, and the next hour's
contribution at most 0.02 degrees C, before an unvalidated tail stops blocking price
control. This allowance is not a statistical confidence interval. The full release
curve still enters predictions. For baseline/core learning and cycle assessment,
release at or below 0.02 kg/hour is negligible; unknown release remains excluded
when a fire is known active. Significant daily fires can still limit evidence, but
a tiny residual does not automatically exclude five days. A corrected affected cycle cannot establish savings
or certify the original model's control forecasts.

## Visibility and estimated savings

**Home → Home heat model** explains manual kilograms, calculated delayed release
and the effective fireplace response in degrees C/kg, including its evidence status. The
**View** menu groups **Firewood additions**, **Modeled fireplace release**, daily
**Firewood electricity cost avoided** and **Firewood electricity avoided** under
Fireplace. **Fireplace response** is a separate Home coefficients view because its
°C/kg unit differs from fuel events and modeled release. Individual signals are
also searchable in Series explorer.
Simultaneous additions share a marker with total kilograms and load count. Release
includes tails from loads before the selected dates. Before logging began, missing
records do not establish zero firewood. Corrections update these derived views.

The **Fireplace** activity strip below the chart starts at each recorded addition
and lasts for the model's shared `FIREPLACE_RESPONSE.burnHours` value, currently
two hours. Overlapping additions merge into one continuous interval, and removing
a mistaken entry updates the strip. This marks the model's burn timescale; masonry
continues releasing heat after the strip ends. **Hot-water circulation request** and **Pump mode** have
their own selectable rows in relevant views, so simultaneous activity remains
visible. Every row title expands to explain its colours and evidence. Hover or
drag a strip to move the shared time cursor through the plot and visible strips;
titles and gaps remain clear. Each view remembers the enabled rows.

The **Energy cost comparisons** fold contains **Heating**, **Charging** and
**Firewood**. Heating and Charging retain their same-energy timing comparison.
Firewood estimates avoided space-heating electricity and its variable all-in cost,
with wood priced at zero. These comparisons must not be added together: they use
different reference cases. DHW and fixed charges are excluded from firewood savings.

The estimate runs two normal-heating simulations from the same recorded state
before the first fire, with the same weather, comfort targets and dated configuration.
One includes all corrected loads; the other includes none. Their temperatures and
heating duty evolve independently. Recorded native compressor demand is not imposed
on either hypothetical branch. This permits overheating, diminishing returns and
negative-price disadvantages; kilograms are not multiplied by a fixed savings
factor. A warmer room alone does not prove that the installed pump used less energy.

The headline covers only supported, priced elapsed intervals in the selected chart
dates. Earlier fires warm up the comparison without charging their earlier savings
to this selection. Missing prices reduce coverage; missing thermal inputs can make
later dependent comparisons unavailable. Daily points retain partial coverage and
missing days. After unsupported history or a gap, a fresh partial comparison may
start at a supported observation boundary only after all earlier logged release
curves have expired. The initial reserve then uses observed room temperature;
earlier unresolved effects remain excluded, and the estimate stays provisional.
This assumption does not establish that every trace of stored wood heat vanished.
Remaining fuel is separate; any future monetary estimate uses only
a continuous fresh weather/price forecast and is explicitly partial. It is never
added to the accrued headline. A short forecast bridge from the last completed
learning window to now is also excluded from accrued savings.

Estimates use the current verified source model, or labelled initial assumptions
when unavailable. Thermal fireplace validation alone does not validate electrical
displacement. The latter requires later observed compressor/auxiliary behavior,
several independent fire days, matched clean conditions and improvement over a
no-fire prediction after baseline bias adjustment. Until then the estimate is
provisional. Successful refitting starts a new electrical holdout; this check needs
a model that remains unchanged long enough to accumulate independent later evidence.
Hot-water operation cannot count as evidence of fireplace-induced heating backoff.
The range varies fireplace response, heat loss, heating response and
electrical power, and always includes zero displacement. It is a scenario range,
not a measured saving or statistical confidence interval. Even validated results
remain estimates. Free wood does not imply savings under every price or heating
condition.

## Storage

Run `node scripts/benchmarks/fireplace-storage.js` for a synthetic, uncapped SQLite
comparison. It retains full learning-window resolution and includes source events,
indexes, algorithm identifiers and bounded checkpoint overhead. It does not copy
household data. The results are workload estimates, not a hard upper bound on a
live database, its WAL or repeated temporary writes. Raw telemetry recording rates
and CSV import formats are unchanged.

A 365-day synthetic run with four loads per day, 10% removals and two retained
8-hour cycles per day measured **2.46–3.42 MB of first-year additional SQLite
storage**, depending on whether 15-minute observations retained one segment or
three 5-minute segments. This includes approximately 0.50 MB of bounded checkpoint
overhead, counted once, plus source events, cycle records and longer journal version
identifiers. Raw learning-window payloads remained unchanged. Different control-cycle
or source-segment density changes this estimate; it is not a guaranteed 5 MB cap.

The authoritative database stores no new interval or daily firewood savings rows.
Paired savings are reconstructed in the read-only chart worker. A private disposable
`temporary-firewood-projection` directory beside the installation database retains
sparse paired-state checkpoints and compact corrected burn-group boundaries. Actual
wood amounts and removals are read from the indexed source events for each window.
It is separate from backups, mirroring and control authority. It contains private
household-derived data and must receive the same access protection as the database.
Removing it never removes source events, learning inputs or the model.

Each numerical checkpoint is taken at an existing completed-input boundary, roughly
weekly, and includes the exact thermal states and electrical-validation accumulators.
The four model bodies are shared by the current calculation rather than repeated in
every saved state. Individually addressed compressed bodies are limited to 4 MiB
expanded, with at most 16 MiB of retained compressed numerical bodies and a 20 MiB
SQLite page ceiling for the whole disposable file. Old points may be evicted;
requested missing points are rebuilt in the background. These ceilings are cache
budgets, not source-history retention limits or guarantees that every historical
period remains immediately cached.

Fixed-period requests resume before their first requested/price boundary and process
at most an eight-day warmup tail. They preserve the original source segments, price
boundaries, unknown periods and independent with/without-fire policies. A missing,
corrupt, evicted or invalidated prefix returns an explicit preparing state instead
of synchronously reading the archive. The UI continues showing other chart data and
refreshes the estimate after preparation. Idle maintenance reads at most 128 journal
entries per turn, yields between turns and persists resumable progress. It works
also when the recent raw-chart cache is disabled. Small manual-source projections
can prepare within the same bounded request; larger ones continue in maintenance.
The resident chart worker owns cache writes; archive workers and retired replica
views only read it. Completed idle maintenance does not repeat preparation or
source-proof publication. Private LRU timestamps may refresh at most once per
five minutes for an accessed checkpoint; they do not write source history. Background
source-proof requests have a short bounded wait and retry backoff, so an unavailable
peer cannot hold an ordinary chart request for the peer connection timeout.

Checkpoints bind the current simulation inputs, supported algorithm, source selection,
proven fireplace prefix, local cache identity and numerical runtime. The simulation
identity includes thermal parameters, floor/source assumptions, effective Normal
response, auxiliary calibration and the fireplace-validation scenario choice.
Reporting counters, provenance text and training timestamps do not by themselves
discard an unchanged thermal trajectory. Electrical holdout evidence retains its
own training boundary: a newer fit withdraws earlier evidence immediately. A
changed boundary inside previously accumulated evidence resumes before that
boundary and reaccumulates original complete segments without prorating cells.
Checkpoints require a matching source transaction proof. A small source-owned
pending/published cache anchor binds the compact cache catalog and preserves that proof across normal
transaction-journal pruning. It contains no derived heating state and grants no
control authority. A rewind, divergent source or missing matching proof cannot
bless old results. Frozen read-only histories can use their retained source proof
without a writable owner. A new load strictly after a proven calculated boundary
extends the manual-source tail and preserves earlier thermal checkpoints, including
while the learning checkpoint adopts the new source revision. Removals, backdated
loads and changed selections retain conservative correction handling. Maintenance
uses its current clock rather than the last chart request's clock. Deferred input
activation resumes before its first affected source ID, preserving unaffected
earlier calculations even when later IDs have earlier timestamps.
Forward learning appends catch up from the retained prefix. A numerically changed model
or correction can require a complete background reconstruction because earlier heat
continues to affect both thermal states. Earlier coefficients are never presented
as a current-model answer. This necessary reconstruction still scales with retained
inputs; routine chart requests do not wait for it. Clock-only refreshes reuse the
completed paired calculation and update elapsed coverage and the fresh forecast
separately. A cache failure leaves the estimate unavailable without changing source
history or granting control authority.
