## MODIFIED Requirements

### Requirement: Waivable checks
`registerCheck(name, fn, { waivable: true })` SHALL mark a check as waivable. When only waivable checks fail at a human gate, the request MUST offer a `waive` option, and the human MAY waive them in the same answer. A plain approve MUST NOT pass a gate with a failing waivable check. Waived checks SHALL be listed in the gate comment's `waivers`. A check waived by the phase's valid gate result MUST NOT hold the next step: the approved gate then moves the change as "Gate outcomes" says, so it moves to the successor except at `ship`, unless a rule earlier in "Next step precedence" holds it. A `self` gate MUST NOT pass with a failing check, waivable or not.

#### Scenario: Waive at the gate
- **WHEN** a test registers waivable check `size-limits` for `plan`, it fails, and the human chooses `waive`
- **THEN** the gate is approved, its comment lists `size-limits` under `waivers`, and the change moves to `build`

#### Scenario: Waived ship gate stays in ship
- **WHEN** a test registers waivable check `size-limits` for `ship`, it fails, and the human chooses `waive` at the ship gate
- **THEN** the gate is approved with `size-limits` under `waivers`, the change stays in `ship`, and the next step says to run `change_ship`

#### Scenario: Approve without waiving
- **WHEN** a waivable check fails and a writer comments `/livespec approve`
- **THEN** the command is ignored with a warning that the failing check must be waived with `choose waive`

### Requirement: Gate outcomes
On `approved` or `approved_with_notes`, a phase gate SHALL move the change to the successor through `advancePhase`, except at `ship`, where no phase moves. The move SHALL be derived from the valid gate result of the current phase, so a failed move is retried on the next refresh. The valid gate result is the latest own `gate` comment for that phase that is newer than the latest own `stale` comment listing the phase. When that comment is superseded, there is no valid result, and an older one MUST NOT be used. An older approval MUST NOT reopen a phase after a newer result or `stale` comment. On `changes_requested`, the plugin SHALL write a `stale` comment that lists every phase after the gated one, and the phase MUST NOT move. On `dismissed`, nothing moves, and the next step MUST tell the agent to ask the human how to proceed.

#### Scenario: Define approved
- **WHEN** the define gate is approved in session
- **THEN** the change moves to `plan`

#### Scenario: Old approval not reused after a cascade
- **WHEN** define and plan were approved, an answer in `build` sends the change back to `define`, and every define check passes
- **THEN** the change stays in `define` and the next step says it is ready for the `define` gate

#### Scenario: Superseded result does not fall back
- **WHEN** an older define gate is approved and the latest define gate result is superseded
- **THEN** the change stays in `define` and the next step asks to request the gate again

#### Scenario: Failed move retried
- **WHEN** the define gate comment is written but moving the label fails
- **THEN** the next refresh moves the change to `plan` without another approval

#### Scenario: Ship approved
- **WHEN** the ship gate is approved
- **THEN** the gate comment is written, the change stays in `ship`, and the next step says to run `change_ship`

#### Scenario: Changes requested
- **WHEN** the define gate gets `changes_requested` with notes
- **THEN** the change stays in `define`, a `stale` comment lists `plan`, `build`, `review`, `ship` and `close`, and the next step asks to revise and request the gate again

#### Scenario: Dismissed
- **WHEN** the plan gate is dismissed
- **THEN** the change stays in `plan` and the next step says to ask the human how to proceed
