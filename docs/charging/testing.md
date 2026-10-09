# Charging verification and physical development

Use these tools when developing a charger feature whose result depends on real
device behavior. They preserve a repeatable way to observe selected physical
cases; they are not an unattended acceptance system or a requirement for every
commit. Start with the [charging overview](../charging.md) and
[repository foundations](../../AGENTS.md), particularly evidence, control authority
and private data ownership.

## Choose the smallest useful scope

| Check | What it establishes | When to run it |
| --- | --- | --- |
| `npm run check` and focused charging tests | Software behavior using synthetic devices, feeds and clocks, including the observer/auditor's own regressions. | Normal development and before committing relevant changes. |
| [Provider checks](../live-testing.md), `npm run test:live` | Bounded read-only access to configured providers. | Diagnosing an account or acquisition problem. They do not operate chargers. |
| Dashboard [Guided tests](guided-assessments.md) | Assessment of independently observed charging against explicitly recorded assumptions. | Checking a charging session. Guide inputs never control production behavior. |
| This runbook and `scripts/charging-physical/` | Recorded evidence around deliberately selected, manually operated hardware cases. | Substantial charger features or a specific issue that needs physical reproduction. |

Pick cases affected by the change, record the expected result before operating
the chargers, and give the session a time and charging-energy budget. A limiter
change normally needs a useful current transition and stop/resume evidence; it
does not automatically need a vehicle swap, host handover or a complete charge.
Small fixes can use focused offline regressions and leave unrelated physical
questions for the next relevant development session. Record that limit instead
of expanding the work into an exhaustive campaign.

Use one initial run and, when useful, one focused repeat after an observed
failure. Do not keep replugging a reluctant vehicle or waiting for a rare event
to turn an incomplete case into a pass. Battery taper, unavailable feeds or
insufficient property load can make a case inconclusive. Preserve the observation
and continue when useful conditions become available. These local tools require
no paid model calls; repeated cloud queries are not needed for status recording.

## Prepare a bounded session

1. Record the application revision, charger firmware, actual car-to-charger
   pairing, current connection/session identities, relevant configuration and
   the chosen cases privately. A dashboard assignment is the result under test,
   not proof of the physical pairing. Verify the cars have enough charge
   headroom and no known target/timer that would prevent the intended draw.
2. Confirm the active command owner, native readiness and working device links.
   In a pair, record the runtime master and actual MQTT/OCPP connections. An IP
   address answering alone does not establish transfer of those connections.
   A host promotion or broker change is a separate explicitly authorized
   operation under the [pairing contract](../pairing.md), never observer setup.
3. Agree the permitted actions and final charging state. Record Automatic,
   Charge now, shared priority, native instructions and any temporary changes
   before the case. Use supported dashboard/native controls for the selected
   actions. The observer and auditor do not send charger commands, modify
   defaults, enable automation or perform host handover.
4. Start the observer before the trigger and verify it is recording. Keep a
   short baseline, then record the action's time and source in private case
   notes. Include a bounded settling window and independently observed end
   state. A timeout ends observation; it does not stop or restore equipment.
5. At completion or interruption, reconcile the agreed final state through
   supported controls. Confirm native readback and fresh physical effect.
   Do not replay earlier settings over a newer independent instruction or
   restore an override into another connection. If contact is lost, record the
   unresolved physical obligation instead of claiming cleanup succeeded.

Keep connection setup, credentials, raw observations, case manifests and reports
outside the checkout, in an owner-only directory (`0700`) with files `0600`.
Use a durable private directory for evidence worth retaining; `/tmp` may be
removed. Share only sanitized conclusions and synthetic examples in Git, issues
or pull requests. Do not paste raw status or MQTT payloads into terminal output.

## Observe and assess

The tools live in [`scripts/charging-physical/`](../../scripts/charging-physical/).

| Tool | Role |
| --- | --- |
| [`observe.js`](../../scripts/charging-physical/observe.js) | Bounded read-only application status, native MQTT and vehicle recording |
| [`audit.js`](../../scripts/charging-physical/audit.js) | Offline assessment of supported limiter cases using explicit expectations |
| [`independent.js`](../../scripts/charging-physical/independent.js) | Optional independent native Easee budget/stream evidence for disputed feed or allocation cases |

The tool regression tests use synthetic recordings and do not contact hardware.
Use each tool's `--help` output for supported options:

```sh
node scripts/charging-physical/observe.js --help
node scripts/charging-physical/audit.js --help
node scripts/charging-physical/independent.js --help
```

Prepare an external private connection file, for example this read-only status
endpoint reached through an already established local tunnel:

```json
{
  "status": {
    "url": "http://127.0.0.1:19090/api/status"
  }
}
```

The URL is the exact authenticated status endpoint, not the dashboard page.
Put any required existing authentication headers in `status.headers` in the
private file: the direct API uses its bearer authorization; an established
ingress session may use its own supported session header. A browser cookie
alone does not authenticate the direct API. The observer does not log in or
establish a tunnel. Optional native
recording uses `mqtt.url`, optional `username`/`password`, `shellyTopicPrefix`,
optional `replyPrefixes`, and optional `vehicles.bmw`/`vehicles.tesla` subscriptions.
Use only the relevant device/feed topics. Do not put credentials in command
arguments or copy installation settings into a committed example.

With the private configuration and owner-only output directory already prepared,
run a five-minute observation:

```sh
node scripts/charging-physical/observe.js --config /path/to/private/observer.json --out-dir /path/to/private/run --label trial --duration-seconds 300
```

`--interval-ms` sets status polling between 500 and 10000 ms; the default is
1000 ms. Duration is bounded to 1–1800 seconds, with a maximum of 128 MiB per
stream and 256 MiB total. The observer creates `trial-status.jsonl`, `trial-native.jsonl`,
`trial-vehicle.jsonl` and `trial-summary.json` as private files, without
overwriting an existing run. It reports bounded summaries instead of raw
household payloads. Wait for its `ready:true` summary after the first successful
status response and, when configured, MQTT subscriptions before triggering a
case. Keep the process attached while performing the chosen actions; after an
early interruption, reconcile the equipment as described above.

The observer records application status and, when configured, selected native
MQTT observations. Poll receipt time and device source time remain separate.
Polling the same reading does not refresh it. Retained MQTT messages, reconnects
and missing coverage must remain distinguishable from fresh physical evidence.
The offline auditor evaluates its supported case expectations against the saved
recording. It cannot recover an event that the observer missed or infer the
actual car pairing from a label supplied by the operator.

Audit the recorded limiter cases offline with a private manifest and output:

```sh
node scripts/charging-physical/audit.js --cases /path/to/private/run/cases.json --out /path/to/private/run/audit.json
```

The auditor supports `shelly-priority`, `balanced`, `easee-priority`,
`owned-pause-resume`, `fallback` and `native-stop`. Select the required kinds for
the feature instead of treating an omitted case as a pass. Use expectations
from the actual configuration and selected setup, including a declared current
target and a useful hold window. Its optional vehicle corroboration is for
Tesla connected to Shelly; it does not identify either vehicle. Other cases in
the matrix require recorded manual assessment.

For example, a focused fallback manifest has one explicitly selected case:

```json
{
  "version": 1,
  "observer": "trial",
  "requiredKinds": ["fallback"],
  "cases": [{
    "id": "fallback",
    "kind": "fallback",
    "expectedCurrentA": 12,
    "startAt": null,
    "endAt": null,
    "fallbackCauseEvidence": "independent.jsonl"
  }]
}
```

Replace `startAt` and `endAt` with recorded Unix epoch milliseconds and choose
the expected current from the actual configured cap and known tighter limits.
The null window deliberately reports **not exercised**. All four allocation
kinds require an explicit target of 0 or 6–16 A. Optional case bounds include
`settleMs`, `minHoldMs`, `minDistinctSamples` and `maxStatusGapMs`; defaults are
30 seconds settling, 10 seconds holding, three distinct samples and a maximum
five-second status gap. Do not loosen them after seeing a result merely to
obtain a pass. The files named by the observer label must exist alongside the
manifest, including an empty vehicle file when no vehicle feed was recorded.

This auditor currently checks paired operation with the command owner holding
the VIP and the peer reporting slave. It uses source-clocked native Easee meter
projections, not a separate OCPP wire capture. A native-stop case includes a
priority change and feed recovery; observing only the stop cannot pass that
whole case. The detailed report keeps individual checks and limits. Exit code
0 means all selected cases passed, 2 means an unqualified result, and 1 means
invalid or incomplete input. These exits do not actuate equipment.

### Additional independent load evidence

For a case involving disputed feed health or property/current measurements,
capture independent Easee evidence during the same window:

```sh
node scripts/charging-physical/independent.js --config /path/to/private/observer.json --status /path/to/private/run/trial-status.jsonl --out /path/to/private/run/independent.jsonl --duration-seconds 300
```

This optional observer uses a separate read-only property and charger-current
stream. The private connection file additionally supplies `easee.accessToken`
(an existing valid token), `chargerId`, `equalizerId`, `mainFuseA`, `marginA`
with a signed calibration margin. Copy the relevant installation assumptions into this
private test context; they do not replace runtime configuration. The tool does
not refresh tokens or request native Equalizer configuration. Keep
`independent.jsonl` private with the original observation clocks.
Ordinary current-response cases do not automatically need this additional
connection. A configuration read or a declaration that a feed was interrupted
is not by itself independent proof of the observed fallback cause.

`fallbackCauseEvidence` and `feedRecoveryEvidence` directly name this independent
observer's private JSONL recording. Each line retains its actual `at` receipt
time and observed `evidence.property`/`evidence.charger` health, including source,
connection and synchronization state. Use the recorder's rows as written; do not
construct a JSON array, invent health flags or substitute a proof file's creation
time. Fallback needs bad-feed evidence within its settled observation window.
Feed recovery needs a bad-to-good transition for the same role and source, with
connected, online and synchronized all true after recovery. Missing status rows
alone do not establish that event. Independent numerical comparisons additionally
need a healthy native source and fresh application status; an old status cache
cannot qualify the comparison.

Keep these evidence layers separate in the case record:

- **Request:** intended action/current, initiating control and dispatch time.
- **Acknowledgement:** the command was accepted, rejected or has an uncertain
  outcome. Acceptance alone is not readback or charging.
- **Native readback:** the charger independently reported the applicable setting
  or permission for the same equipment and connection.
- **Physical response:** fresh measured phase currents/power show charging,
  reduction or zero after the change. A pilot allowance is not actual draw.
- **Independent corroboration:** peer currents, property readings and applicable
  vehicle reports support the specific load-sharing or identification claim.

Retain source clocks, receipt clocks, units, quality, connection changes and
errors. For held values, record healthy synchronized feed or current native
readback evidence. Original older last-change times remain old; fresh command
confirmation and physical identification still require their own evidence.
The configured effective phase limits govern Shelly's calculation independently
of Equalizer allowance or native-budget readback. Do not assume Shelly phase
names correspond to Easee phase
names; the limiter uses the conservative common Shelly current described in
the [allocation contract](current-allocation.md#charger-2-current-allocation).

## Select physical cases

The matrix describes expected behavior, not a promise that every row can be
automatically assessed. Use recorded manual review for identification, SYS and
authority cases beyond the auditor's supported checks. Select only rows relevant
to the feature and available conditions.

| Case and trigger | Required observation and expected result |
| --- | --- |
| Baseline identification: BMW on Charger 1, Tesla on Charger 2; healthy vehicle feeds | Record fresh connection transitions and independent vehicle evidence. Confirm Charger 2's temporary 6 A setting **and measured draw**, bounded start/stop testing, correct assignments and restoration. A successful command or a vehicle label alone is insufficient. |
| Swapped vehicles: Tesla on Charger 1, BMW on Charger 2 | Confirm the physical swap independently. Fresh Tesla current/power must uniquely match one charger; BMW needs its own valid start/stop episode on the other. Matching both at 6 A is a valid inconclusive outcome; do not add retries solely to force a distinction. |
| Reachable charger with an unreachable peer | Exercise BMW and Tesla on each supported reachable adapter using the existing bounded attempt. Keep any known peer actions, schedules and restoration duties visible. For Tesla, record the matching positive current/power baseline, guarded pause request, native stop and physical zero, then fresh Tesla stopped/complete, zero-current and zero-power receipts within the correlation window. BMW retains its own source-timed evidence. Distinguish a real transport outage from candidate-only injected unavailability; never relabel the latter as an installed outage test. Keep candidate state in an isolated durable store when testing unpublished code, retain one command owner, and confirm restoration before returning ownership. |
| Replug after a completed or inconclusive attempt | Record actual disconnect/reconnect evidence, new connection scope and one new bounded attempt. Earlier overrides, consumed episodes and unrelated native instructions must not acquire authority for the new connection. A status poll without a physical transition is not a replug. |
| Naturally occurring Shelly `sys` permission cycle, during identification or later charging | Preserve ordered native false/true edges and source provenance. False holds physical charging and blocks replacement Start until fresh permission returns. True clears only that device hold. An interrupted pause cannot count as continuous BMW stop evidence; original attempt deadlines remain. **If no cycle occurs, this case is not exercised.** Do not manufacture a `sys` event by relabeling a manual action. |
| Charge now during BMW's identification pause | Trigger only after the recorded pause starts. Identification keeps its attempt and deadline, then restores normal current and continues charging under Charge now when permitted. The action does not cancel identification, establish vehicle identity or bypass a native restriction. |
| Ubuntu runtime master without BMW/Tesla publishers | Only use an explicitly authorized, already verified host setup. Confirm vehicle feeds are actually unavailable, charger links remain usable and defaults/manual session inputs support scheduling without an invented identity. Preserve the last known charge estimate only for its original identified connection. Vehicle-feed loss alone does not imply load-feed loss or require the 12 A limiter fallback. |
| Unusable property or charger-current evidence | Keep charger control reachable. Observe visible fallback and its configured cap (normally 12 A), still below any independently known tighter limit. Equalizer allowance and native-budget availability do not select fallback. This tests telemetry-loss fallback; loss of the controller or broker cannot prove autonomous charger fallback. |
| Charger 2 priority with enough household headroom | Shelly's entitlement excludes Charger 1 draw, up to the configured 16 A ceiling; Equalizer reduces Charger 1 as needed. Record both measured responses and property currents over the settling interval. A 16 A setting while the vehicle draws less qualifies setting control only, not sustained 16 A delivery or property protection. |
| Balanced and Charger 1 priority | With useful simultaneous demand, record the planned allocation or Charger 1 reservation and the corresponding Shelly setting. Vary Charger 1's draw without changing household demand or the plan; Shelly must retain its entitlement. Balanced accounts for charging needs and deadlines and need not split equally. |
| Insufficient headroom, then recovery | Observe Shelly's controller-owned balancing pause with fresh zero draw, then permitted resume after usable headroom reaches the supported minimum and dwell completes. Supported pilot settings are 6–16 A within configured limits; below minimum requests a pause, not a 1–5 A pilot. |
| Native Stop while running; repeat during an owned pause when relevant | Capture native provenance/readback and physical zero. Subsequent headroom, priority, Charge now or feed recovery must not clear an independently recognized native Stop. A same-value native Stop that cannot be distinguished from an existing pause remains an explicit evidence limitation. |
| Separately arriving measurements and feed recovery | Use the latest valid readings on healthy feeds immediately, in either arrival order. Record original clocks and temporary estimate differences; no later charger measurement or paired total is required. Genuine outages or contradictory values select fallback. Repeated cached observations do not renew measurement clocks or prove physical effects. |
| Unplugged allowance recording | With each car absent, record changing numeric native Charger 1 allowance and calculated Charger 2 capacity when sources are healthy. Keep active peer commitments, show no limiter instruction applied for Charger 2, and confirm the observation does not dispatch commands. Do not fill earlier history gaps. |
| Optional limiter history/UI check | Compare bounded recorded transitions with chart/API modes, allowance and separate native readback. Stable observations extend coverage without periodic state rows; gaps stay Unknown. History agreement establishes recording semantics, not additional physical current proof. |

Start/stop patterns are not sufficient for joint identification when the vehicle
evidence remains ambiguous. See [vehicle assignment](identification.md#vehicle-assignment)
for the exact positive-evidence rule. A rare SYS cycle, a willing car at 16 A,
and a particular property-load combination are separate opportunities, not
mandatory conditions for finishing unrelated development work.

## Report outcomes without extending the campaign

| Outcome | Meaning |
| --- | --- |
| Passed | The selected expectation has the required independent evidence in its declared window. State exactly what passed. |
| Failed | Valid observations contradict that expectation. Retain the relevant interval and add a focused synthetic regression when appropriate. |
| Inconclusive | The case was attempted, but taper, stale/missing readings, interference or insufficient duration prevent the claimed conclusion. |
| Not exercised | The trigger or required physical setup did not occur, or the case was outside the selected scope. |

Report the revision, selected cases, observation duration, outcomes and final
state without household identifiers. Separate software validation, command
confirmation and physical qualification. A native Stop readback without fresh
zero draw is not a completed stop qualification. A setting-control pass at
16 A does not become a sustained-draw pass because the vehicle later tapers.

Keep unfinished feature-relevant questions in the task's issue or pull request
with the useful next setup. Re-run only the affected case after a fix unless a
new concern justifies broader testing. Firmware updates, forceful vehicle wakeup,
host changes and unattended outage experiments are separate work, not automatic
ways to make this development run pass.
