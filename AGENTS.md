# Repository guidance

ST-MQ monitors household energy and controls heating and charging. Raspberry Pi 5 /
Home Assistant and standalone Linux are supported deployment targets. Ordinary
local development uses synthetic, isolated fixtures; it has no household authority.

## Engineering discipline

<a id="codebase-wide-consistency"></a>
<a id="scoped-validation-and-reuse"></a>

Work with sound engineering discipline: understand the underlying problem, follow
established project conventions, and make the smallest complete change. Examples
illustrate problems rather than define their entire scope. Keep affected behavior
consistent throughout the codebase, preserve justified differences, respect
explicit scope limits, and verify appropriately. Finish the authorized work and
report verified outcomes and remaining limits.

## Commands and checks

Node.js **22.19 or newer** is required. These commands are available checks, not a
sequence required for every task. Choose checks relevant to the change; reuse
valid results for unchanged inputs.

| Purpose | Command |
| --- | --- |
| Install dependencies | `npm ci` |
| Build the frontend | `npm run build` |
| Routine offline tests | `npm test` |
| Extended offline tests | `npm run test:extended` |

One test file through the normal offline runner (replace the example path):

```sh
node --input-type=module -e 'import { runOfflineTests } from "./scripts/test-offline.js"; process.exitCode = await runOfflineTests({ files: ["test/energy-checks-worker.test.js"] });'
```

[Development validation](docs/development-validation.md#selecting-and-reusing-validation)
provides case selection, platform profiles, browser checks and release qualification.
[Contributing](CONTRIBUTING.md) covers hooks, issue triage and release conventions.
[Shared UI conventions](docs/ui-layout.md) cover wording, presentation and
interaction changes.

## Authority and scope

The foundations below govern repository decisions; linked contracts own their
binding details. Read the contracts relevant to the task. Historical records,
examples, existing code and passing tests do not amend policy. These foundations
protect behavior and ownership, not every identifier, threshold or implementation
choice. Ordinary compliant work needs no additional approval.

<a id="conflicting-requests"></a>

### Handling foundation conflicts

Before departing from a foundation, explain the affected rule, concrete conflict
and consequences, and a compliant alternative where practical. Obtain explicit,
informed owner approval; a routine request, silence or general autonomy is not a
waiver. Honor specific approval already given without asking again. Pause only the
conflicting work, not independent authorized work; do not weaken contracts or
tests to bypass the decision. Lasting amendments update the foundation and affected
contracts, implementation and validation together, with reason/scope in the issue,
PR or commit. One-task exceptions stay limited. Ask only about material unresolved
ambiguities, not routine implementation choices.

<a id="f1"></a>

### F1. One current development contract before v1.0.0

Before the first actual v1.0.0 production release, maintain one current internal,
persisted, configuration and API contract. Remove obsolete development support;
reject unsupported or malformed databases **before mutation**, never by automatic
migration or reset. Reject unknown/retired inputs instead of translating or
ignoring them. The sole historical format support is read-only v0.7.5 `easee.csv`
and `st-mq.csv` import. Preserve current restart, backup, replay, restoration and
supported external-protocol behavior. Installation-only conversion approvals are
closed exceptions, not runtime permissions. Details and exact exceptions:
[current formats](docs/reconstruction-and-versioning.md#current-formats-and-installation-exceptions).

<a id="f2"></a>

### F2. Reconstructible learning and reversible corrections

Home learning must replay exactly from the supported committed journal, seed,
configuration and correction revisions with matching software/algorithm.
Checkpoints are replaceable caches. Retain required inputs; narrowing reconstruction
or adding comprehensive decision archives needs owner agreement. Corrections keep
original evidence and publish a complete caught-up result atomically while control
remains available, including across restart. Failure retains the previous model.
Details: [reconstruction and corrections](docs/reconstruction-and-versioning.md).

<a id="f3"></a>

### F3. Explicit configuration and state ownership

Configuration owns defaults; dashboard choices, scoped overrides, native device
state and restoration duties have distinct owners and lifetimes. Restart does not
turn a session edit into a default, and new equipment inherits no old authority.
Shared defaults use sparse installation overrides. Home, Garage, charging and
Caravan permissions remain independent; environment scope is not permission.
Details: [configuration ownership](docs/configuration.md#where-a-setting-belongs),
[Home controls](docs/automation-and-manual-control.md),
[charging policies](docs/charging/policies.md), [Garage](docs/garage.md) and
[Caravan](docs/caravan-dehumidifier.md).

<a id="f4"></a>

### F4. Honest evidence and historical meaning

Distinguish observation, assumption, estimate, forecast, request, acknowledgement,
native readback and physical outcome. Preserve provenance, units, original clocks,
quality and historical meaning. Unknown is not zero, off or success; valid zero
and false remain valid. Caches/reconnects create no fresh evidence and corrections
fill no real gaps. Learning validation cannot leak future evidence into training
or forecasts. Keep original forecasts separate from corrected assessments and
avoid double-counted energy.
Details: [time/evidence](docs/time-evidence.md), [recording](docs/recording.md) and
[learning](docs/learning-and-control.md).

<a id="f5"></a>

### F5. Explicit control authority and restoration

Only the authorized owner may command equipment; promotion is explicit, never a
timeout fallback. Copies, checkpoints and read-only roles grant no authority.
Require current equipment/session identity, live readiness and commissioning;
owner approval alone is not device capability. Preserve native protection,
independent instructions and durable restoration across failure/restart/model
changes. Fresh readback, acknowledgement and physical proof remain distinct.
A coding request does not authorize deployment, household probing or live commands;
honor applicable authorization already given. Details:
[pairing](docs/pairing.md), [control/restoration](docs/learning-and-control.md),
[Garage adapter](docs/garage-adapter.md) and
[charging execution](docs/charging/execution-and-recovery.md).

<a id="f6"></a>

### F6. Cost, comfort and service together

Assess attributable cost across complete preheat, reduction and recovery at
comparable comfort and thermal end states, including auxiliary energy. Keep normal
operation available; cheap timing or reduced service is not proof of savings.
Do not create unsafe conditions to obtain training evidence. Home uses one learned
occupied reference and a fixed weighted indoor average, bounded control-only room
estimates and native Away protection under the owner-approved 2026-10-07 policies.
Details:
[learning/control](docs/learning-and-control.md#planning-and-recovery),
[temperature policy](docs/temperature-sensors.md#normal-temperature-reference) and
[firewood estimates](docs/fireplace.md).

<a id="f7"></a>

### F7. Responsive local operation

Both deployment targets retain the same core behavior and data semantics, with
practical local learning/control and no GPU, permanent cloud model or routine paid
AI requirement. Handle supported external-service outages conservatively. Bound
memory, caches and background/history work so control, ingestion and UI remain
responsive; resource targets do not waive F2/F4 evidence. Details:
[startup](docs/startup.md) and [recording](docs/recording.md).

<a id="f8"></a>

### F8. Private configuration and personal data

Keep secrets and household data outside Git and diagnostic output; use invented
fixtures. Private configuration stays outside the checkout with private file
permissions. Repository encryption is retired; existing encrypted history stays
opaque, and its fixed inventory admits no new private data or keys. Exposure stops
publication of affected history and requires coordinated repair and credential
rotation where applicable. Exact storage, handling and incident policy:
[secret handling](docs/secret-handling.md).

<a id="f9"></a>

### F9. Converge toward production reliability

Prioritize reliability and a smaller bug surface over novelty. Reuse established
pairing, recovery, publication and authority paths; keep one implementation/owner
per responsibility without broad rewrites. Favor focused fixes, especially near
release. Architectural changes need a demonstrated problem or measured limit that
a smaller fix cannot address.

From the actual v1.0.0 production baseline, every later production release owns a
tested safe upgrade from its predecessor, preserving history, identity, roles and
restoration. Older production backups use documented tested intermediate paths;
unsupported development formats gain no compatibility promise. Details and the
owner's lasting 2026-10-07 approval: [production upgrades](docs/pairing.md#software-upgrades).

## Owner workflow

Commit completed intended repository changes before the final response unless the
owner explicitly says not to. Commits are authorized by default; stage explicit
paths, preserve unrelated work, and create no empty commits. Coordinate delegated
Git work so staging/commits have one owner. Use the repository hooks without
bypassing failures; one successful final-index secret check is sufficient for an
ordinary commit. Report the commit and verification outcome. Committing does not
authorize pushing or deployment; push only when requested. Contributor procedures
remain in [CONTRIBUTING.md](CONTRIBUTING.md).
