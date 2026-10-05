# Guided charging assessments

[Charging overview](../charging.md) · [Code map](architecture.md)

Open **Data & settings → Connections & configuration → Charging → Guided assessments & installation checks**. These server-side observers assess ordinary charging with independently recorded assumptions; they have no actuator. For selected hardware experiments and command-line evidence tools, use [testing and physical development](testing.md).

## Prepare an assessment

Choose **Guided BMW test** or **Guided Tesla test**. Selecting a vehicle loads its
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

## Normal and delayed programs

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

## Completion and shared assessment

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

See [session-report evidence](evidence-and-reporting.md#physical-evidence-and-findings) for draw thresholds, source clocks and findings shared by passive reports and guided assessments.
