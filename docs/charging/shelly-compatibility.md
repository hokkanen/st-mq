# Shelly native-permission compatibility

The supported EVSE profile has exhibited SYS permission interruptions after an
acknowledged Start. Native provenance and timing have been observed; their cause
and any firmware correction remain unproven. The owner approved the bounded
policy and indistinguishable native-Stop ambiguity in [F3](../../AGENTS.md#f3).

## Boundaries

`src/charging/shelly-compatibility.js` contains two named policies:

- **Permission-transition reconciliation:** classify supported SYS transitions,
  preserve witnessed holds and reconcile an acknowledged Start through correlated
  native SYS readback. It never invents an external actor or a missing ACK.
- **Startup retry recovery:** own scoped counters, delays, incident deadlines and
  sustained-draw qualification. Scheduled retries and explicit Charge now
  requests have independent budgets. See the [execution contract](execution-and-recovery.md#startup-retry-recovery).

The module operates on bounded state and supplied admitted evidence. It sends no
device commands, starts no timer, queries no device and writes no database. The
existing Shelly controller persists the result and rechecks authority, session,
current, native restrictions and command correlation before any publication.
The runtime's normal wakeup mechanism services due recovery; there is no second
command loop. Pending commands and physical restoration obligations stay in the
core controller, outside removable retry state.

Charge now instruction precedence and return-to-Automatic behavior are permanent
shared controls. Passive incident ingestion in session diagnostics remains
independent of the module, consumes a durable sequence and stores immutable rows
with the report checkpoint. SYS cycles are captured before the native queue is
acknowledged, including cycles between dashboard observations. Model/firmware,
source/receipt clocks, Start/ACK timing and actual applied current are retained
when observed. Raw device identifiers and payloads are excluded. An unsuccessful
report write retains a bounded 128-event replay tail and exposes the existing
diagnostic-storage error; unavailable reporting is not proof of a clean session.
Normal retention applies; only an explicit Save preserves a report permanently.

## Removing a qualified workaround

There are no feature switches or inferred firmware cutoffs. Qualify the candidate
firmware using native evidence and repeated real scheduler/Charge now starts,
pauses, current changes and long holds. Record the firmware and distinguish
absence of an observed failure from proof of its cause.

Remove the selected policy and its explicit controller hooks in one reviewed
change, together with policy-only state validation, tests and F3/execution text.
For startup recovery, the hooks are native event observation, acknowledged Start,
recovery evaluation and the durable retry debit immediately before publication.
For permission reconciliation, replace its preview and acknowledged-Start policy
with the supported firmware's conservative native permission interpretation.
Do not restore the earlier interpretation that assigns SYS to an external actor.
No historical interpreter, schema migration or renamed-field alias is introduced.

Keep native provenance/events, unknown-outcome fences, interruption of continuous
pause proof, physical-zero checks, original identification bounds and all pending
command/restoration duties. Removing a workaround cannot erase an outstanding
physical duty or grant authority from saved state. Keep already recorded generic
report events and their labels so resolved incidents retain their meaning.

Validate normal starts and earlier-Stop takeover, genuine later Stops, faults,
insufficient current, unknown ACKs, reconnect/restart/handover, report replay and
the remaining policy in isolation. Historical incident rows require no recovery
module to display. Deploy the reviewed change through the normal backed-up
paired rollout.
