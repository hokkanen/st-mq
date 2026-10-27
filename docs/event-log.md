# Event log

The event log is a read-only operational timeline: what changed, why that is
known, and what evidence was recorded. It is available to admin and family users
on the active controller and read-only computers. It never grants device
authority and is not a complete archive of every physical action.

## Reading events

**Important** shows meaningful instructions, controller phase changes, recorded
problems, source corrections, charging start/stop transitions, evidence outages
and session outcomes. Routine shared current/readiness assessments, repeated draw
observations, charger status and verification checks are excluded from Important.
**All events** also shows routine controller decisions and other supported
diagnostics. The area filter selects Home, Charging, Garage, Caravan or System.
Filtering changes presentation, never retained source records.

Each entry has an occurrence time, area, readable explanation and evidence
classification. Expand it for structured facts and a complete timestamp in
Finnish local time with UTC offset and in UTC. Historical Warning and Error
labels describe the recorded event; current cards own active fault, source
health and restoration status. Missing actor, source context, delivery or outcome
evidence stays unknown. GPIO feedback, native readback and measured power retain
their own meanings; none establishes unobserved delivered heat or savings.

“Vehicle identity confirmed again” closes an earlier identity-unavailable
assessment at the recorded time. A handover can produce a brief unavailable and
confirmed pair while fresh evidence returns. These historical entries do not
override the current identity shown on the charger card.

Charging milestones link to the original session report. The log summarizes
retained report evidence instead of copying its full plans and raw protocol data.
Report expiry or explicit deletion removes its entries from this projection;
independent source and energy history retain their existing ownership.

Firewood additions and removals, and sensor changes and reversals, are separate
historical facts. Projection follows the selected source history and learning
epoch, including recovery references. It does not replace those source events
or the reconstruction journal. Newly introduced dashboard-choice and heating
phase events begin when this software records them; no past instruction is
fabricated from current state.

## Refresh and older history

The log has its own successful-check time and local loading, empty and failure
states. A dashboard status reply cannot renew that clock. A read-only view also
shows the source snapshot time, independently of when its events were fetched.
A failed event read retains the last fetched evidence with an explicit message;
it cannot undo a successful action receipt.

Events are fetched only while the log panel is on screen and the browser tab is
visible, after dashboard history becomes available. Returning to the panel checks
again; Refresh remains available. Leaving the panel or hiding the tab cancels
unused reads while preserving fetched rows and their original check time. This
does not change any recording cadence, retention or charging behavior.

Refreshing retains matching row nodes, open details, focus and reading position.
New entries wait behind **New events** while the user reads. **Load older events**
continues through available pages with at most 200 rows mounted; advancing
farther back retires newer mounted rows. **Back to latest events** fetches the
current head. Database or selected-history changes replace the old projection
and invalidate older cursors. Ordinary snapshot advancement is not a new
dataset. Membership validation removes excluded or deleted displayed records
even when new events have pushed the remaining records outside the head page.

General events and firewood use existing time indexes, including direct time/ID
range seeks for older pages. Sparse sensor and
charging summaries have explicit read bounds and disclose limited coverage in
the log. Further source-history and charging-report views retain their evidence.
An empty or exhausted view does not prove there was no activity. No history
retention or SQLite schema change is part of this feature; every controller
decision is still retained, including its existing replica-freshness role.

## Current HTTP contract

`GET /api/events` returns one sanitized timeline envelope. Its query fields are
`view=important|all`, `area=all|home|charging|garage|caravan|system`, optional opaque
`before`, `limit` (default 40, maximum 200), and an optional comma-separated
`visible` list of at most 200 stable entry IDs. Repeated, unknown, retired or
malformed query fields are rejected. Older cursors bind the dataset, selected
history and filters; a mismatch returns `event_log_context_changed` with HTTP 409.

The response contains `context`, `checkedAt`, `scope`, `snapshotAt`, `events`,
`retainedIds`, `nextBefore` and `coverage`. Entries contain `id`, `at`, `area`,
`severity`, `title`, `summary`, `evidence`, structured `details` and an optional
charging-report reference. The same allowlisted projection serves both access
roles. Neither arbitrary payloads, raw exceptions, private identities nor native
error text are public fallbacks. A nonempty old dashboard document needs a reload
after updating; there is no earlier array-response or `after` query bridge.

Historical file reads run in an admitted read-only worker with bounded queue,
memory and work. A physical replica file shares its event worker across ordinary
verified publication advances; replacing the file retires its owner. Concurrent
matching requests share only an in-flight read and its original check time, never
a cached completed response. Filters, visible membership, source/snapshot clocks
and checkpoint identity retain their boundaries. Queueing counts toward the read
deadline. Cancelling one subscriber preserves other subscribers; the last active
subscriber waits for database cleanup before releasing its read context.
Replica requests pin the verified checkpoint; worker cleanup
finishes before publishing its result. A same-database forward-checkpoint hint
can trigger one fresh verified read context, including when a legitimate
coalesced publication has pruned the old transaction prefix. The hint supplies
no data or lineage proof. Changed identity, conflicting retained hashes,
missing retained boundaries, uncertain cleanup and another advancement still
refuse. In-memory offline fixtures use the same
query and presentation contract at one read boundary. No read creates a saved
choice, observation, event, correction, command or learning input.

Validation: `test/event-log.test.js`, `test/event-log-service.test.js`,
`test/event-log-ui.test.js`, replica-owner/viewer regressions and
`node test/browser/event-log-smoke.js` exercise source selection, privacy,
pagination, failure handling and the real dashboard. Add `--firefox` to use an
isolated Firefox session. Browser fixtures use synthetic data and do not qualify
physical devices or installed Raspberry Pi storage latency.

Confined Firefox packages can set `STMQ_FIREFOX_PROFILE_ROOT` to an accessible
private directory. The fixture creates and removes its own disposable profile
there; it never selects an existing browser profile.
