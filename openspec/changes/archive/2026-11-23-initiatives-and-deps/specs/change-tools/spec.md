## MODIFIED Requirements

### Requirement: Change start refusals
`change_start #N` MUST refuse, without creating a branch, when the tree is dirty, the issue is not an open `livespec` change, the issue already has a `Branch` line and no reconciliation applies, the change is parked (discovered-dependencies "Parked state"), or a dependency of the change is not merged (change-initiatives "Change dependencies and readiness"). The unmet-dependency refusal SHALL name each dependency with its state (`open` or `abandoned`) and say that a human runs `change_start #N` once they merge. When a dependency cannot be read from the forge, the tool MUST refuse and name it.

#### Scenario: Dirty tree
- **WHEN** the working tree has uncommitted changes
- **THEN** the tool refuses and creates no branch

#### Scenario: Already started
- **WHEN** the issue already has a `Branch` line and no local `livespec/<name>` branch with `livespecBase` exists
- **THEN** the tool refuses and changes nothing

#### Scenario: Dependency not merged
- **WHEN** #35 has `Depends: #34`, #34 is open, and `change_start #35` is called
- **THEN** the tool refuses, names #34 as open, and creates no branch

#### Scenario: Dependency merged
- **WHEN** #34 is closed with a merged pull request and `change_start #35` is called on a clean tree
- **THEN** the branch `livespec/<name>` is created and `Branch` and `Base` are recorded

#### Scenario: Abandoned dependency
- **WHEN** #34 is closed and its pull request was not merged
- **THEN** `change_start #35` refuses and names #34 as abandoned
