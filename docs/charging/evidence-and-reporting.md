# Charging evidence and reports

[Charging overview](../charging.md) · [Code map](architecture.md)

This contract owns progress, connection cost, passive session reports and their storage. [Guided assessments](guided-assessments.md) add explicit assessment assumptions; [physical development tools](testing.md) record selected manually operated cases. Neither supplies production control authority.

## Battery references and requests

A manual state-of-charge value is a one-time anchor. A newer applicable vehicle
reading supersedes it using the provider's source clock, or explicitly labeled
receipt time when no measurement clock exists. A pinned capacity outranks provider
capacity. An explicit requested minimum remains distinct from the vehicle's
actual ceiling; requesting 95% with a reported 80% ceiling is constrained rather
than silently rewritten. Vehicle current limits and native not-before times
constrain either charging point.

An independently qualified Tesla current request retains its original receipt
and supply provenance through controller pilot changes. The current raw request
and maximum remain separately visible, including a stopped report or invalid
value; neither can silently replace the older qualified constraint. Qualification
is a physical-session constraint, not permission to start or new measured draw.

## Charge progress and cost

Physical electricity sources are always Easee for C1 and Shelly EVSE for C2, regardless of vehicle identity. Progress uses accepted interval kWh plus the recorder's admissible pending tail. Wrong units, unusable quality, invalid geometry and overlapping conflicting contributions are excluded. Missing energy receives no invented credit. The modeling assumption is 92.5% grid-to-battery efficiency; it is not measured battery capacity or efficiency.

A new SoC observation rebases modeled progress. Connection energy and cost retain their separate physical-session lifetime across those rebases, edited targets, pauses and restart. Native Shelly accumulated-energy deltas record C2 energy as three estimated phase allocations whose sum preserves the measured increment, using the same phase-only interval format as C1 and property. No separate total-energy series is stored. Unallocatable measured increments remain diagnostic events and explicit phase gaps; progress and cost require a complete valid phase group. Counter resets, implausible jumps and excessive source-time gaps start a new baseline without bridging invented energy. Charger 2 does not integrate power to obtain total energy and has no session-energy accumulator or recorded-energy comparison. Property and Charger 1 retain their checks of power-integrated phase energy against meter references.

An identified connection retains its last usable vehicle target and capacity
alongside its charge reference when the vehicle feed becomes unavailable. These
compact session references preserve original source clocks across restart; they
are labelled planning assumptions, not fresh vehicle observations. Feed loss
cannot combine a retained 96% charge with an 80% default target and falsely
release a pause as completed. Startup before charger observation keeps these
references dormant until the same vehicle and physical connection are established;
an unknown startup projection cannot erase the target while retaining its charge
anchor. New usable vehicle values and explicit session
edits take precedence. Disconnecting, changing the identified vehicle or replacing
the physical connection prevents reuse. Raw automatic fields still report
unavailability; configured defaults, measured energy and native current limits
retain their separate ownership. Genuinely absent references use current defaults;
invalid or retired saved progress is rejected before database mutation.

BMW's compact target-filter history also remains dormant when identity becomes
unresolved within the same physical connection, including a conflict or explicit
identification retry. It retains the original lower-target source clocks but is
not projected or applied until BMW is positively identified again with a healthy
feed. A confirmed different vehicle, disconnect, changed connection, equipment
replacement or BMW feed replacement retires that context. Retaining source
history does not resolve a genuine identity conflict or grant charging authority.

Price revisions are canonicalized by publication authority over their actual coverage. New quarter/hour slices replace the overlapped region only; negative prices, remaining older coverage and gaps remain explicit. Binary interval lookup prices physical contributions efficiently. Costs distinguish actual delivered, estimated remaining, missing/unpriced coverage and timing comparisons. The per-charger and combined timing benchmark is not proof of causal controller savings.

The **Added energy** tile shows recorded grid energy for the whole plugged-in
connection. A fresh vehicle battery reading can change the charge estimate's
reference, but does not reset this tile. The recorded total remains after charging
finishes, reaching the target, or passing ready-by; confirmed disconnection ends
it. Energy inferred only for a cost estimate is not shown as recorded energy.

Incomplete energy coverage is shown beside the charge percentage and remaining
energy. Charge may be higher, and remaining energy lower, than the estimate.
The estimate cannot establish a missed target without suitable vehicle evidence.
Existing gaps remain unknown; this warning does not fill them with assumed energy.

## Session reports

Every ordinary connection also gets a passive **Session report**, opened with
**Open ↗** in the charger card's footer. The action's status and color indicate
attention, incomplete evidence or the observed result. The report summarizes
outcome, current findings and observation coverage, followed by one **Events**
history. Filters select **All**, **Findings**, **Plans & inputs**, **Charging**,
**Control**, **Vehicle** or **Evidence**. Plan changes appear once, with the
recorded before/after changes, full planning inputs and periods inside the entry.
Proposed periods, adopted execution, identification permission, confirmed pauses
and physical charging remain distinct.

The shared assessment separates the controller's expected current allowance,
the charger's confirmed current setting, and readiness to issue an adjustment.
A short input-persistence or source-time admission hold blocks commands without
erasing still-valid observations or an allocation evaluated within the preceding
15 seconds for the same connection, request and priority. Native clocks remain
unchanged. Expired or contradictory evidence makes the affected current value
unknown; the last known allowance may remain explicitly historical with its
original calculation time. Neither that value nor a command-ready status proves
physical draw. Readiness and readback changes appear under **Evidence**; an actual
shared-model or priority change appears under **Plans & inputs**.
When neither a current allowance nor a usable current readback is being assessed,
brief input-persistence holds only refresh the current evidence. They do not add
duplicate shared events. A positively confirmed session Pause also avoids
duplicate control events caused solely by those holds. Native permission loss,
pending device commands, physical changes and evidence outages remain distinct
events. This recording choice never makes a held command ready.

Dashboard Pause confirmation belongs to its matching active pause request,
separately from economic-schedule confirmation. A confirmed Pause does not
inherit an unconfirmed schedule or a lower-priority native instruction. Actual
pending commands, uncertain outcomes and unavailable or positive measured draw
still prevent the report from confirming physical stopping.

The session selector offers recent and saved reports for that charger, loading
older sessions and events in pages. An expired or deleted selection stays
explicitly unavailable instead of opening another session. The guided-test link
opens the assessment attached to that exact report. Opening or saving a report
never identifies a vehicle, changes a schedule or sends a charger instruction.
Normal dashboard refreshes preserve open disclosures, keyboard focus and the
report's scroll position. Each event starts as a compact timestamp and title;
expand it for its explanation, planning snapshot and original evidence.
Closing a report returns to the link that opened it, including a link in Event
log. Empty Saved collections are distinct from missing session history. A failed
event read retains the loaded evidence and offers **Refresh events**; it does not
claim that no events exist. A successful report-management receipt remains valid
if the following dashboard refresh fails. Cancelling deletion returns focus to
**Delete report** without changing retained history. Destructive review initially
focuses **Cancel**. Expanded events include the year, UTC offset and original
UTC clocks, so saved reports and daylight-saving transitions remain unambiguous.
Finding names and qualified measured-draw labels are shared with Event log.
Closing the window releases its loaded event data and mounted history; reopening
fetches the current first page.
Automatic refresh loads only a bounded number of new event pages. After a large
burst or a long browser pause, **Refresh events** loads the latest page explicitly;
older records remain available through **Load older events**.

The report states whether Automatic charging is off, whether there is a proposed
or adopted controller execution plan, and whether battery inputs are measured or
assumed. Monitoring may start after connection; earlier charging is then outside
the report's coverage. A same-version restart retains the existing connection,
identity and confirmed outcomes while fresh sources reconnect. A new database
cannot reconstruct an overnight session from a stopped charger or a retained
full-battery reading.

Planning snapshots retain the planner's actual reason, bounded public warnings
and maximum-current assumptions separately from the reason a revision was
recorded. Reports show a degraded planning result when a provisional release or
modeled shortfall prevents the requested price schedule. Successful physical
start/stop checks do not turn that result into a blanket **Checks passed**.
Assumed feasible delivery remains an estimate, separate from confirmed control.

Planning snapshots list concrete changes to settings, vehicle inputs, remaining
periods and applicable prices. Removing elapsed price intervals, refreshing a
source timestamp or temporarily losing the session request does not create a
settings/price revision. Revised rates are compared over the same remaining
time intervals; newly available prices are separate from changes to existing
rates. An unchanged schedule is stated explicitly. With Automatic off and no
Charge now request, price refreshes do not create charging-plan revisions.
The history contains the initial state and meaningful changes. Opaque price
hashes, revision counters and refreshed evidence clocks do not establish a plan
change. Full inputs and periods are expandable, with concrete before/after values
shown when recorded changes establish them. An unchanged poll does not create a
new planning instruction.

Supported Shelly SYS permission incidents appear only when observed. Events retain
both native edges, the permission-transition policy, Start/ACK/source/receipt
clocks, applied current and observed model/firmware. Startup recovery entries
identify scheduled versus Charge now attempts, retry number, cancellation,
exhaustion and sustained-draw qualification. Successful reconciliation/recovery
resolves its finding without removing the incident. An ACK is not physical
recovery. The native cursor and report rows commit together to retain brief
cycles and prevent duplicate events after restart. Healthy sessions have no SYS
rows or additional empty section. Firmware metadata is observed context, never
proof of a defect or its correction. Normal retention and explicit Save apply;
workarounds never automatically save a report. Historical events remain readable
without the [compatibility policies](shelly-compatibility.md).

## Physical evidence and findings

Charger-reported charging state and measured draw remain separate evidence.
A fresh charger power reading above 0.1 kW establishes draw; status alone cannot
pass a charging or resume check in either a passive report or guided assessment.
Draw can include vehicle auxiliaries and does not prove battery energy increased.
A zero reading cannot rule out a brief pulse between samples. Initial readings
and recovery after missing evidence are observations, not invented start/stop
transitions. Events retain original measurement and receipt clocks separately
from the controller's recording time; an adapter reread cannot renew them.
Missing receipt clocks remain unknown. Contradictory recorded event labels are
qualified by their saved power evidence rather than presented as verified draw.
Brief charging/not-charging status pairs with readings at or below 0.1 kW are
shown together. Nearby repeated pairs may share one entry; actual draw, important
state changes and observation gaps interrupt grouping. A zero pair says **No draw
measured**, without claiming that no pulse could have occurred between samples.
Expand the entry for every original event, measured value and available source
clock. Unattributed saved timestamps are not presented as native measurement
times, and absent receipt times are stated only in the expanded evidence.

Automatic charging permission and charger-information availability are separate.
An **Automatic control inactive** event does not prove that information recovered,
that a stop command succeeded, or that physical draw stopped. The observer records
bounded control causes and explicit physical-evidence loss/restoration. Availability
chatter is grouped while the supporting evidence remains unavailable; a recovery
is shown only with positive evidence, never inferred from an off phase. Unknown
provider messages remain generic instead of saving arbitrary private error text.

Checks allow settling time for command/readback transitions. They distinguish
vehicle timers, supply restrictions, manual priority, unavailable telemetry and
unexplained lack of draw instead of inferring a vehicle timer from zero power.
Recovered problems remain in the timeline, and later replanning does not rewrite
earlier evidence. Requested-target attainment and native completion remain
separate; coverage says **Not exercised** where the session supplied no evidence.
A confirmed missed ready-by outcome survives a later evidence outage; changing
the requested target/deadline or positively observing recovery is assessed separately.
Closing the earlier finding because the request changed is labeled **Request
changed**, not as evidence that charging recovered.
The existing energy/session reference comparisons remain separate from these
behavioral checks; recorded energy coverage is not a reference-energy comparison.

Repeated equivalent control messages and recurring findings can be grouped for
inspection without deleting their original records. A recurring finding shows
its episode count and current state; it does not imply continuous observation
between episodes. The combined history keeps meaningful intervening events in
time order. Changed causes, actual draw, control instructions and observation gaps
must remain distinguishable. In particular, an invalid-plan error must not be
hidden inside an unrelated generic control-confirmation group. Grouping changes
presentation only; it does not alter control confirmation or manufacture recovery.

## Retention, saved reports and privacy

Completed reports expire as whole reports after **30 days** by default, measured
from the session end. `charging.report_retention_days` configures 1–3650 days.
Active sessions never expire. There is no per-session event, finding or planning
record count that discards older evidence. Events are appended to indexed database
records; dashboard summaries, runtime checkpoints and page requests stay bounded.
This retains recorded diagnostic evidence, not every raw telemetry publication.
Unchanged price intervals and shared forecast contexts are stored once per report
and referenced by its immutable events. Contexts are complete snapshots, never
chains of deltas. Bounded page reads reconstruct each event's original planning
horizon and forecast; original clocks and brief unknown/ready transitions remain
available without copying complete forecast inputs into every evidence event.
Report-owned contexts follow the report's save, expiry and deletion lifetime.
Charging runtime snapshots do not embed completed or active report bodies. A
replica reads their last committed checkpoints/summaries from the same published
database as the charging state, using the publication's original clock. Report
save failures remain visible through compact observer status; reading an older
committed report does not turn its evidence into a fresh observation.
Automatic expiry is performed by writable observer maintenance, checked hourly
and processed one report at a time when a backlog exists. Read-only browsing
does not prune the database.

Admins can **Save report** to protect it from automatic expiry, including future
events if the session is still active. **Remove from saved** returns it to the
configured retention policy and can immediately expire an old completed report.
**Delete report** explicitly removes a completed report and all its owned details,
including a saved report; active reports cannot be deleted. Family and read-only
viewers can inspect reports but cannot change retention or delete history. Saving
is protection within this database, not an independent backup. Report removal
does not delete energy observations, learning history, charger ownership or
restoration obligations. Saved reports remain historical when equipment changes;
they confer no authority over the replacement equipment.

Stores contain normalized facts and scoped hashes, not raw MQTT payloads,
coordinates, VINs or account credentials. Report storage failures remain visible
without blocking ordinary charger control or restoration. Unsupported development
formats are rejected; there is no migration or automatic database reset.
