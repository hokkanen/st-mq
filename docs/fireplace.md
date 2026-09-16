# Fireplace logging

Open **+ Fireplace** beside the heating status. Choose a whole number from **2 to
10 kg**, initially **8 kg**, and press **Record firewood now**. The server records
the current time. Each deliberate press records another load, including simultaneous
fires and extra wood. The two similar masonry fireplaces share one response model.
Use the weight of dry firewood consistently; this is a manual fuel estimate, not a
measurement of combustion efficiency or delivered heat.

The panel lists unremoved loads from the past 48 hours in Finnish local time, newest
first. **Remove** corrects a mistaken entry. Its explanation says whether learning
must be updated and that the original record remains saved. A corrected amount is
entered as a new load. There is no backdating interface. An unconfirmed save can be
retried with the same request identifier, including after reloading the page,
without creating another load. Separate deliberate saves have different identifiers.

When rebuilding is necessary, the panel reports that it is updating the model while
heating control continues. The worker builds the replacement in the background and
the engine swaps it when it has caught up. See the
[reconstruction contract](reconstruction-and-versioning.md) for exact semantics.

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

**Learning models → Home** explains manual kilograms, calculated delayed release
and the effective fireplace response in degrees C/kg, including its evidence status. The
left-axis drawer adds **Manually recorded firewood additions**, **Fireplace release input**,
**Fireplace response**, and daily **Firewood electricity cost avoided** and
**Firewood electricity avoided**.
Simultaneous additions share a marker with total kilograms and load count. Release
includes tails from loads before the selected dates. Before logging began, missing
records do not establish zero firewood. Corrections update these derived views.

The **Fireplace** activity strip below the chart starts at each recorded addition
and lasts for the model's shared `FIREPLACE_RESPONSE.burnHours` value, currently
two hours. Overlapping additions merge into one continuous interval, and removing
a mistaken entry updates the strip. This marks the model's burn timescale; masonry
continues releasing heat after the strip ends. **DHWR** and **Pump mode** have
their own strips below the chart, so simultaneous activity remains visible.

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

Run `node scripts/benchmark-fireplace-storage.js` for a synthetic, uncapped SQLite
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

The visibility and savings additions store no new interval or daily database rows.
Chart inputs, coefficient histories and paired savings are calculated in a read-only
worker with bounded caches. They add computation, not another annual savings-history
table. Model publication and fireplace corrections invalidate cached estimates,
including completed historical views.
Clock-only refreshes reuse the completed paired calculation and refresh elapsed
coverage and any fresh forecast separately. A new committed model or input prefix
requires a new calculation; the first large-history request can take longer.
