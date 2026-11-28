## MODIFIED Requirements

### Requirement: Self gate escalation
A `self` phase gate listed in the `gate-escalation` config's `phases` SHALL consult `decide("gate-escalation", facts)` after its checks and refusals; a `human` phase gate MUST NOT. On `human` without a valid `briefing` it MUST refuse naming `briefing`, writing nothing. Otherwise it SHALL append the `decision` `gate-escalation.<phase>` to the ledger unless the latest has equal facts, then pass, or send a human gate, with `waive` when a waivable check fails, whose payload names the reason.

#### Scenario: Plan without triggers passes alone
- **WHEN** the change is in `plan`, every check passes, the plan reviewer's advisory review at HEAD has no `CRITICAL` finding, no unit is tagged `security` or `migration`, and `spec_gate plan` runs without a briefing
- **THEN** a `gate-escalation.plan` decision ledger entry with outcome `self` is appended, a `gate` comment with `by: livespec` records the locked digests, the change moves to `build`, and no request is sent

#### Scenario: Waived size limit asks the human
- **WHEN** the change is in `plan`, `size-limits` fails, and `spec_gate plan` runs with a briefing recommending `waive`
- **THEN** a `gate-escalation.plan` decision ledger entry with outcome `human` names `size-limits`, and a `gate:plan` request offering `waive` is sent

#### Scenario: Security unit asks the human
- **WHEN** the change is in `plan`, every check passes, U2 is tagged `security`, and `spec_gate plan` runs with a briefing recommending `approve`
- **THEN** a `gate:plan` request is sent and its payload names U2's `security` tag as the reason

#### Scenario: Critical advisory finding asks the human
- **WHEN** the plan reviewer's advisory review at HEAD reports a `CRITICAL` finding and `spec_gate plan` runs with a briefing
- **THEN** a `gate:plan` request is sent

#### Scenario: Escalated gate without a briefing
- **WHEN** U2 is tagged `migration` and `spec_gate plan` runs without a briefing
- **THEN** the tool refuses, names `briefing`, sends no request, and appends no `gate-escalation` decision

#### Scenario: Project keeps a human plan gate
- **WHEN** `.pi/livespec/flow.yaml` sets phase `plan` to `gate: human` and no trigger holds
- **THEN** `spec_gate plan` requires a briefing and sends a `gate:plan` request, and no `gate-escalation` decision is appended

#### Scenario: Unlisted self gate unchanged
- **WHEN** the change is in `shape` and `spec_gate shape` runs
- **THEN** no `gate-escalation` decision is appended and the self gate passes as before
