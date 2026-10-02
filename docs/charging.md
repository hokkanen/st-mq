# Charging

ST-MQ models two physical charging points: **Charger 1 is Easee**, using either the cloud delayed-start scheduler or the native OCPP controller’s expiring current profiles; **Charger 2 is the Top AC / Shelly XT1 EVSE**, controlled through MQTT RPC. TeslaMate and BMW CarData supply vehicle evidence for either charging point. They never supply another home electricity contribution or receive vehicle commands.

Charger 1 uses one control backend at a time. Native OCPP activation releases
ST-MQ's owned cloud instruction and waits when a foreign cloud schedule still
owns charging. Cloud telemetry remains a data fallback without silently
reactivating cloud scheduling. Native `plug-and-charge` authorization can start
a connected vehicle without an RFID tap; RFID mode instead requires permitted
tags. Native economic pauses expire on the charger and release to its existing
charger/vehicle/Equalizer limits. Extra identification charging during an economic
delay uses normal charging current, with a controller-managed energy allowance
and safety deadline. See
[local setup and native control](charging-easee.md#direct-local-ocpp-telemetry-firmware-344-or-later).

**Native OCPP needs ST-MQ for charging authorization.** Normal Ctrl+C or service
stop requests a return to cloud control; paired handover keeps OCPP active. A
failed cloud request leaves handback unconfirmed. A crash or power loss can leave
new charging or Easee app Start waiting for approval. Restart ST-MQ or disable
Direct OCPP through Easee configuration. Expiring economic pauses do not provide
automatic cloud authorization after a crash.

Charger 2 is disabled by default. Once its MQTT device identity and topic are
configured, supported start/stop readiness is checked automatically. Native app
changes retain priority; optional current limiting has separate installation and
capability requirements. See [provider capabilities and setup](charging-provider-capabilities.md).

## Dashboard and requests

Both charger cards show the physical connection, assigned vehicle or uncertainty, current request, measured/estimated progress, connection cost and control state. The Automatic charging switch governs economic scheduling. Vehicle identification and metering continue with automatic charging OFF. The separately configured Charger 2 limiter can remain active with economic scheduling OFF.

A live local OCPP connection status newer than the last disconnect restores
Charger 1's physical session and readings even while its transaction is
unconfirmed. Native scheduling still waits for a confirmed transaction newer
than that disconnect. Transaction confirmation does not restart the physical
session or reset its settings, deadline, progress or cost.

Each card’s **How charging works** section explains its scheduling, current
limits and pause recovery. Easee cloud delays and local OCPP pauses can release
on the charger without a new command; Shelly pauses need a live application
command to resume. Local OCPP pause expiry does not authorize a new charging
session or restore cloud control. The Identification section keeps the current
test status and any outstanding recovery or review action.

An open charging period can show **Charging is allowed** while the connected
vehicle draws no power. A later planned period does not mean the current one
has paused. **Paused between periods** requires the controller to confirm the
pause; a pending transition is shown as unconfirmed, with the next planned
period kept separate from that confirmation. **Reported allowance** is the
Equalizer's current allowance, not actual draw or proof that a scheduling pause
has taken effect. Vehicle timers, limits and other native restrictions still
apply during an open period.

Permanent defaults come only from configuration. Both unidentified charging
points start with 20% charge, an 80% minimum, 06:00 ready-by and 74 kWh capacity
from `charging.defaults`. Identified vehicles apply their sparse
`charging.vehicles.<vehicle>.defaults`: BMW 74 kWh and Tesla 57 kWh initially,
with other values inherited from the shared defaults. These usable capacities
are assumptions, not measurements. Automatic charging starts OFF and shared
priority starts Balanced on a fresh installation. Change both in the dashboard;
these choices survive restart and unplugging for the same equipment. They are
stored separately from configuration and session requests. A changed charger
identity does not inherit automatic-control permission; shared priority resets
when either physical charger changes.

**Save for this session** changes only the current physical connection. The
server requires the current physical association, session ID and request revision, rejecting a stale browser
tab or cable swap. Overrides survive restart only within that same connection;
unplugging returns to configuration defaults. Editing a field does not erase the
live source reading beside it. Draft edits survive ordinary status refreshes.
Change permanent defaults in configuration and choose **Apply reviewed configuration**.

Enter ready-by time as **HH:mm**, or use **Choose time** and **Set**. The time
chooser stays within the window and scrolls when space is limited. Set updates
the draft; **Save for this session** applies it to the current connection.

**Charge now** is immediately visible at the top right of each charger card.
It releases the controller's automatic scheduling delay for the current session
without changing the Automatic charging choice. It works with Automatic
charging OFF. The button has an explicit **ON/OFF** indicator with a sliding knob
and stays highlighted while ON; click **Charge now** again to turn the override
OFF and use automatic charging (enabling it if it was OFF). ON means immediate
charging is requested; the card's activity line reports whether the vehicle is
actually charging, waiting or blocked.
The card keeps its height while saving and after either action, without an extra
confirmation message. Unplugging also ends the override. **Use automatic** remains
in Details & settings when an external charger instruction has manual priority.
Native vehicle timers, targets, user stops, faults, charger limits and authorization
still apply, and unavailable or unsupported hardware cannot be started through
this action.

A manual SoC is a one-time anchor. A newer applicable vehicle reading supersedes it using the provider's source clock, or explicitly labeled receipt time when no measurement clock exists. A pinned capacity outranks the provider capacity. An explicit requested minimum remains distinct from the vehicle's actual ceiling; requesting 95% while the vehicle reports an 80% ceiling is constrained rather than silently rewritten. Vehicle current limits and native not-before times constrain either charging point.

### Schedules inside the vehicle

[TeslaMate MQTT](https://docs.teslamate.org/docs/integrations/mqtt/) exposes
`scheduled_charging_start_time`. ST-MQ uses that next start when selecting the
cheapest feasible charging periods. Unchanged settings keep their original
receipt/provenance while live TeslaMate health establishes feed availability.
This is not a complete weekly schedule: the standard MQTT feed does not expose
all recurrence rules and end times. An absent start does not prove that every
vehicle-side restriction is disabled.

BMW CarData offers charging-profile/window information subject to vehicle
capabilities, but the current [BMW bridge](bmw-cardata.md) forwards battery and
identity facts only. It does **not** currently supply BMW charging windows to
the planner. A window-selection flag without actual times, timezone and mode
cannot safely identify available charging periods. BMW schedule-aware readiness
therefore remains unsupported until the applicable profile is mapped; do not
interpret the forecast as confirmation that a BMW timer allows it.

If a known vehicle start is after ready-by, ST-MQ reports the shortfall and
releases its economic hold so the vehicle can start when it allows. The other
charger keeps its own plan. If published prices do not cover any eligible time,
the provisional fallback also permits charging. ST-MQ cannot override a vehicle
timer, target or user stop. The final period always remains an open release.

### Missing vehicle feeds and takeover

Charging does not require vehicle identification: editable starting charge,
target, usable capacity and ready-by remain available. Within the same identified
physical connection, feed loss preserves the last charge anchor plus recorded
energy, labeled as last known vehicle charge. An explicit starting-charge edit
replaces it. A new or ambiguous connection cannot borrow that estimate.

The BMW publisher sends a live report every five minutes. Ten minutes without
a valid live report withdraws its automatic values even if the broker remains
connected; source measurement clocks do not advance with these reports. Retained
replay alone does not restore live-feed availability. TeslaMate uses its separate
live logger-health reports. Physical charger metering remains independent.

After a master-host failure, the promoted computer needs its own working broker,
device connections and credentials; see [paired operation](pairing.md). Cached
data is not fresh device evidence. Reachable chargers can continue with manual
inputs, and missing prices or supply forecasts select provisional release.
An unreachable charger cannot receive a release, and an unavailable OCPP
authorization server can block new charging. Shelly EVSE controller-loss behavior
remains unverified; software cannot promise an autonomous hardware fallback.

The ready-by time becomes one concrete occurrence when the physical connection starts. Midnight, identification, progress updates, priority changes and restart do not roll it forward. A deliberate session ready-by edit may change it. Late identification replaces default-derived vehicle inputs without splitting the physical session or resetting its costs.

## Setup, guided physical tests and session reports

**Data & settings → Connections & configuration → Charging**, above Floor
preheating, explains physical charger setup and the independent BMW/Tesla feeds.
The BMW guide lists the exact CarData descriptors and the Home Assistant/MQTT
mapping requirements. Both vehicle guides show accepted fields with their
original source or receipt clocks. Feed health, identification and charger
control readiness remain separate capabilities; opening the guide sends no commands.

Each vehicle has a **Guided test** button. Selecting a vehicle loads its
available battery percentage and charge target independently of charger selection.
Usable battery capacity comes from a reported vehicle value when available,
otherwise that vehicle's configured default. All three values remain editable;
the user verifies them before arming. Numeric values retain source precision,
including decimal usable capacity such as 72.43 kWh. Manual values need valid
ranges and sufficient charging headroom; they need not equal the vehicle feed.
Invalid preparation identifies the field or prerequisite that needs attention.
Source clocks and unavailable fields stay
visible. Reloading explicitly offers new readings without silently replacing
manual edits. This reads the existing feed; it does not wake or query the car.
BMW may report usable capacity; the current Tesla feed uses configured capacity.

The guide has one target: the charge target set in the car. The guide and normal
charging algorithm obtain it independently. A manually supplied value means the
user has checked or set that target in the car; it is not a separate test goal. **Every guided-test input is
assessment-only:** selected vehicle, battery percentage, target, usable capacity
and recorded schedules. They are used only for test preparation estimates,
recommendations about user-operated vehicle timers and assessment of independently
observed behavior. They never enter production charging settings, planning inputs,
vehicle identity evidence, telemetry, charger commands or configuration defaults.
The normal algorithm continues using its own configuration, ordinary session
controls and independently acquired vehicle/charger evidence. This separation
applies equally to values loaded from vehicle telemetry and values typed by the
user; confirming a copied reading does not grant it new production authority.

Preparation expires after 24 hours if no connection starts. Assessment assumptions
survive a current-version restart and remain associated with the exact test and
physical connection. If the independently reported vehicle target disagrees with
the assumed target, the guide shows the source, time and discrepancy. The user can
check the actual setting in the car and record that verified target, including
a value that differs from unreliable telemetry. This changes only the assessment,
never the normal session target or the car. Verification acknowledges the exact
reported value and source shown to the user. Repeated reports of that same value,
including BMW alternating between 100% and the verified target, do not repeatedly
require confirmation. A new conflicting value or source needs review; changing
the accepted target clears earlier discrepancy verifications. Verification stays
with this assessment and survives a current-version restart.
If another window saves a newer target while an edit is open, the guide keeps
the draft visible and requires loading the latest saved target before confirming.
It cannot silently overwrite the newer verification.

The conflicting report and its original clock remain visible after verification;
manual confirmation never becomes telemetry or proof of charging. Until a conflict
has been reviewed, it blocks target/completion success. After explicit verification,
completion still requires independently observed charging, a fresh vehicle battery
reading at the verified target, and a fresh physical stop. Historical findings
remain separate from current discrepancy and verification status.
The guide does not ask the user to enter a second controller target or silently
force the production plan to agree with its assumptions.

Prepare and arm while unplugged, with live charger and vehicle feeds, available
control, Automatic charging enabled and no conflicting charger timer or manual
Stop. Battery headroom uses the verified usable capacity, battery percentage,
vehicle target, efficiency and expected charging power: aim for at least 30 minutes
of active charging for the normal program and 60 minutes for the delayed program.
These are test-design estimates, not measured capacity or fixed percentage limits.
A naturally suitable later session is preferable to charging to 100% or
deliberately discharging for a test.

- **Normal charging:** allow immediate charging in the vehicle, arm, then plug
  into the selected charger. Observe independent identification, normal economic
  planning, charger execution and physical completion.
- **Delayed vehicle schedule:** first set a future start in the car that prevents
  immediate charging and record it before arming. Use the ordinary application
  time field with its integrated picker; typing is also supported. The resolved
  day and installation timezone are shown beside it.
  After plug-in, the guide evaluates candidate vehicle timer settings against the
  actual production periods. If the real plan cannot accommodate the assumed
  target, the guide reports that limitation without modifying the plan. It prefers
  useful delayed-start and intermediate pause/resume coverage while checking
  opportunity to reach the vehicle target. The original timer, latest confirmed
  timer and recommendation are shown separately.
  Set a suitable timer in the car, then record it in the guide using the button
  or Enter. This records what the user did; it sends no vehicle command.

Confirmed adjustments and their timestamps are retained independently of
recommendations. Reopening, refreshing or restarting restores the latest recorded
time. Polling preserves unsaved edits, and a newer recommendation never overwrites
a confirmed time. The guide does not insert, move or replace production periods
or change ready-by. Later adjustments can use independently acquired remaining
energy from the normal session when its target, capacity, scope and evidence
agree; otherwise the guide uses its conservative preparation assumptions.
Insufficient charging opportunity remains explicit.

The suggestion estimates test coverage; it is not proof of the cheapest possible
schedule or a guarantee of completion. The normal scheduler continues choosing
the cheapest feasible periods using available evidence. A vehicle timer prevents
immediate charging, but does not guarantee delayed identification. Early
identification and an unchanged plan after identification can both be valid.
BMW vehicle windows remain unavailable to the planner; Tesla's reported next
start is not a complete weekly schedule. A suitable Tesla timer already reflected
in the real plan can be kept without repeatedly requesting a later adjustment.
No telemetry is suppressed to force a case.

Assessments run on the server and survive a closed window or browser. Leave the
car connected until charging completion is confirmed, then unplug; no separate
End action is required. An earlier unplug also closes the assessment cleanly,
retaining incomplete coverage rather than claiming success or following the next
vehicle. Completion needs observed charging, fresh vehicle evidence reaching the
accepted target and fresh physical stop evidence; silence or zero power alone is
insufficient. **Stop assessment early** stops observation while ordinary charging
continues. Restore or remove a temporary timer in the car yourself. Up to 24
assessments are retained, with active runs preserved. The current assessment state
is version 2; unsupported development formats are rejected without migration.

The BMW/Charger 1 and Tesla/Charger 2 guides can run separately or together.
Each keeps its own connection, vehicle evidence and completion result. Its shared
assessment also observes the other charger, whether or not that charger has a
guide running. It records measured overlapping draw, the selected shared priority
and changes made during ordinary use. The guide never changes priority or asks
for a priority-switching exercise. An absent overlap remains unexercised; missing
or stale peer evidence remains unknown.
Priority propagation and current changes have a two-minute settling allowance
before a persistent mismatch becomes a finding. Brief recalculation or readback
delays remain visible without leaving a false failure in the guide.

Shared assessment separates proposed schedules, adopted charger execution and
measured draw. It independently recounts the joint allocation's available energy
and electrical constraints, and shows the planner's combined cost and reported
lower/gap bounds where available. These are model checks, not proof of delivered
energy or exact global optimality. Delayed vehicle-timer recommendations integrate
the selected charger's exact allocation slices, including gaps assigned to its
peer. Missing allocation evidence cannot be replaced with peak charging power.
Shared evidence survives a same-version restart and stays bound to each physical
connection. Existing version-2 assessments and session reports without this new
optional evidence retain unknown shared coverage until independently observed;
their earlier findings and outcomes are unchanged. Malformed shared evidence is
rejected, and no prior allocation history is invented.

Every ordinary connection also gets a passive **Session report**, in its own row
below **Details & settings** on its charger card. The action's text and color indicate
attention, incomplete evidence or the observed result. The report summarizes
outcome, current findings and observation coverage, followed by one **Events**
history. Filters select **All**, **Findings**, **Plans & inputs**, **Charging**,
**Control**, **Vehicle** or **Evidence**. Plan changes appear once, with the
recorded before/after changes, full planning inputs and periods inside the entry.
Proposed periods, adopted execution, identification permission, confirmed pauses
and physical charging remain distinct.

The session selector offers recent and saved reports for that charger, loading
older sessions and events in pages. An expired or deleted selection stays
explicitly unavailable instead of opening another session. The guided-test link
opens the assessment attached to that exact report. Opening or saving a report
never identifies a vehicle, changes a schedule or sends a charger instruction.
Normal dashboard refreshes preserve open disclosures, keyboard focus and the
report's scroll position. Each event starts as a compact timestamp and title;
expand it for its explanation, planning snapshot and original evidence.
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

Completed reports expire as whole reports after **30 days** by default, measured
from the session end. `charging.report_retention_days` configures 1–3650 days.
Active sessions never expire. There is no per-session event, finding or planning
record count that discards older evidence. Events are appended to indexed database
records; dashboard summaries, runtime checkpoints and page requests stay bounded.
This retains recorded diagnostic evidence, not every raw telemetry publication.
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

## Vehicle assignment

The observer evaluates both charging points together, including while automatic charging is OFF and hours after connection. Assignment requires positive corroboration: applicable vehicle home/plug/start evidence and physical charging behavior. Similar powers on two charging points can remain ambiguous. A negative Tesla match never identifies BMW or the other charger by elimination.

Assignments carry the physical association, plug epoch and vehicle-feed identity. Changing the configured Tesla car, broker, topic namespace or home-zone configuration cannot lend a replacement source’s readings to a saved match. Genuine disconnect/reconnect events are retained even between planner ticks or MQTT subscription admission and invalidate the old scope. Pause/resume within a connected work state remains one session. Explicit conflicting evidence withdraws certainty. A remembered identity alone cannot authorize a new connection, and current vehicle fields are withdrawn when the upstream feed is unhealthy.

TeslaMate has transport, subscription, live logger-health and per-field evidence
checks. Sleeping while healthy is distinct from unhealthy. A reconnect requires
a new live healthy pulse. TeslaMate publishes most values only when they change;
its held fields keep their original receipt times and retained provenance while
logger health establishes whether they are currently usable. Fresh physical
charging takes precedence over a reported future timer. Retained or last-known
values alone cannot identify a car. A live charging-state start whose receipt
matches the physical start within 30 seconds can corroborate matching reported
power throughout that physical connection; elapsed time does not expire that
historical correlation. Identification still requires current healthy, plugged,
home and charging context plus fresh positive local power agreeing with the
Tesla report. Retained starts and power cannot supply the match. Repeated
identical publications and same-value recovery after an unknown gap preserve
their original provenance; consumed power cannot identify another connection.
TeslaMate's receipt clock cannot place a report delivered late at an earlier
physical event. The saved correlation must already agree at the original
receipt time. Held home and target fields remain context; identification does
not require a new GPS observation simply because the car has stayed home.
BMW source timestamps, home scope and consumed plug/start events serve the same
connection separation. Neither feed's remote voltage or power fills missing
household electrical measurements.

Easee cloud scheduling, local OCPP and the supported Shelly EVSE use the same
vehicle matcher, pending status, consumed-evidence checks and session boundaries.
Their adapters normalize ownership and physical pause evidence before it reaches
identification. A schedule, RPC reply or OCPP acknowledgement alone cannot identify
BMW. Independent BMW start and stop transitions must match the corresponding
charger episode. A fresh plug event permits the bounded connection-observation
tolerance; with an unchanged inlet report, both observed starts must be inside
the known physical connection, with no preconnection tolerance. A natural stop
or the end of a bounded charging probe can supply the second edge.
An ongoing BMW baseline without its original start edge instead requires a
verified controlled pause. Unknown charger state never counts as a stop.

Identification remains pending for the physical connection independently of
economic scheduling and any bounded charging test. BMW and Tesla use this same
lifecycle, energy allowance, control permissions, restart behavior and return to
the current charging choice. The matchers differ according to the available
evidence: TeslaMate supplies live power and receipt-timed transitions, while BMW
supplies source-timestamped charging events that can arrive later. BMW's need for
a corresponding stop does not force an unnecessary pause after a conclusive
Tesla power match; Tesla's live-field checks do not impose a short lifetime on
BMW's historical events.
Easee cloud, local OCPP and Shelly EVSE support one automatic active attempt per
physical connection, including when Automatic charging is OFF or Charge now is selected.
An already confirmed passive match skips the test. Otherwise, live charger
readiness and plausible at-home vehicle context allow one bounded charging
test using the charger's normal current settings.
Probe readiness can use a healthy, at-home vehicle whose last valid unplugged
report predates the actual physical connection: BMW uses the report's source
timestamp, TeslaMate its original receipt timestamp. That old negative report
does not block gathering new evidence. A negative report from this connection,
an unknown or malformed clock, an away location or an unhealthy feed still blocks
the test. This changes readiness only; identification still requires the vehicle's
own positive context and corresponding charging evidence.
Native electrical limits, faults,
authorization, vehicle timers and manual Stop retain priority. Pending
identification has no ten-minute label expiry: a vehicle timer or full battery
can leave it waiting until charging starts. Missing vehicle context leaves it
pending without repeatedly starting a test.

BMW location can become unknown when GPS is unavailable or its coordinate
updates have different source times. The latest valid home observation supports
identification without an age limit, including across restart and unplug/replug.
Unknown GPS preserves this context and its original timestamp. A valid away
report or replacement of the configured vehicle feed invalidates it. The current
location remains explicitly unknown during a GPS gap; a remembered home report
does not identify a vehicle or carry a charger assignment to another connection.
Vehicle and physical charger correlations are still required for each connection.
The charger details show the remembered home observation separately. See
[BMW location context](bmw-cardata.md#home-location). Missing context before a
test leaves its budget unused; loss during an active test never renews its limits.

When normal charging is permitted, it proceeds under native current limits;
waiting for either vehicle has no short charging timeout or identification energy budget.
A fresh Tesla power match can finish immediately. A usable BMW charging baseline
can trigger one brief, confirmed pause while the same connection is charging.
Startup can use live ongoing BMW charging without inventing a
missing historical start edge. Matching charger and vehicle stop evidence is
still required; an accepted pause command alone is insufficient. Active tests
are serialized across charging points. Shelly requires available start/stop control,
fresh physical readings and available MQTT, and retains native restrictions
and its optional electrical limiter when enabled throughout the test.

When the charging plan is delaying charge, the extra test temporarily permits
charging under the existing charger, vehicle and local load-balancing limits.
Identification does not select a lower positive current. OCPP continues to use
its established zero-current pause and release commands; Shelly retains native current settings and its
optional electrical limiter when enabled. A conclusive vehicle match ends the extra test immediately and
returns to the current charging choice. A usable BMW baseline triggers its
correlation pause; absent a match, the shared 0.15 kWh extra-energy allowance
ends probing for either vehicle.
An independent five-minute maximum and loss of current power evidence also end
probing. These limits do not expire the saved identification evidence. Metering
and actuator delay require conservative stopping allowance; a software limit is
not a guarantee of an exact physical energy cutoff. Native electrical limits and
Equalizer authority remain in effect. The controller monitors energy and its
persisted absolute deadline, then reinstates the economic pause. The practical
deadline is usually much shorter than five minutes: it uses the reported hardware
current ceiling, or the adapter's conservative maximum, across three phases at
at least 253 V and reserves ten seconds for stopping. This calculation does not
set charging current or claim that actual draw reaches the ceiling. These guards
require the running controller and working charger communication; an outage can
extend extra charging. No positive-current OCPP profile or autonomous probe cutoff
is installed. Restart or telemetry loss cannot renew the recorded allowance.
A brief identification pause during ordinary charging has a deadline
90 seconds later, rounded up to the next whole second. Easee cloud and OCPP
enforce that expiry at the charger. Shelly's pause uses its start permission and
is released by the application; its outage behavior is described below. A
physically confirmed stop ends the temporary pause immediately and applies the
current charging choice, without waiting for BMW delivery. During an economic
delay, that choice is the scheduled pause. The zero-current OCPP restriction that
ends an extra probe can therefore last until the planned economic release; it
does not expire after the ordinary 90-second identification pause.
Probe limits leave **Identification pending**
while normal control uses session/default battery inputs. Source-timestamped BMW
start/stop evidence can confirm the same connection until unplugging, including
after a long charging run or delayed and reordered delivery. Matching still
requires corresponding episodes and tightly correlated physical transitions;
newer current state is never rolled backward by historical evidence. Tests never
repeat automatically for that connection. Normal scheduled charging can supply
additional evidence after the probe budget is exhausted.

The attempt, consumed budget, absolute deadlines and physical evidence survive a current-version
restart. A known connection resumes its pending attempt or completed outcome;
restart does not renew its budget. An already connected charger with no saved
connection starts one attempt when fresh readings permit it. Unplugging cancels
the attempt and clears its scope. Easee native pause expiry prevents a stopped
process from leaving an identification-only pause indefinitely.

Shelly has no charger-side expiry for this test. The controller saves its pause
and restoration obligation before sending the stop. If the application or MQTT
connection fails, the temporary stop can last beyond the 90–91 second deadline.
On recovery, fresh native readings must confirm the same equipment and physical
connection before the controller resolves its saved command and returns to the
current charging choice. An unconfirmed stop that cannot be distinguished from
a manual instruction stays uncertain until explicitly resumed. Restarting does not create another attempt or extend
the test deadline. An explicit manual Stop, an active native schedule or an
electrical restriction still prevents starting; an old identification pause
cannot authorize starting a different connection.

Each card places **Charging controls** below **Session settings**, with
**Identify** at the end of the controls. It requests another attempt for the
current connection, even if a vehicle is already identified. The confirmed
association remains visible during that check. The button is disabled when
identification is unavailable, already pending/in progress, or the viewer has no
control authority. It uses the current charger association, session ID and
request revision; an old screen cannot test a replacement connection. Admin and
family users may both use it. Waiting, active testing and an inconclusive outcome
remain separate visible states, independently of the Automatic charging switch.

## Planning and Equalizer

The global priority setting is **balanced**, **Charger 1**, or **Charger 2**. It belongs to the physical charging point and immediately revises allocation when changed. The revision invalidates queued intentions without resetting session requests, manual instructions, metered energy or cost.

A request edit, Automatic change or Charge now action can also revise the other
charger's schedule. Both affected controllers discard outdated pending commands
and reconcile the new joint result. Confirmed native execution remains separate
from a proposed replacement until readback establishes the change. An arriving
price forecast can establish the first automatic program after connection.

Change priority in either charger's details. Both entries edit the same saved
choice, which survives restart and new vehicle connections for the same physical
chargers. Automatic charging is also a persistent dashboard choice; the four
ready-by and battery defaults remain configuration-owned.

The planner first respects device/vehicle limits, manual permission, native start times and credible capacity. It protects both deadlines where the modeled opportunities allow that. Actual all-in electricity cost then governs period selection. Priority must not buy more expensive energy merely to favor a charger. In infeasible cases, charger priority favors its remaining request; balanced mode shares normalized shortfall. Eligible charging time and grid-energy need determine pressure. Shared budgets below two minimum currents use bounded time slices rather than invalid sub-minimum simultaneous commands.

The implementation is a bounded search over a declared slot/current model, **not a globally exact continuous-time optimizer**. Results expose the search kind, relaxed cost lower bound, feasible candidate cost and upper bound on the cost gap where available. Search pruning can miss a better joint candidate; reported feasibility is conditional on the recorded assumptions. Synthetic exhaustive small-horizon comparisons validate representative cases. There is no one-cent pause penalty or mandatory one-cent saving hurdle. Practical minimum economic runs/gaps remain 15 minutes; equal-cost choices prefer stability.

Running-session readiness and price-driven interruption decisions reassess both
adopted executions together with the selected priority. A cheaper replacement
must preserve modeled feasibility and reduce combined cost. A final open release
retains its charging permission while remaining part of shared current allocation;
it does not reserve the charger's entire current ceiling against its peer.
Independently observed native/manual activity is likewise accounted for without
granting the economic scheduler new permission to change that activity.
Charger 2's prospective current command uses Charger 1's confirmed permission,
so an unconfirmed replacement cannot manufacture spare capacity.
Below the capacity needed to run both cars, balanced sharing retains an existing
allocation for at most its current 15-minute slice. Accepted session progress
keeps repeated replanning from continually favoring the same car; changed limits,
native permission or a deadline that can still be met override that hold. A car
that has met its requested minimum receives residual adjustable capacity after
outstanding requests, while its final charging permission remains open.
Shelly records the program currently accepted by its controller, including
intermediate pauses. Its future transitions still require the application;
this execution record does not represent a device-local timer.

Planned charging power and duration use the latest published smoothed voltage
estimate for each physical phase. The same estimates convert future household
power into current. These are six-hour-half-life estimates, established after one
hour of valid elapsed acquisition coverage and recorded adaptively with a 0.5 V
minimum change floor. The planner reads recorded values, not small internal
smoothing updates. Each phase prefers Charger 1 OCPP, Charger 1 Easee Cloud, then
Equalizer Easee Cloud. Charger 2 cannot supply shared estimates or provisional
startup voltage because its phase order is not verified against these sources.
Shared smoothing retains compact
contributing-source provenance across feed changes, with stable source recovery.
Valid live local voltage may serve provisionally before an
estimate exists; remote vehicle voltage and nominal defaults cannot supply
missing household evidence. A saved estimate after restart is historical context,
not proof of a fresh live electrical measurement. See
[voltage recording and historical interpretation](recording.md#smoothed-phase-voltage).

Household energy history retains per-phase power for forecast scenarios and
converts it with the present planning voltage. Historical chart conversions still
use the voltage estimates applicable at the original time. Original imported
current readings keep their measured-current meaning. When an
imported calculation needs voltage before estimate history begins, it uses the
first fully established per-phase database estimates as labelled retrospective
assumptions. Later voltage changes cannot rewrite that early-CSV basis. Measured
energy, charging progress and billed interval energy never depend on those
retrospective voltage assumptions.

For unchanged charging intent, a proposed adjustment of up to two minutes to
future waiting-period boundaries may retain the existing periods. The planner
rechecks both chargers together under the new forecasts: every deadline must
remain feasible, and neither the combined estimate nor either charger's cost may
exceed the new candidate by more than 0.1 cent. The period count must agree.
Changed prices, priorities, requests, connection, observed battery charge,
capacity, targets or current limits bypass this retention. Delivered-energy
progress is rechecked in the joint simulation without treating every small meter
increment as new intent. Running periods and starts within the next two minutes
are not retained by this rule. The retained schedule is the actual plan, so session
diagnostics do not log discarded candidate movements as schedule changes.

Live property and charger currents still govern actual draw, immediate phase
headroom and the commissioned limiter. Live voltage remains appropriate for
current electrical readings and integration paths that genuinely require it.
Neither smoothing nor schedule stability can relax native limits, telemetry
freshness, control authority, changed session requests or a missed deadline.

Easee's Equalizer, charger and vehicle determine the available charging current. Native OCPP economic pauses impose an expiring 0 A restriction; identification probes briefly release the owned pause at normal current before returning to that economic pause or normal charging. This never raises native limits or changes circuit protection or fuse settings. Current already drawn by an automatic-OFF, manually running or post-target peer remains a load until physical evidence says otherwise. Forecast household load, gross configured capacity and current net allowance are distinct. A clipped zero Equalizer allowance does not establish an exact gross budget. Missing rates or capacity produce provisional decisions, not free electricity or invented assured readiness.

The final period is an open release. Reaching the planning minimum or ready-by deadline does not issue a final stop. Extra actual energy remains metered and priced. Unknown future post-target consumption cannot have a guaranteed optimized bill. Later economic pauses require ST-MQ and the provider to be available; the UI distinguishes the proposed plan, dispatched request, readback and observed physical response.

## Charger 2 current allocation

Basic start/stop leaves native current settings and native load balancing in
charge. The planner reserves the reported native current, and scheduling sends
Boolean start/stop only. The allocation below applies with `limiterEnabled:true`;
missing current-control capabilities block that mode rather than bypass it.

Commissioning must verify three-phase association, phase order, installation fuse ratings and whether the property and charging-current magnitudes support the additive model. For each phase, the modeled non-EV base is `B = property − Easee − Shelly`. The absolute Shelly ceiling is the tightest `fuse − margin − B`, then any planned Easee reservation and hardware, vehicle and native user limits. The calculation includes Shelly's existing draw; it does not mistake incremental spare margin for an absolute setpoint.

Shelly priority excludes Easee's present draw from this fuse test. A temporary property total above the fuse while non-Easee load fits does not cause ST-MQ to fight Equalizer by reducing Shelly. An explicit secondary-deadline reservation can still reduce Shelly and is labeled separately. Equalizer response and actual installation protection are not guaranteed by this model.

A common current is rounded down to the verified step. The integration supports a reported 6 A minimum and 1 A step; missing or different quantization makes optional current control unavailable. Values below the verified minimum cause an EVSE pause, not an invalid current RPC. Decreases act promptly. Increases ramp by the configured step budget after dwell; resumption also requires dwell and permission. Native lower current choices, start/stop, energy/time caps, faults and schedules retain authority. Enabled native schedules conservatively own start/stop until disabled/removed; ST-MQ does not guess their cron window or rewrite them. Current limiting remains separate.

Coherent current inputs default to a 15-second age and 5-second skew bound, with 1 A per-phase margin. Unknown, stale, misaligned or non-additive inputs select the owner's configured fallback ceiling, initially **12 A**. Known tighter limits still apply. Fallback does not start a stopped vehicle or bypass its native timer. It is not guaranteed fuse protection.

If the process, broker or charger is unavailable, ST-MQ cannot apply a new fallback. **Autonomous controller-loss behavior is unverified.** There is no invented watchdog, command TTL or broker-will guarantee. Actual last-setpoint, reboot and outage behavior must be established with the arrived hardware before unattended deployment. The status reports this separately from a successfully requested telemetry-loss fallback.

## Charge progress and cost

Physical electricity sources are always Easee for C1 and Shelly EVSE for C2, regardless of vehicle identity. Progress uses accepted interval kWh plus the recorder's admissible pending tail. Wrong units, unusable quality, invalid geometry and overlapping conflicting contributions are excluded. Missing energy receives no invented credit. The modeling assumption is 92.5% grid-to-battery efficiency; it is not measured battery capacity or efficiency.

A new SoC observation rebases modeled progress. Connection energy and cost retain their separate physical-session lifetime across those rebases, edited targets, pauses and restart. Native Shelly accumulated-energy deltas record C2 energy as three estimated phase allocations whose sum preserves the measured increment, using the same phase-only interval format as C1 and property. No separate total-energy series is stored. Unallocatable measured increments remain diagnostic events and explicit phase gaps; progress and cost require a complete valid phase group. Counter resets, implausible jumps and excessive source-time gaps start a new baseline without bridging invented energy. Charger 2 does not integrate power to obtain total energy and has no session-energy accumulator or recorded-energy comparison. Property and Charger 1 retain their checks of power-integrated phase energy against meter references.

Price revisions are canonicalized by publication authority over their actual coverage. New quarter/hour slices replace the overlapped region only; negative prices, remaining older coverage and gaps remain explicit. Binary interval lookup prices physical contributions efficiently. Costs distinguish actual delivered, estimated remaining, missing/unpriced coverage and timing comparisons. The per-charger and combined timing benchmark is not proof of causal controller savings.

## Restart and compatibility

Current-format sessions, requests, assignments, costs and uncertain commands recover only within the same physical/source association. Device, MQTT broker/root, integration profile/service or phase association changes cannot borrow old ownership. A potentially dispatched command is reconciled with native readback before another intention; it is never blindly replayed.

Pre-1.0 native state is not migrated. The current charging state remains version 6
and database schema 18; the physical adapter uses its own explicitly scoped
current state. New optional control choices default to OFF/Balanced when absent;
recorded presentation never supplies control permission. Retired configuration switches for automatic charging and
priority, dashboard overrides of permanent battery defaults, old pseudo-C2
settings, charger-bound vehicle topics, efficiency overrides, unscoped verdicts
and aliases are rejected. No database reset or data migration is needed for the
new control choices. Only the v0.7.5 `easee.csv` and
`st-mq.csv` import paths are supported historical boundaries. Imported
C1/property history retains its provenance and does not become a Shelly observation.

The **Added energy** tile shows recorded grid energy for the whole plugged-in
connection. A fresh vehicle battery reading can change the charge estimate's
reference, but does not reset this tile. The recorded total remains after charging
finishes, reaching the target, or passing ready-by; confirmed disconnection ends
it. Energy inferred only for a cost estimate is not shown as recorded energy.
