# Charging

ST-MQ models two physical charging points: **Charger 1 is Easee**, using either the cloud delayed-start scheduler or the native OCPP controller’s expiring current profiles; **Charger 2 is the Top AC / Shelly XT1 EVSE**, controlled through MQTT RPC. TeslaMate and BMW CarData supply vehicle evidence for either charging point. They never supply another home electricity contribution or receive vehicle commands.

Charger 1 uses one control backend at a time. Initial native OCPP activation
waits while a cloud schedule remains active, leaving the cloud controller and
its pending automatic takeover intact. It drains the old controller only after
that schedule is cleared or expires. Cloud telemetry remains a data fallback without silently
reactivating cloud scheduling. Native `plug-and-charge` authorization can start
a connected vehicle without an RFID tap; RFID mode instead requires permitted
tags. Native economic pauses expire on the charger and release to its existing
charger/vehicle/Equalizer limits. Extra identification charging during an economic
delay uses normal charging current, with a controller-managed energy allowance
and safety deadline. See
[local setup and native control](charging-easee.md#direct-local-ocpp-telemetry-firmware-344-or-later).

**Native OCPP needs ST-MQ for charging authorization.** Normal Ctrl+C, service
stop, restart and paired handover leave OCPP enabled on the charger. A restart
reopens the local connection without cycling charger configuration. While the
controller is offline, new charging or Easee app Start may wait for approval.
Restart ST-MQ to restore local control, or explicitly disable Direct OCPP through
Easee configuration to return to cloud control. Expiring economic pauses do not
provide automatic cloud authorization during an outage.

Charger 2 is disabled by default. Once its MQTT device identity and topic are
configured, supported start/stop readiness is checked automatically. Native app
changes retain priority; current adjustment defaults on and has separate installation and
capability requirements. See [provider capabilities and setup](charging-provider-capabilities.md).

## Dashboard and requests

Both charger cards show the physical connection, assigned vehicle or uncertainty, current request, measured/estimated progress, connection cost and control state. The Automatic charging switch governs economic scheduling. Vehicle identification and metering continue with automatic charging OFF. Charger 2 current adjustment defaults on independently of that switch, including Charge now and native running. Charger 1 retains its native Equalizer current control.

When the physical connection is unknown or disconnected, the compact card still
shows configured starting charge, target, capacity and ready-by defaults. These
are labeled defaults, not vehicle readings or an active session estimate. Earlier
session edits and progress do not populate this preview, and session actions
remain unavailable until the current connection is confirmed.

An unavailable vehicle feed leaves identification pending without suspending
ordinary scheduling. The configured battery defaults and any current session
edits still supply the request; proposed periods remain visible. An actual
identification charging test or pause retains its separate progress and recovery
status. A local OCPP connection awaiting a transaction also shows its proposed
periods, alongside pending charging approval; it does not claim the native
profile is applied or that completion is confirmed. Plug-and-charge approval
waits until the price plan or an allowed charging action calls for charging.

A live local OCPP connection status newer than the last disconnect restores
Charger 1's physical session and readings even while its transaction is
unconfirmed. Native scheduling still waits for transaction evidence newer than
that disconnect. An existing transaction can be recovered from two distinct,
fresh, advancing transaction-bearing meter reports on the authenticated local
connection, with an active connector status. Its original start time and
authorization remain unknown. Transaction confirmation does not restart the
physical session or reset its settings, deadline, progress or cost.

An admitted OCPP status up to one second ahead of the local clock remains
unavailable until its original source time. Reads and command acknowledgements
may wait once for that time before checking the original connection, transaction
and instruction guards again. The wait cannot renew a request deadline, resend
a command or borrow evidence from a replacement connection. A further future
status, timeout, abort or genuine instruction change still fails closed.

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

Both native expiring pauses and application-managed pauses use the same confirmed
pause wording. An application-managed pause needs current session ownership,
confirmed disabled start permission and fresh physical noncharging evidence.
Its next charging period still requires the application to resume the charger.
An ordinary OCPP pause installed while already suspended can use fresh zero power
measured during that suspension together with the current confirmed zero-current
profile. Replanning does not require the stopped charger to report another stop
transition. A command dispatched while charging and every identification pause
still require power evidence after the command; an existing stop cannot establish
a causal vehicle response.

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

**Current charge** follows the latest applicable vehicle reading and advances with
measured charging energy. Brief field help identifies the source and configured
default; the Charge popover and **How charging works** explain estimates,
charging losses and reference updates. Configured starting charge and a saved
manual reference are labeled separately. The field shows the current battery
charge rather than keeping the value from plugging in. Unsaved edits remain in
place while readings refresh. Saving an edit
sets a new manual charge reference for this connection; it does not change the
configured starting-charge default or the original vehicle reading.

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
Unplugging also ends the override. Both chargers use the same component and
controls: **Automatic charging**, **Charge now** and **Use automatic**. Differences
come from reported capabilities. Messages wrap and the card grows when needed;
status, errors and popup explanations are never deliberately clipped.

The Automatic switch saves the scheduling preference. It stays **ON** while
manual control has priority. With Automatic enabled, a new confirmed physical
connection takes automatic control and supersedes earlier charger instructions
and native charging schedules, including recurring schedules. A genuinely missing
saved session follows that policy after fresh connection evidence; unreadable or
invalid saved state cannot authorize takeover. Restart and network reconnection
preserve a known session's automatic or manual ownership. A later external change
has priority for that connection; unplugging ends that manual scope. Changing the
Automatic preference alone does not take over an already established session.

**Use automatic** is a separate, explicit new
instruction: enable Automatic, end Charge now, supersede the observed manual
Start/Stop and disable supported native charging schedules. Those earlier
instructions are not restored after the session, unplugging or restart; a new
external instruction takes priority again. Returning to the price plan may keep
charging paused until a cheaper period. The button uses the same outlined styling
as other card actions and appears in **Charging controls** only when another
charger instruction has priority and takeover is available for the current
connection and control authority. It stays disabled during its request and hides
when takeover is unavailable or no longer needed. Pending, blocked and unconfirmed
outcomes remain visible independently of the button; success requires charger
readback. Compact status labels omit terminal periods, while explanations and
action receipts use complete sentences.

For local OCPP, a handover that needs an economic wait must first install and
confirm its zero-current pause before clearing the existing native stop. A failed
step keeps the handover blocked. Its message identifies the failed operation and
distinguishes a timeout, cancelled command and protocol failure. Session reports
retain the supported error code and operation for later diagnosis; older generic
failures cannot establish which of those causes occurred.

Automatic and explicit handover are bound to the current equipment, connection, request/control
revisions and observed native instruction. A newer observed instruction fences
it. Charger APIs do not supply an atomic cross-client lock: a concurrent external
edit must still be detected through source clocks, schedule revisions and
readback. Observed stop/enable changes do not prove which app or person caused
them. Shelly's native command-source evidence distinguishes same-value `sys`
refreshes from newer external instructions. A system refresh preserves existing
ownership only when no intervening permission change was observed; a Stop followed
by Enable cannot disappear because one poll sees the same final value.
The owner-approved [system permission exception](#shelly-system-permission-changes)
classifies fresh `sys` changes separately while preserving the observed edges,
physical permission and their provenance. Other observed external instructions
retain priority. Detecting a repeated
selection of the same value requires newer native instruction evidence. If a
repeated Shelly Stop leaves the value `false`, source `rpc` and update timestamp
unchanged, the status API cannot distinguish that command from the existing
automatic pause. Polling freshness cannot supply the missing instruction. This
is an unresolved detection limitation; genuinely observed native Stop still
prevents automatic resumption. Missing provenance is not attributed to the application.
Vehicle timers and targets, faults, electrical limits and authorization
remain authoritative. Unsupported native schedule shapes stay visible as blocked
rather than being silently removed. See the [Easee takeover constraints](charging-easee.md#ownership-and-manual-controls)
and [Shelly command contract](charging-provider-capabilities.md#mqtt-and-commands).

A manual SoC is a one-time anchor. A newer applicable vehicle reading supersedes it using the provider's source clock, or explicitly labeled receipt time when no measurement clock exists. A pinned capacity outranks the provider capacity. An explicit requested minimum remains distinct from the vehicle's actual ceiling; requesting 95% while the vehicle reports an 80% ceiling is constrained rather than silently rewritten. Vehicle current limits and native not-before times constrain either charging point.

TeslaMate's `charge_current_request_max` describes currently available supply,
which can follow an EVSE pilot reduction or stop. A request equal to that maximum
does not establish a separate vehicle current limit. Only a valid request below
a known available maximum supplies that restriction, including a reported zero.
Equal, inconsistent or incomplete values leave the independent vehicle limit
unknown, while both raw observations retain their values and receipt clocks.
This prevents a 6 A identification setting or a stopped 5 A report from becoming
a permanent limit on later charging. Native charger/electrical ceilings and the
vehicle's own protections still apply. Field meanings follow the
[Tesla telemetry reference](https://developer.tesla.com/docs/fleet-api/fleet-telemetry/available-data).
A positive vehicle request below 6 A uses a valid 6 A pilot allowance while the
vehicle limits its own draw; planning estimates that lower delivery and reserves
the pilot allowance. Explicit zero and electrical limits still prevent starting.

### Shelly system permission changes

The Top AC Portable profile has produced `sys` false-to-true start-permission
sequences after confirmed application Starts, including ordinary charging long
after connection with native Auto charge disabled. On 2026-10-04 the owner
explicitly broadened the earlier first-start exception: fresh supported `sys`
permission changes are device transitions at any connection age and current,
including repeated cycles and changes outside identification. There is no plug,
first-Start or ten-second eligibility window.

Classification and physical permission remain separate. A genuine device Stop
blocks replacement Start while permission is false or unknown, including with
**Charge now**. Fresh true permission can clear only that device hold; it does
not supply automatic authority, clear a separate native Stop, or itself request
another Start. A false-only hold has no retry timer. Restart preserves the
restriction until fresh device evidence resolves it; a restored record cannot
manufacture a new physical connection, observation or control permission.
An initially observed false setting on a new connection, with no intervening
device Stop, is not such a hold. Normal connection authority can still start a
charger whose native Auto charge is disabled.

A same-value `sys` refresh of an uninterrupted, application-owned Stop preserves
that pause and its original resume deadline. A true edge interrupts its physical
confirmation, even if a later false edge arrives in the same batch before polling.
That sequence cannot furnish continuous application-owned stop evidence or a new
BMW identification witness. Valid earlier historical evidence stays unchanged.
Effective command source follows the native partial-notification contract; omitted
unchanged attributes do not create new provenance. Retained, stale, unknown or
invalidated readings cannot release a hold or supply new control evidence.
Events admitted and saved while fresh retain their historical meaning after an
outage: a recorded interruption still invalidates the earlier continuous pause,
and a held Stop still needs a fresh correlated query before release.

Identification may continue through a device permission cycle only within its
existing attempt, current-test/probe deadlines and energy allowance. The cycle
does not renew a deadline, create another attempt or authorize an extra Start.
Original expiry and current-restoration obligations still apply. Fresh physical
zero remains necessary before raising current while stopped.

Other native instructions, current reductions, schedules, faults, authorization,
vehicle restrictions and electrical limits retain their existing authority.
Unknown command outcomes remain fenced; a system event cannot retroactively
acknowledge an uncertain application write. Queue and persistence failures retain
their conservative command gates.

The exposed source is not a reliable actor identity. An independent native action
reported as `sys` can receive the same classification; the owner accepted this
ambiguity when widening the exception. No firmware cause or firmware fix is
claimed. The separate limitation detecting a repeated native Stop while permission
is already false remains as described above.

### Schedules inside the vehicle

[TeslaMate MQTT](https://docs.teslamate.org/docs/integrations/mqtt/) exposes
`scheduled_charging_start_time`. ST-MQ uses that next start when selecting the
cheapest feasible charging periods. Unchanged settings keep their original
receipt/provenance while live TeslaMate health establishes feed availability.
This is not a complete weekly schedule: the standard MQTT feed does not expose
all recurrence rules and end times. An absent start does not prove that every
vehicle-side restriction is disabled. For planning, an unknown restriction does
not create an assumed timer or reduced current; the
[maximum-available-current assumption](#maximum-available-current-assumption)
applies until usable evidence establishes a restriction.

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

Charging does not require vehicle identification: editable current charge,
target, usable capacity and ready-by remain available. Within the same identified
physical connection, feed loss preserves the last charge anchor plus recorded
energy, labeled as last known vehicle charge. An explicit **Current charge** edit
replaces it. A new or ambiguous connection cannot borrow that estimate.

The BMW publisher sends a live report every five minutes. Ten minutes without
a valid live report withdraws its automatic values even if the broker remains
connected; source measurement clocks do not advance with these reports. Retained
replay alone does not restore live-feed availability. TeslaMate uses its separate
live logger-health reports. Physical charger metering remains independent.

After a master-host failure, the promoted computer needs its own working broker,
device connections and credentials; see [paired operation](pairing.md). Cached
data is not fresh device evidence. Reachable chargers can continue with manual
inputs. Missing shared prices or usable property-capacity forecasts select
provisional release only when no existing adopted instruction needs preserving.
For the same confirmed physical connection, an adopted schedule retains its
original pauses and release times while these inputs recover, including after
restart. Missing evidence does not authorize an early start or renew a pause.
A modeled deadline shortfall remains a separate release decision; an unknown charger current alone uses the
[planning assumption](#maximum-available-current-assumption).
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
Current readback is compared with a fresh, ready controller's active ceiling for
the selected priority; that live ceiling can differ from the forecast. Missing
limiter startup state or stale assessment evidence leaves the result unknown.
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

The observer evaluates both charging points together, including while automatic charging is OFF and hours after connection. Assignment requires positive corroboration: applicable vehicle home/plug/start evidence and physical charging behavior. Similar powers or currents on two charging points can remain ambiguous. A negative Tesla match never identifies BMW or the other charger by elimination.

Assignments carry the physical association, plug epoch and vehicle-feed identity. Changing the configured Tesla car, broker, topic namespace or home-zone configuration cannot lend a replacement source’s readings to a saved match. Genuine disconnect/reconnect events are retained even between planner ticks or MQTT subscription admission and invalidate the old scope. Pause/resume within a connected work state remains one session. Explicit conflicting evidence withdraws certainty. A remembered identity alone cannot authorize a new connection, and current vehicle fields are withdrawn when the upstream feed is unhealthy.

A conclusive unique Tesla current test can replace an older mistaken assignment
and clear the corresponding saved conflict. The displaced connection resumes
observation for independent BMW evidence without renewing its test budget. Fresh
evidence supporting competing assignments remains ambiguous; provider silence
alone cannot correct an assignment.

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
[BMW location context](bmw-cardata.md#home-location). Missing context before a
test leaves its budget unused; loss during an active test never renews its limits.

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
A provisional plan alone does not block that pause when the peer has accepted
its ordinary charging choice and fresh physical readings confirm a settled
state with no upcoming transition. A connected peer under a confirmed native
Stop may remain stopped: fresh zero draw, native stop readback and absence of
an active native schedule provide the quiet evidence. The pause never acquires
control of that peer. Missing vehicle evidence, unavailable current control and
an unsettled peer are displayed separately; ordinary charging can continue while
an identification action is blocked.
Shelly requires available start/stop control,
fresh physical readings and available MQTT, and retains native restrictions
and its configured electrical limiter when enabled throughout the test.

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

The planner first respects known applicable device/vehicle limits, manual permission, native start times and credible capacity. It protects both deadlines where the modeled opportunities allow that. Actual all-in electricity cost then governs period selection. Priority must not buy more expensive energy merely to favor a charger. In infeasible cases, charger priority favors its remaining request; balanced mode shares normalized shortfall. Eligible charging time and grid-energy need determine pressure. Shared budgets below two minimum currents use bounded time slices rather than invalid sub-minimum simultaneous commands.

### Maximum-available-current assumption

When a connected charger's future charging current is unknown, assume the
maximum it can deliver within its configured/verified charger ceiling and the
forecast property headroom on each phase after household and peer load. Apply
the same rule to either charger, including a newly connected charger whose
current readback or control readiness is unavailable. Use the assumed current
for delivered-energy estimates, charging duration, completion and selection of
cheap periods. The joint allocation shares the available property capacity;
it does not give each charger the same spare capacity independently.

This is an optimistic delivery forecast. It is not a permanent worst-case
reservation of the peer's maximum draw. Do not invent hidden vehicle timers,
unknown low current settings or speculative restrictions and then release
economic pauses to compensate. Missing vehicle identification or battery inputs
continue to use the applicable configured request defaults and existing session
anchors. Known applicable native/manual, vehicle, cable, installation and
electrical limits still constrain the forecast, including a confirmed 6 A
setting or a known vehicle not-before time. Observed low draw by itself does
not establish a lasting current restriction.

Expose the maximum-available-current assumption with the proposed plan, keep
estimated delivery and completion distinct from measured progress, and recompute
when usable limit, household-load, peer or vehicle evidence changes. A missing
charger-current input must not alone mark a price plan infeasible or select an
immediate release. Control readiness is separate: an unavailable charger can
have an assumption-based forecast without an accepted schedule, and that
forecast supplies no authority to send commands or proof of physical response.

A real modeled deadline shortfall, a known restrictive timer, or absence of
usable shared prices/property-capacity evidence still needs its specific
feasibility or fallback result. Do not collapse those reasons into an unknown
charger-current restriction. Actual draw and confirmed execution continue to
govern immediate electrical allocation; a forecast never establishes that an
unavailable charger has paused or accepted a lower current.

Regression coverage must include a feasible delayed Charger 1 plan followed by
Charger 2 connecting with unknown current and unavailable control. With usable
prices, property headroom and sufficient modeled opportunity, both requests
remain represented and Charger 1 keeps a feasible price schedule instead of
being released solely because Charger 2 is unready. Also cover max-available
delivery estimates, a later known lower limit, joint per-phase allocation and
the unchanged command-readiness gates.

### Joint allocation and execution

The expensive joint search runs in one local worker, with one active calculation
and only the latest pending request. Repeated equivalent inputs reuse a bounded
cache for at most 30 seconds and never across a schedule, allocation or deadline
boundary. Results retain their calculation time. Changed requests, connections,
native instructions, authority, source selection or expired results are checked
before publication; stale work cannot replace the current plan. Accepted session
evidence and progress are saved independently while planning runs. Device
readback and command fencing remain authoritative.

The implementation is a bounded search over a declared slot/current model, **not a globally exact continuous-time optimizer**. Results expose the search kind, relaxed cost lower bound, feasible candidate cost and upper bound on the cost gap where available. Search pruning can miss a better joint candidate; reported feasibility is conditional on the recorded assumptions. Synthetic exhaustive small-horizon comparisons validate representative cases. There is no one-cent pause penalty or mandatory one-cent saving hurdle. Practical minimum economic runs/gaps remain 15 minutes; equal-cost choices prefer stability.

If the ordinary search finds no feasible schedule, one additional candidate uses
the separate windows in which a fixed native current fits every forecast phase
and scenario. This recovers earlier charging opportunities that a later household
peak would exclude from a continuous period. The joint simulator still checks
peer allocation, native restrictions, fixed periods and schedule limits; the same
service, priority and cost comparison selects the result. This bounded fallback
does not add search work to already-feasible plans or promise exhaustive recovery.

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

Easee's Equalizer, charger and vehicle determine the available charging current. Native OCPP economic pauses impose an expiring 0 A restriction; identification probes briefly release the owned pause at normal current before returning to that economic pause or normal charging. This never raises native limits or changes circuit protection or fuse settings. Current already drawn by an automatic-OFF, manually running or post-target peer remains a load until physical evidence says otherwise. Forecast household load, gross configured capacity and current net allowance are distinct. A clipped zero Equalizer allowance does not establish an exact gross budget. Missing shared rates or usable property capacity produce provisional decisions, not free electricity or invented assured readiness; unknown charging-current restrictions use the maximum-available-current planning assumption.

Capacity estimates count contributing source observations, not polling frequency.
When Easee reports an idle cloud mode or OCPP connector status and less than
0.1 A on every phase, new charger
meter timestamps or small idle-current fluctuations cannot count the same held
allowance and property observations again. Their original source clocks determine
sample identity and age; the accepted sample retains the measured subtraction.
Fresh allowance or property observations still contribute, and charger currents
and their clocks remain contributors during actual draw or an unconfirmed idle
state. Restart preserves the bounded evidence history without making it fresh.
Temporarily missing native allocation or circuit metadata cannot erase that
history as if the installation had changed. The estimate remains unavailable
until the current metadata is confirmed; a confirmed configuration change still
invalidates the old evidence. Expiry retains the original source clocks.
These forecast estimates never replace live headroom or native electrical limits.

The final period is an open release. Reaching the planning minimum or ready-by deadline does not issue a final stop. Extra actual energy remains metered and priced. Unknown future post-target consumption cannot have a guaranteed optimized bill. Later economic pauses require ST-MQ and the provider to be available; the UI distinguishes the proposed plan, dispatched request, readback and observed physical response.

## Charger 2 current allocation

Current adjustment defaults on (`limiterEnabled:true`) and follows property load
and the shared charger priority independently of Automatic scheduling, including
Charge now. An explicit `limiterEnabled:false` selects basic start/stop, leaving
native current settings and native load balancing in charge. The bounded
identification current test above is a separate scoped action and can operate
with the limiter disabled when its own capability checks pass. In basic mode,
planning uses the known applicable native current setting, or the
[maximum-available-current assumption](#maximum-available-current-assumption)
when it is unknown; scheduling sends Boolean start/stop only. The allocation
below applies with `limiterEnabled:true`;
missing current-control capabilities block that mode rather than bypass it.

Commissioning must verify three-phase association, phase order, installation fuse ratings and whether the property and charging-current magnitudes support the additive model. For each phase, the modeled non-EV base is `B = property − Easee − Shelly`. The absolute Shelly ceiling is the tightest `fuse − margin − B`, then any planned Easee reservation and hardware, vehicle and native user limits. The calculation includes Shelly's existing draw; it does not mistake incremental spare margin for an absolute setpoint.

Shelly priority excludes Easee's present draw from this fuse test. If household
demand excluding both chargers leaves 16 A on every phase, Shelly may take 16 A
within its own limits, and Equalizer must reduce Charger 1. A temporary property
total above the limit caused by Charger 1, a conservative forecast allocation or
a secondary deadline reservation must not lower Shelly's live entitlement in
this priority. Economic scheduling still chooses permitted charging periods;
forecast delivery remains an estimate. Equalizer response and actual installation
protection are not guaranteed by this model.

For unscheduled charging, including Charge now, coherent live headroom follows
the peer's measured draw or its confirmed open charging instruction. Balanced
priority shares this headroom; Charger 1 priority reserves that peer demand
first. Economic forecast ceilings do not cap unscheduled current. Unused peer
capacity remains available to Shelly, including when Charger 1 is stopped. A
controller-owned current pause can resume when that share reaches 6 A; an
external Stop cannot. A connected idle car alone is not evidence of requested
current. If total headroom cannot support two 6 A pilots, retain the existing
charging turn in Balanced priority instead of repeatedly stopping and starting
both cars. Scheduled Automatic charging continues to use the joint planned allocation.

A common current is rounded down to the supported profile's 1 A step. The native
range must report a 6 A minimum and a sufficient maximum. Shelly's optional
`meta.ui.step` describes UI presentation: an absent value does not disable
supported integer current writes, while contradictory reported metadata blocks
them. Values below 6 A cause an EVSE pause, not an invalid current RPC. Decreases
do not wait for the increase dwell; increases ramp by the configured step budget
after dwell, and resumption also requires dwell and permission. Native lower
current choices, start/stop, energy/time caps, faults and schedules retain
authority. Enabled native schedules conservatively own start/stop until
disabled/removed; ST-MQ does not guess their cron window or rewrite them.
Current limiting remains separate.

The existing five-second Shelly poll and incoming native changes reconcile
current against the latest admitted phase observations. They do not add a second
timer, poll the other charger's cloud or repeatedly run the economic search when
the session, authority and bounded plan remain applicable. Original source clocks
and the separate identification deadlines remain authoritative. Command and
readback delays can extend response time; this is not independent fuse protection.

Coherent current inputs default to a 15-second age and 5-second skew bound, with 1 A per-phase margin. Unknown, stale, misaligned or non-additive inputs select the owner's configured fallback ceiling, initially **12 A**. Known tighter limits still apply. Fallback does not start a stopped vehicle or bypass its native timer. It is not guaranteed fuse protection.

An explicitly uncommissioned additive model keeps that configured fallback as a
known ceiling in the delivery forecast too. A commissioned installation with
temporarily missing telemetry retains the documented optimistic future-headroom
assumption; the live controller still falls back until usable evidence returns.

If the process, broker or charger is unavailable, ST-MQ cannot apply a new fallback. **Autonomous controller-loss behavior is unverified.** There is no invented watchdog, command TTL or broker-will guarantee. Actual last-setpoint, reboot and outage behavior must be established with the arrived hardware before unattended deployment. The status reports this separately from a successfully requested telemetry-loss fallback.

## Charge progress and cost

Physical electricity sources are always Easee for C1 and Shelly EVSE for C2, regardless of vehicle identity. Progress uses accepted interval kWh plus the recorder's admissible pending tail. Wrong units, unusable quality, invalid geometry and overlapping conflicting contributions are excluded. Missing energy receives no invented credit. The modeling assumption is 92.5% grid-to-battery efficiency; it is not measured battery capacity or efficiency.

A new SoC observation rebases modeled progress. Connection energy and cost retain their separate physical-session lifetime across those rebases, edited targets, pauses and restart. Native Shelly accumulated-energy deltas record C2 energy as three estimated phase allocations whose sum preserves the measured increment, using the same phase-only interval format as C1 and property. No separate total-energy series is stored. Unallocatable measured increments remain diagnostic events and explicit phase gaps; progress and cost require a complete valid phase group. Counter resets, implausible jumps and excessive source-time gaps start a new baseline without bridging invented energy. Charger 2 does not integrate power to obtain total energy and has no session-energy accumulator or recorded-energy comparison. Property and Charger 1 retain their checks of power-integrated phase energy against meter references.

Price revisions are canonicalized by publication authority over their actual coverage. New quarter/hour slices replace the overlapped region only; negative prices, remaining older coverage and gaps remain explicit. Binary interval lookup prices physical contributions efficiently. Costs distinguish actual delivered, estimated remaining, missing/unpriced coverage and timing comparisons. The per-charger and combined timing benchmark is not proof of causal controller savings.

## Restart and compatibility

Current-format sessions, requests, assignments, costs and uncertain commands recover only within the same physical/source association. Device, MQTT broker/root, integration profile/service or phase association changes cannot borrow old ownership. A potentially dispatched command is reconciled with native readback before another intention; it is never blindly replayed.

Shelly command confirmation requires its acknowledged setting and fresh native
readback within the same adapter generation and physical connection. An unrelated
connected work-state update does not erase that confirmation. Pending observations
still withhold readiness for further commands, and physical charging or stopping
requires its own fresh measurement.

Pre-1.0 native state is not migrated. The current charging state remains version 6
and database schema 20; the physical adapter uses its own explicitly scoped
current state. New optional control choices default to OFF/Balanced when absent;
recorded presentation never supplies control permission. Retired configuration switches for automatic charging and
priority, dashboard overrides of permanent battery defaults, old pseudo-C2
settings, charger-bound vehicle topics, efficiency overrides, unscoped verdicts
and aliases are rejected. Incompatible development databases, including those
with the earlier Shelly power-unit interpretation, are rejected before mutation
and require an intentional fresh start; no conversion or repair is attempted.
Only the v0.7.5 `easee.csv` and
`st-mq.csv` import paths are supported historical boundaries. Imported
C1/property history retains its provenance and does not become a Shelly observation.

The **Added energy** tile shows recorded grid energy for the whole plugged-in
connection. A fresh vehicle battery reading can change the charge estimate's
reference, but does not reset this tile. The recorded total remains after charging
finishes, reaching the target, or passing ready-by; confirmed disconnection ends
it. Energy inferred only for a cost estimate is not shown as recorded energy.
