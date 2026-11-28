## MODIFIED Requirements

### Requirement: Escalation in the next step
Before a gate that "Self gate escalation" covers is requested, the next step SHALL forecast its outcome from the same facts, writing nothing; gate-only checks that have not run are left out. On `human` it SHALL say the gate will ask the human, name the reasons, and say to pass a briefing; it SHALL name a missing advisory review's dispatch first. On `self` it SHALL say the gate can pass, and SHALL add "unless a gate-only check fails" while any gate-only check of the gate has no valid last result (flow-engine "Named checks over LS-02 validators"); for a gate with an unkeyed gate-only check the caveat therefore always stays.

#### Scenario: Next step names the escalation
- **WHEN** the change is in `plan`, every check passes and U1 is tagged `security`
- **THEN** the next step says the plan gate will ask the human because U1 is tagged `security`, and to pass a briefing, and no comment is written

#### Scenario: Failing waivable check names the escalation
- **WHEN** the change is in `plan`, `size-limits` fails and every other check passes
- **THEN** the next step says the plan gate will ask the human because `size-limits` fails, and that the human can waive it or it can be fixed first

#### Scenario: Failing gate-only result names the escalation
- **WHEN** the change is in `plan`, no trigger holds, and `spec_gate plan` ran in this session with `verify-red-on-base` reporting an error for U2 and refused for a missing briefing
- **THEN** the next step says the plan gate will ask the human because `verify-red-on-base` fails, and to pass a briefing

#### Scenario: No gate-only result keeps the caveat
- **WHEN** the change is in `plan`, no trigger holds, and `verify-red-on-base` has no valid last result for the current `Base` and unit digests
- **THEN** the next step says "Checks pass; the plan gate can pass unless a gate-only check fails."

#### Scenario: Passing gate-only result drops the caveat
- **WHEN** the change is in `plan`, no trigger holds, and `verify-red-on-base` has a valid last result with no error for the current `Base` and unit digests
- **THEN** the next step says "Checks pass; the plan gate can pass."
