## ADDED Requirements

### Requirement: Loadable pi package
The package SHALL declare a `pi` manifest in `package.json` whose `extensions` list names the extension entry point, so pi loads the extension without a build step.

#### Scenario: Pi loads the extension
- **WHEN** pi starts with the package installed
- **THEN** the extension loads without error and registers the `/livespec` command

#### Scenario: Manifest names a real entry point
- **WHEN** the manifest is read
- **THEN** every path in `pi.extensions` exists in the repository

### Requirement: Dependency policy
The package SHALL declare `@earendil-works/pi-coding-agent` as a peer dependency with range `*` and `yaml` as its only runtime dependency. Any other runtime dependency MUST have maintainer approval before it is added.

#### Scenario: Peer dependency range
- **WHEN** `package.json` is read
- **THEN** `peerDependencies["@earendil-works/pi-coding-agent"]` is `*`

#### Scenario: Runtime dependencies
- **WHEN** `package.json` is read
- **THEN** `dependencies` contains exactly `yaml`

### Requirement: Version command
The `/livespec` command SHALL print the package version from `package.json` and SHALL perform no other action.

#### Scenario: Command prints the version
- **WHEN** the user runs `/livespec`
- **THEN** the output contains the `version` value of `package.json`

#### Scenario: Command has no side effects
- **WHEN** the user runs `/livespec`
- **THEN** no file, forge or session state is changed

### Requirement: CI gate
The repository SHALL run typecheck and tests in GitHub Actions on every push and every pull request.

#### Scenario: Workflow triggers
- **WHEN** the workflow file is read
- **THEN** it triggers on `push` and `pull_request` and runs the typecheck and test scripts

#### Scenario: Failing check blocks
- **WHEN** typecheck or a test fails
- **THEN** the workflow run fails
