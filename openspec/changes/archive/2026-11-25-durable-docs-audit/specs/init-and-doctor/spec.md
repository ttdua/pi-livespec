## MODIFIED Requirements

### Requirement: Subcommand routing
`/livespec` SHALL route the subcommands `init`, `doctor`, `next`, `skills` and `audit` in addition to the existing `validate` and `migrate-openspec`. The bare command and unknown subcommands MUST keep the behavior of the version command requirement, and the usage text SHALL list every subcommand.

#### Scenario: Usage lists subcommands
- **WHEN** the user runs `/livespec nonsense`
- **THEN** the usage lists `validate`, `migrate-openspec`, `init`, `doctor`, `next`, `skills` and `audit`, and nothing changes

#### Scenario: Audit routed
- **WHEN** the user runs `/livespec audit` in an initialized project
- **THEN** the drift audit runs and its report is shown
