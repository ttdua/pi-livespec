## MODIFIED Requirements

### Requirement: New dependency tool
`new_dependency` SHALL take the evidence, an optional unit id, and a drafted proposal for each option:
- A: the prerequisite change's name, short Proposal and optional `Depends` on existing changes;
- B: the units to add;
- C: the stub amendment and the follow-up change's name and short Proposal;
- D: the action `shape` or `drop` and the reason.

It SHALL send a blocking request for the named gate `new-dependency`, registered with `registerGate` and decided by a human. The request SHALL offer the options `A`, `B`, `C` and `D`, plus `split` when at least one unit is done and one is not, each with a livespec-written description of what follows, and SHALL carry the agent's required briefing with `recommended` and `rationale` (approver-adapters "Interaction contract"); without one the tool MUST refuse, naming `briefing`, writing nothing. The recommended option SHALL be listed first; no option is labelled as a default. The review payload SHALL show each option's draft, the evidence wrapped as untrusted, and, for A without an initiative, the initiative that approval would create. It MUST refuse, writing nothing, in a child session, when a `gate:new-dependency` request is pending, when option A's draft is invalid or would create a `Depends` cycle, or when the `discovered_deps` cap blocks. `spec_gate new-dependency` MUST refuse and name `new_dependency`.

#### Scenario: Gate sent with default A
- **WHEN** U3's implementer returned `BLOCKED` with `missing-prerequisite` and `new_dependency` runs with drafts for A to D
- **THEN** with a briefing recommending A, one pending `gate:new-dependency` request offers A first, recommended, then B, C and D, each described

#### Scenario: Split offered at the finished boundary
- **WHEN** U1 and U2 are done, U3 is pending, and `new_dependency` runs
- **THEN** the request also offers `split`

#### Scenario: New dependency without a briefing
- **WHEN** `new_dependency` runs with valid drafts and no briefing
- **THEN** the tool refuses, names `briefing`, and writes nothing
