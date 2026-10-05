# Charging policies and ownership

[Charging overview](../charging.md) · [User guide](user-guide.md) · [Code map](architecture.md)

These are the deliberate choices behind charging behavior. The linked subsystem
contracts own the precise guards, timing, evidence and recovery mechanics.
[Repository foundations F3–F5](../../AGENTS.md#f3) remain governing; this page does
not create a separate permission model.

## Behavior choices and their consequences

| Choice | Reason and consequence | Detailed contract |
| --- | --- | --- |
| Two physical charger roles, independent vehicle feeds | Energy belongs to the charger; BMW or Tesla can use either. Vehicle power never becomes another household electricity contribution. | [Architecture](architecture.md), [evidence](evidence-and-reporting.md) |
| Automatic scheduling and live current allocation have separate ownership | Turning Automatic off does not disable Charger 2 load adjustment. Charge now still respects current, native and electrical restrictions. | [Current allocation](current-allocation.md) |
| New confirmed connections can take automatic control when Automatic is enabled | Earlier native instructions are superseded for that new session. Later external instructions have priority; an ordinary preference toggle does not reclaim an established session. | [Takeover](execution-and-recovery.md#automatic-takeover-and-native-instructions) |
| Explicit Use automatic is a new instruction | It supersedes supported observed native instructions, enables Automatic and returns to price scheduling. It can result in waiting for a cheaper period. | [Takeover](execution-and-recovery.md#automatic-takeover-and-native-instructions) |
| Identification needs positive evidence | An absent Tesla match never identifies BMW. Missing or ambiguous evidence leaves the vehicle unresolved while default/session inputs can support scheduling. | [Identification](identification.md) |
| Active identification is bounded and retains restoration duties | Temporary charging/current changes gather evidence within one attempt. Restart, polling and replanning do not replenish the attempt; passive matching may continue afterward. | [Attempt lifecycle](identification.md#attempt-lifecycle-and-readiness) |
| Unknown future current uses a maximum-available-current forecast within applicable limits | Missing current evidence alone should not discard a feasible economic schedule. The optimistic delivery estimate grants neither electrical headroom nor command readiness. | [Planning assumption](planning.md#maximum-available-current-assumption) |
| Cost selection considers both requests and shared supply | Priority resolves contention; it is not a reason to buy more expensive energy when both requests can otherwise be satisfied. Forecast feasibility remains distinct from guaranteed completion. | [Joint planning](planning.md#planning-and-equalizer) |
| Native protection and independent instructions keep their authority | Faults, authorization, vehicle restrictions and known limits remain binding. The explicitly approved Shelly system-permission classification has a narrow documented scope and residual actor ambiguity. | [System permission exception](execution-and-recovery.md#shelly-system-permission-changes) |
| Observations, instructions and assessments remain distinct | Acknowledgement is not readback; readback is not draw; estimated battery progress is not a vehicle measurement. Guided inputs assess behavior without controlling it. | [Evidence](evidence-and-reporting.md), [guided assessments](guided-assessments.md) |
| One current development contract | Unsupported configuration and state are rejected before mutation. Restart/restoration duties remain supported within the current format; historical CSV import is a separate boundary. | [Restart](execution-and-recovery.md#restart-and-compatibility), [F1](../../AGENTS.md#f1) |

## Who owns each value

| Value or state | Owner and lifetime | What ends or replaces it |
| --- | --- | --- |
| Starting charge, target, usable capacity and ready-by defaults | Shared configuration with sparse vehicle defaults | Reviewed configuration application |
| Automatic charging | Durable dashboard choice bound to the physical equipment | Dashboard edit or changed equipment identity |
| Shared charger priority | One durable dashboard choice bound to both chargers | Dashboard edit or replacement of either charger |
| Session battery/ready-by edits | Current confirmed physical connection | Unplug; a newer applicable vehicle charge reading can supersede a manual charge anchor |
| Charge now | Explicit action for the current connection | Turning it off returns to Automatic; unplug ends its scope |
| Native schedules, stops and current choices | Observed native device instructions | An applicable later native instruction or explicitly authorized takeover |
| Shelly adjustable current with load balancing enabled | Controller allocation, constrained by any later external choice for the current physical connection | Unplug or explicit **Use automatic** ends that external current choice; a carried-over initial setting is not a permanent cap |
| Identification attempt and temporary settings | Bounded attempt with saved equipment/session scope | Completion, expiry or supersession; unresolved restoration remains an obligation |
| Vehicle readings and device metadata | Their original observed source, clock and quality | New admissible evidence; a status poll cannot refresh their origin |
| Guided-assessment assumptions | Exact assessment and physical connection | Assessment edits or closure; never a production request |
| Saved session reports | Historical report in the current database | Explicit removal or applicable unsaved-report expiry; no control authority |

## Documentation maintenance

A policy change must name the governing foundation and update the owning contract,
its producers and consumers, relevant validation, and this summary together.
Installation guides link to shared rules instead of maintaining another copy of
their formulas or lifecycle. Preserve approved exceptions and known evidence
limits explicitly. A synthetic test or firmware label does not silently broaden
physical qualification.
