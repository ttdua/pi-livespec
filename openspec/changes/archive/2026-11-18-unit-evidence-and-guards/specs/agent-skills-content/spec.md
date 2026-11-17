## MODIFIED Requirements

### Requirement: No upgrade during work in progress
No upgrade MUST be installed while work is in progress, whether automatic or through `update` or `pin`. Work is in progress when any open change of the project is in phase `build` and has a started unit, as unit-evidence "Work in progress from started units" defines. A change in `build` with pending units and no started unit MUST NOT count. `rollback` SHALL remain allowed as recovery from a bad commit.

#### Scenario: Build in progress
- **WHEN** an open change is in `build` with a started unit and upstream has a compatible new commit
- **THEN** nothing is installed and the skip reason is recorded

#### Scenario: Pending units without a started unit
- **WHEN** the only open change is in `build` with pending units and no started unit, and upstream has a compatible new commit
- **THEN** the upgrade is installed

#### Scenario: Manual update refused in build
- **WHEN** work is in progress and the user runs `/livespec skills update` or `/livespec skills pin <sha>`
- **THEN** the command refuses, names the change in progress, and changes nothing

#### Scenario: Rollback allowed in build
- **WHEN** work is in progress and the user runs `/livespec skills rollback`
- **THEN** the rollback is performed
