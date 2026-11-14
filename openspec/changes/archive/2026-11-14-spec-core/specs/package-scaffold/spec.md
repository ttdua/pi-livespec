## MODIFIED Requirements

### Requirement: Version command
The bare `/livespec` command (no arguments) SHALL print the package version from `package.json` and SHALL perform no other action. Subcommands (`validate`, `migrate-openspec`) are defined by their own capabilities; an unknown subcommand SHALL print usage and change nothing.

#### Scenario: Command prints the version
- **WHEN** the user runs `/livespec`
- **THEN** the output contains the `version` value of `package.json`

#### Scenario: Command has no side effects
- **WHEN** the user runs `/livespec` with no arguments
- **THEN** no file, forge or session state is changed

#### Scenario: Unknown subcommand
- **WHEN** the user runs `/livespec nonsense`
- **THEN** the output is a usage message listing `validate` and `migrate-openspec`, and no file is changed
