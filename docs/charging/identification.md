# Vehicle identification

[Charging overview](../charging.md) · [Code map](architecture.md)

This contract owns positive vehicle matching, bounded identification attempts and their restoration. Vehicle-feed setup belongs in the [BMW](integrations/bmw.md) and [TeslaMate](integrations/teslamate.md) guides. Identification does not replace [control authority](execution-and-recovery.md).

## Vehicle assignment

The observer evaluates both charging points together, including while automatic charging is OFF and hours after connection. Assignment requires positive corroboration: applicable vehicle home/plug/start evidence and physical charging behavior. Similar powers or currents on two charging points can remain ambiguous. A negative Tesla match never identifies BMW or the other charger by elimination.

Assignments carry the physical association, plug epoch and vehicle-feed identity. Changing the configured Tesla car, broker, topic namespace or home-zone configuration cannot lend a replacement source’s readings to a saved match. Genuine disconnect/reconnect events are retained even between planner ticks or MQTT subscription admission and invalidate the old scope. Pause/resume within a connected work state remains one session. Explicit conflicting evidence withdraws certainty. A remembered identity alone cannot authorize a new connection, and current vehicle fields are withdrawn when the upstream feed is unhealthy.

A conclusive unique Tesla current test can replace an older mistaken assignment
and clear the corresponding saved conflict. The displaced connection resumes
observation for independent BMW evidence without renewing its test budget. Fresh
evidence supporting competing assignments remains ambiguous; provider silence
alone cannot correct an assignment.

## Tesla evidence

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
Tesla report. This power/start correlation identifies Tesla only when every
other observed charging point is confirmed disconnected. Two connected cars
require the unique current comparison below; similar starts and powers cannot
identify one prematurely. Retained starts and power cannot supply the match.
Repeated identical publications and same-value recovery after an unknown gap preserve
their original provenance; consumed power cannot identify another connection.
TeslaMate's receipt clock cannot place a report delivered late at an earlier
physical event. The saved correlation must already agree at the original
receipt time. Held home and target fields remain context; identification does
not require a new GPS observation simply because the car has stayed home.
TeslaMate can suppress an unknown plug value while continuing to publish charging
state and actual draw, leaving an older retained `plugged_in=false` in place.
The raw plug report and its provenance remain unchanged. Independently received
live charging state, positive actual current and positive power after that report
can establish explicitly labelled **connection inferred from live charging**
context while the logger is healthy and the vehicle is home. This context alone
does not identify a charger: the same physical and session-specific matching
checks still apply. Held values preserve their original clocks; retained-only
draw, later unplug/disconnected/driving evidence, or an unhealthy feed cannot
supply this inference. A normal charging pause is not a disconnect and does not
erase an already confirmed identity for that physical connection.
BMW source timestamps, home scope and consumed plug/start events serve the same
connection separation. Neither feed's remote voltage or power fills missing
household electrical measurements.

## Minimum-current comparison and joint assignment

When current-write capability is verified, Charger 2 can temporarily use its
supported minimum of 6 A to distinguish simultaneous charging. This is scoped
to the physical connection and identification attempt, independently of the
separately configured current limiter. Charger 1 retains its native positive-current
settings and Equalizer control. The test requires a writable role and a verified
numeric range, but can use the exact reported minimum and previous native setting
without UI step metadata. Native load balancing, contradictory capabilities,
faults or unavailable control block it; identification does not invent a current
command or enable the economic limiter.

Confirmation requires fresh measured phase currents after the minimum-setting
readback, fresh live Tesla actual-current evidence from that test and
corroborating power. Tesla's reported phase count is not authoritative for the
charger's measured wiring; it cannot veto an otherwise unique current/power match.
The physical readings must settle and continue to agree on a later observation. Requested current and the pilot
ceiling are not measured draw. A Tesla current held from before the test cannot
identify either charger, even if its value matches. Each other observed charger
must have fresh distinguishing current evidence, confirmed zero draw or a
confirmed disconnect. Equal currents, missing peer measurements or inconsistent
measured currents and power leave identification unresolved. A unique Tesla match
can identify either charger; BMW still requires its own positive evidence.
If the same valid BMW source start/stop episode matches both current physical
connections, a unique Tesla current match can resolve both assignments jointly:
Tesla on the uniquely matching charger, and BMW on the other charger using its
own qualified BMW episode. Every BMW match involved must refer to that same
source start and stop; the peer's saved conflict or the absence of a Tesla match
is insufficient. A different contradictory BMW episode still leaves an
unresolved conflict. This joint conclusion retains the normal feed, source-time,
physical-session and explicit-retry checks; it does not manufacture a new BMW
event or grant another identification attempt. Completing a retry keeps its
source-time boundary, so earlier BMW episodes cannot return on a later poll.
BMW's stop report may arrive after charging has stopped or the minimum-current
setting has been restored. One confirmed Tesla comparison may therefore remain
as historical evidence for the same two physical connections, identification
attempts and vehicle-feed associations, including across restart after scope
validation. Its original receipt and physical measurement clocks remain intact.
A delayed qualifying BMW episode may complete that joint assignment; the saved
comparison cannot supply a new live-current match, renew a test or complete a
later retry. A changed connection, equipment identity, feed association or
explicit retry invalidates this retained comparison. Equal measured currents,
including both cars limited to 6 A by native load balancing, remain inconclusive
and do not authorize another current change or retry.
The shared BMW episode is consumed for new matching while its positive evidence
remains bound to the resolved BMW connection. Polling and restart cannot reuse it
on the Tesla connection or grant it to a new connection. Consuming a newer BMW
source episode continues to fence earlier episodes; resolving the pair cannot
move that consumption boundary backward. This owner-approved rule combines two
positive observations, and never identifies BMW from a negative Tesla result or
by elimination alone.

The current test saves the original setting, equipment/session scope and fixed
90-second deadline before a write. Positive identification or expiry returns
the setting to the original value, bounded by current native and applicable
limiter restrictions. Restart never renews the test. A newer external current
instruction supersedes restoration; uncertain dispatch/readback remains visible
instead of triggering a blind retry. Shelly has no native expiry for this setting:
an application or MQTT outage can prolong the reduction until safe recovery.
After native Stop, the reduced setting remains until confirmed stop permission
and fresh physical zero measured after that permission, including during ordinary
charging, Charge now or Automatic OFF. Expiry and restart preserve this obligation.
A later native Enable or current selection retains its separate priority.
When a comparison ends and the selected economic plan requires waiting, apply
that Stop and confirm fresh physical zero before restoring the higher setting,
including when the plan has not yet been saved as adopted execution.
A unique Tesla match on the peer can end the current comparison while leaving
the remainder of its original window for an independently valid BMW baseline
to begin its correlation pause. A Tesla already identified on the peer's current
connection can also permit that pause when a confirmed native Stop, fresh zero
draw and the quiet-peer checks establish that it remains stopped. This path
requires confirmed minimum-current readback and fresh, settled measured draw at
that setting on Charger 2; it supplies neither a new Tesla match nor BMW identity.
BMW still needs its own applicable positive baseline and matching stop evidence.
Otherwise, an unresolved current comparison takes precedence over that baseline.
Any remaining reduced setting stays until
the owned pause has fresh physical zero; restoring the setting preserves the
same BMW pause and its original deadline. This handoff creates neither a second
current test nor a renewed probe.
Native readback can arrive while the controller is still confirming its own
current restoration. Keep the already-owned BMW pause through that in-flight
operation without treating the pending setting as confirmed restoration or
permission to start. New external instructions and uncertain outcomes retain
their existing priority. An unconfirmed current command blocks application Start
even after the identification deadline or restart, and remains visibly unconfirmed;
Charge now does not resolve its outcome or repeat the command.

## BMW physical correlation

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

The usual BMW match combines timestamped home context with a live plug event and a
charging start followed by a stop near the current physical charger connection.
Both transitions must correspond to charging and stopping observed at that
charger. Source events and live MQTT delivery may precede the first connected
charger observation by up to 90 seconds, but must follow the last source-reported disconnect. Repeated polls
of that disconnected state preserve its source time; a missing source clock uses
the receipt time conservatively. This permits ordinary polling delay without
reusing evidence from an earlier connection. A BMW starting
to charge elsewhere at home is insufficient on its own. Without the
matching stop, that charging point continues to use manual battery values. Matching live
start evidence with valid home and plug context can show **BMW identification pending**
while awaiting stop confirmation, even if the plug report is unchanged.

BMW can also keep reporting `CONNECTED` without a new vehicle plug transition.
The latest valid home and plugged-in context with a healthy vehicle feed permits
a match from two independently reported charging transitions. BMW start and stop
must match the corresponding physical charger episode within 30 seconds, and
both BMW and charger starts must be at or after the actual known connection
boundary. This path has no preconnection tolerance and needs no new plug report
or artificial pause. A natural stop or a probe's programmed zero-current deadline
can supply the physical stop; missing original charging edges cannot be invented.

When startup instead uses a live ongoing BMW baseline without an observed start,
the controlled-pause path still requires its guarded causal witness. The BMW
baseline and physical charging witness must precede the pause boundary; both
stops must follow it. The boundary is a durable request
witness saved after a guarded charging observation immediately before requesting
the pause. Missing request evidence cannot be replaced by a later
acknowledgement. The owned restriction must be confirmed for the same current
connection and have been valid when the physical stop was confirmed. Saved proof
remains applicable after its expiry while that same connection continues.

The charger boundary supplies one common pause proof to the BMW matcher. Cloud
control verifies its exact delayed schedule and scheduling-stop reason (54), with
the reason and physical stop clocks agreeing. OCPP verifies its current transaction,
owned zero-current profile, `SuspendedEVSE` status and fresh zero power. Shelly
verifies the saved identification stop against live start-permission readback,
its supported noncharging work state and fresh zero physical power for the
same connection. The guarded charging witness is distinct from the general
install-intent time. A status change
observed while queued prevents dispatch from reusing the earlier charging witness.
Identity timing, pending
status, event consumption and conflict handling are shared between these backends.
Manual priority or conflicting Tesla evidence prevents this match. The active
identification pause uses this same charger proof; its additional ongoing-charge
baseline is separately bound to the saved attempt and vehicle feed. Charging
evidence cannot be reused for another connection. Matching delayed or reordered
BMW reports remain usable until unplugging, even after the temporary pause has
expired or normal charging has resumed. Historical events retain source and
receipt times separately; accepting an older event never rewinds current state.

No BMW charging-power field or plug-event identifier is required. Cached/retained
true values, or unchanged true values republished with newer timestamps, cannot
create new plug events. Conflicting vehicle evidence keeps manual inputs active.

A fresh live unplug event from an already identified BMW also ends that charger
connection when the unplug/replug gap falls between Easee polls. This boundary is
saved separately from the raw Easee readings and survives restart. It resets the
old planning episode and clears only the exact old schedule still owned by ST-MQ;
manual restrictions retain priority. A fresh Easee connection event or subsequent
live BMW plug event allows a new identification attempt, and the new connection still
needs matching charging-start and stop evidence before vehicle readings apply.

A confirmed match is scoped to the charger connection, survives scheduled pauses
and restart, and clears on unplug. Startup preserves the saved match, session edits
and target choice while the charger adapter initializes. Until its session and
readback are available, the vehicle remains unidentified in the live view and
session edits are unavailable. The same connection restores the match without
reusing a plug event; a different connection or confirmed departure clears it.
Used plug and charging evidence, including an active test's ongoing-charge
baseline, is consumed on a successful match, so changing evidence paths cannot
identify the next car using an earlier episode. Available
automatic battery fields take precedence individually without
overwriting saved generic defaults. Missing fields remain editable. Each physical charger card
displays its own connection; the independent vehicle-feed view identifies which
charger, if any, has a confirmed assignment.

## Attempt lifecycle and readiness

Passive identification continues for the physical connection independently of
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
test using the charger's native limits, with the scoped Charger 2 minimum-current
comparison when its verified capability and Tesla context permit it.
On local OCPP, a newly confirmed physical connection can begin this bounded
probe before a charging transaction exists. The previous connection's disconnect
cannot keep the probe waiting for the transaction it is intended to start.
Transaction-specific pause commands still require confirmation of the new
transaction; reconnecting never supplies that confirmation or vehicle identity.
For a stopped Charger 2, the same plausible context permits preparation before
Tesla reports positive current. The controller confirms the scoped 6 A setting
before granting an identification start. Failed or uncertain current readback
cannot fall through to a start at the previous higher setting. Preparation never
supplies vehicle identity; fresh independent current and physical evidence are
still required.
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
[BMW location context](integrations/bmw.md#home-location). Missing context before a
test leaves its budget unused; loss during an active test never renews its limits.

## Ordinary charging and correlation pause

When normal charging is permitted, it proceeds under native current limits;
waiting for either vehicle has no short charging timeout or identification energy budget.
Ordinary observation does not override the accepted economic program or its
start/stop commitments. Only a bounded probe, minimum-current test or BMW pause
can acquire temporary identification control. An active probe retains its saved
economic return time even if its own temporary draw changes the forecast.
A conclusive Tesla match can finish immediately. A usable BMW charging baseline
can trigger one brief, confirmed pause while the same connection is charging.
Startup can use live ongoing BMW charging without inventing a
missing historical start edge. Matching charger and vehicle stop evidence is
still required; an accepted pause command alone is insufficient. Active tests
are serialized across charging points. A BMW pause waits while its peer has a
recent charging transition, pending control or an upcoming economic transition
within the pause and correlation window. This avoids creating two matching stop
episodes without holding the peer away from its economic schedule. Unexpected
physical or manual changes still take priority and ambiguous evidence stays unresolved.
An observed peer transition in that pause's causal window disqualifies the pause
as identity evidence, including when the report arrives later. The restriction
survives restart and replacement of the peer's connection history; it does not
cancel the owned pause or renew testing. A later contradiction withdraws an
assignment supported only by that pause. Independently qualified complete
charging episodes and an earlier identity retained during a retry keep their
own evidence requirements.
Waiting for vehicle evidence does not own the shared test slot. Charger 2's
initial minimum-current preparation preference requires current native write
readiness and no device permission hold or pending command. That preference
ends 90 seconds after the saved attempt started; polling and restart cannot
renew it. Expiry leaves passive identification pending and allows either charger
to start a ready test when the slot is free. Actual current preparation, testing
and unresolved restoration retain exclusive ownership and their existing fixed
deadlines. Expired preparation with no dispatched or pending current write can
yield without claiming restoration; uncertain writes and applied settings cannot.
An explicit Identify request may wait for the peer; the request alone
grants no command permission.
A provisional plan alone does not block that pause when the peer has accepted
its ordinary charging choice and fresh physical readings confirm a settled
state with no upcoming transition. A connected peer under a confirmed native
Stop may remain stopped: fresh zero draw, native stop readback and absence of
an active native schedule provide the quiet evidence. The pause never acquires
control of that peer. A confirmed Shelly system permission hold follows the
same quiet-peer rule without becoming a manual instruction or authorizing Start.
A car permitted to charge may also remain idle because it is full or waiting
on a vehicle timer. Fresh zero draw and confirmed native charging permission,
with no native schedule, pending action or nearby transition, allow the peer's
pause; charging permission is not evidence that the car is drawing power.
Missing vehicle evidence, unavailable current control and
an unsettled peer are displayed separately; ordinary charging can continue while
an identification action is blocked.
Shelly requires available start/stop control,
fresh physical readings and available MQTT, and retains native restrictions
and its configured electrical limiter when enabled throughout the test.

## Extra charging during an economic delay

When the charging plan is delaying charge, the extra test temporarily permits
charging under the existing charger, vehicle and local load-balancing limits.
OCPP continues to use its established zero-current pause and release commands.
Shelly uses the verified minimum-current comparison when available, preserving
its native limits and configured electrical limiter. A conclusive vehicle match ends the extra test immediately and
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
at least 253 V and reserves ten seconds for stopping. A prepared Shelly 6 A test
creates that original deadline only after native current readback and can use
the confirmed lower ceiling. It also leaves ten seconds before the current
test's fixed restoration deadline. The 6 A restriction remains until the
economic stop has fresh physical zero-draw evidence, including after native Stop
or restart; command acknowledgement alone cannot restore the higher current.
A later native current choice still supersedes the temporary setting. This calculation does not
set charging current or claim that actual draw reaches the ceiling. These guards
require the running controller and working charger communication; an outage can
extend extra charging. No positive-current OCPP profile or autonomous probe cutoff
is installed. Restart or telemetry loss cannot renew the recorded allowance.
A brief identification pause during ordinary charging has a deadline
90 seconds later, rounded up to the next whole second. Easee cloud and OCPP
enforce that expiry at the charger. Shelly's pause uses its start permission and
is released by the application; its outage behavior is described below. With a
usable BMW baseline, physical stop confirmation retains the pause until a
positive identity match or the original deadline, giving BMW time to observe
and report the stop. Manual supersession retains priority. Physical confirmation
ends extra-energy accounting; it does not renew the pause or change source-time
matching tolerance. If a probe ends without a BMW baseline, its confirmed stop
returns immediately to the current charging choice. During an economic delay,
that choice is the scheduled pause. The zero-current OCPP restriction that
ends an extra probe can therefore last until the planned economic release; it
does not expire after the ordinary 90-second identification pause.
The captured economic return survives a terminal identification result and
restart. Temporary probe current or load can change the proposed forecast, but
a provisional forecast cannot release that accepted wait. A feasible replacement
is eligible only after the probe has stopped and its temporary current setting
has been restored; confirmed adoption supersedes the old return. Explicit
session or control edits also supersede it, with that time saved in the probe
record. Native instructions retain priority, and the return belongs only to the
same physical connection and ends at its original release time.

## Attempt completion and explicit retry

Exhaustion, interruption or the pause deadline ends active testing for that
attempt. Completion of the minimum-current comparison also ends testing unless
a unique Tesla match on the peer permits an independent BMW baseline to begin
its one pause within that comparison's original window, or that pause has
already begun. An already started BMW pause
keeps only its own original deadline; expiry cannot start a new pause.
An unresolved attempt shows
**Identification inconclusive** while normal control uses session/default battery inputs.
Source-timestamped BMW start/stop evidence can confirm the same connection until unplugging, including
after a long charging run or delayed and reordered delivery. Matching still
requires corresponding episodes and tightly correlated physical transitions;
newer current state is never rolled backward by historical evidence. Tests never
repeat automatically for that connection: polling, restart, economic replanning
and **Use automatic** cannot reopen an ended attempt. Choosing **Identify** or a
new physical connection permits a new attempt. There is at most one bounded
charging probe, one minimum-current comparison and one BMW pause per attempt.
Normal scheduled charging can supply additional evidence after the probe budget is exhausted.
**Charge now** during preparation or an active test permits ordinary charging
without cancelling identification. It ends the extra-energy probe accounting
and economic return obligation while retaining the current test's original
identity and deadline. A successful match or exhausted test restores the normal
current and continues charging. A newer native Enable or physical disconnection
retains its separate supersession meaning.

## Restart and restoration

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
