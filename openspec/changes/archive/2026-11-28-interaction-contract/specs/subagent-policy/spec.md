## MODIFIED Requirements

### Requirement: Advisory roles
An entry with `advisory: true` SHALL attach the role's findings to the payload of the phase's next human gate and MUST NOT refuse a tick, block a gate or move the flow. Its result MAY make a `self` gate ask the human, through phase-gates "Self gate escalation"; that is not a block.

#### Scenario: Advisory spec review
- **WHEN** the `define` spec reviewer reports a `CRITICAL` finding
- **THEN** the define gate's payload lists that finding, and the gate can still be requested

#### Scenario: Advisory finding escalates the plan gate
- **WHEN** the `plan` reviewer reports a `CRITICAL` finding at HEAD and the plan gate is self
- **THEN** `spec_gate plan` sends a human gate request whose payload lists that finding, and does not refuse
