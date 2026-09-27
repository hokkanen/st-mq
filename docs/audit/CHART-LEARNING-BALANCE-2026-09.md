# Chart learning-view review — September 2026

The original catalogue was unbalanced: Home had twelve views split into inputs,
coefficients and outcomes, while Garage had four views mixing inputs and
coefficients in one group. Garage also had an electrical-input comparison in its
operational group. Its missing outcome views hid useful evidence already saved
by the model; the difference was not just a consequence of Home being larger.

## What each model can explain

Home estimates a hydronic building response, with stored-heat delays, outdoor
loss, solar gain and fireplace response. Its four fitted coefficient quantities
have incompatible units. Combining them into one axis would imply a comparison
that has no physical meaning. Compressor duty, estimated thermal heat and solar
input also need different units. Some extra Home detail is therefore useful.

Garage fits two OFF cooling rates for separate rear/front protection locations.
It estimates normal electrical input from qualified observations or an explicit
initial assumption. Normal recovery and charger warmth use fixed assumptions;
there are no additional learned heat, solar or charger-response coefficients to
chart. Adding such views would imply evidence the learner does not have.

Both models nevertheless answer the same three useful questions: what evidence
was supplied, which responses were learned or assumed, and how the resulting
predictions and assessments performed. The revised catalogue follows those
questions for both systems.

## Revised comparisons

| Purpose | Home | Garage |
| --- | --- | --- |
| Saved inputs | Temperatures and control; hydronic heat; compressor duty; solar input | Temperatures and front–rear difference; compressor/charger activity; existing separate electrical-input view |
| Coefficients | Heat loss; combined compressor/auxiliary response; solar response; fireplace response | Rear/front cooling rates together; normal electrical input |
| Outcomes | Rolling benefit per completed heating cycle; rolling absolute recovery-cost error | Achieved normal warmth references; rolling held-out OFF cooling error; provisional benefit per completed pause and recovery |

Home now has ten curated learning views. Garage has seven in matching learning,
coefficient and outcome groups, plus its unchanged electrical-input comparison
under Garage. This preserves a modest Home emphasis without duplicating views
merely to equalize the count.

Home's ROOM boost and saved control states belong beside the temperatures and
reference they influenced. The redundant standalone control-treatment view was
removed; ROOM boost is optional and uses a separate Δ°C axis. The lower-priority
saved auxiliary electrical view was removed from the curated list. Its original
series and provenance remain searchable in All series. The operational auxiliary
electricity comparison and combined thermal-input view remain prominent; kW
electricity and kW thermal are never combined as interchangeable quantities.

## Meaning and limits of the added Garage outcomes

Normal warmth references appear only after qualified normal operation establishes
them. A configured or selected room setting alone is not an observed achieved
temperature. Original saved rear/front inputs remain separate from reconstructed
references. Sensor corrections can change those reconstructed references.

Cooling error is rolling RMSE of clean held-out OFF forecasts in the learner's
bounded episode history, including failed checks. It is a temperature difference
on its own axis, not a room temperature. Before qualifying held-out evidence,
the series is missing rather than zero. Each underlying forecast froze its model
before the episode but used observed outdoor conditions; this evaluates model
response, not forecast-weather accuracy. Evidence counts accompany the value.

Pause benefit is an individual completed-episode estimate in euros. It appears
at completion, includes recovery, and compares the saved execution assessment
with its frozen normal-heating alternative. It remains provisional even when
actual electricity used qualified recordings: the alternative is modeled.
Tooltips retain uncertainty and the electrical basis. Zero and negative outcomes
are meaningful; incomplete or unqualified episodes do not become zero savings.

Home's outcome series are rolling means; Garage's money points are individual
episodes. Their labels and descriptions make that difference explicit. No single
combined Home/Garage error chart is offered: Home's recovery-cost error is in
euros while Garage's cooling forecast error is in Δ°C.

## Implementation boundary and validation

The original input journals, current algorithm and correction context remain
authoritative. Garage references/errors share the existing read-only coefficient
replay and cache. Money reads compact fields from completed saved assessments;
private episode identifiers and frozen model payloads stay in the database.
Unsupported algorithms remain unavailable. No recorder, model semantics,
configuration, schema, migration or compatibility alias was added.

Regression coverage checks source/date/as-of isolation, missing versus zero,
negative benefits, current algorithm gates, shared replay, correction/reset gaps,
provenance and event-only rendering. Browser checks use isolated synthetic
fixtures for view selection, axes, tooltips, colours and narrow/fullscreen layouts.

The standard suite passed 3,712 tests. Later refinements passed 41 final focused
checks, including ten new Garage outcome cases and actual Chart.js geometry
checks for sparse-reference zooms. The production build and final synthetic
Chromium run passed for all 44 named views and 129 series, both themes,
320/390px portrait, 600–932px landscape, tablet and desktop. The browser checks
also cover deliberate search focus, legend scroll retention, and aligned chart
controls and disclosure headers. No household data or equipment was used.
