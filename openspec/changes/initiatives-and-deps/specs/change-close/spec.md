## MODIFIED Requirements

### Requirement: Closed without merge
When the pull request is closed and not merged, the phase SHALL NOT move. When a human reopens the pull request, the flow SHALL continue with that pull request. `change_close --abandon <reason>` SHALL accept a change in any phase whose pull request is closed and not merged, or a change with no `PR` line whose latest valid `new-dependency` gate result chose `D` with action `drop`. It SHALL refuse an empty reason, post the `close-summary` with the reason, close the issue without ticking the initiative, and emit `livespec:change-closed` marked abandoned. An abandoned change SHALL stay unchecked in its initiative, and the changes that depend on it SHALL stay not ready (change-initiatives "Change dependencies and readiness") until an approved initiative amendment removes it from their `Depends`; the same amendment may remove its entry, which closes the initiative when every remaining entry is checked (change-initiatives "Initiative amendment").

#### Scenario: Pull request closed unmerged
- **WHEN** a human closes pull request 41 without merging
- **THEN** the change stays in its phase and the next step says to reopen #41 on the forge or run `change_close --abandon <reason>`

#### Scenario: Abandoned change has nothing left to do
- **WHEN** the change was abandoned in `ship` and its issue is closed
- **THEN** the next step no longer asks to reopen or abandon the pull request

#### Scenario: Abandon
- **WHEN** `change_close --abandon "superseded by #50"` runs for that change
- **THEN** the `close-summary` holds the reason, the initiative entry stays unchecked, the issue is closed, and `livespec:change-closed` is emitted with `abandoned: true`

#### Scenario: Drop after a discovered dependency
- **WHEN** change #40 has no `PR` line, its `new-dependency` gate was approved with choice D and action `drop`, and `change_close --abandon "wrong direction"` runs
- **THEN** the `close-summary` holds the reason, #40 is closed, and `livespec:change-closed` is emitted with `abandoned: true`

#### Scenario: Abandon refused without a pull request or drop
- **WHEN** change #40 has no `PR` line and no `new-dependency` result chose D with `drop`
- **THEN** `change_close --abandon "x"` refuses and writes nothing
