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
there is evidence to justify a richer model. Fire-affected intervals cannot teach
the normal comfort baseline or substitute for clean observations of the house's
heat loss and compressor response. Candidate and normal-heating forecasts include
the same fireplace release, so wood heat is not credited as tariff-control savings.

Learning the gain requires an established house model, at least 96 known fire-free
intervals, independently informative firing groups in training, and at least three
later firing groups for validation. Multiple loads within a day do not count as
independent experiments. Old periods before logging began are not proof of no fire.
Sauna use, cooking, open doors, omitted loads and variable wood moisture remain
unmeasured disturbances; logging a fire does not make all heat inputs identifiable.

Until the fireplace response is validated, an active fireplace tail keeps automatic
price-shifting cycles and trials on normal heating. Comfort protection still runs.
Frequent daily firing can delay validation because it leaves little known fire-free
data; this is deliberately conservative rather than treating a guessed response as
permission to reduce heating. A corrected affected cycle cannot establish savings
or certify the original model's control forecasts.

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
