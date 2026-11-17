## MODIFIED Requirements

### Requirement: Config files
Project config SHALL live at `.pi/livespec/config.yaml` and user config at `~/.pi/agent/livespec/config.yaml`.
- Project config SHALL accept the forge keys already defined by forge detection, `integrationBranch`, `interaction.adapter`, `verify.setup` and `verify.timeout`.
- User config SHALL accept `agentSkills.channel` and `interaction.adapter`.
- `interaction.adapter` MUST be a list of adapter names. Any other value, and any unknown adapter name, MUST be reported as a warning.
- `verify.setup` MUST be a string, and `verify.timeout` a positive integer number of seconds with default 600. Any other value MUST be reported as a warning, and the default SHALL be used.

Unknown keys MUST be reported as warnings. A project config that sets `agentSkills.channel` MUST be reported by doctor, because the clone is shared by all projects.

#### Scenario: Unknown key
- **WHEN** the project config has the key `integrationBrnach`
- **THEN** a warning names the unknown key

#### Scenario: Interaction adapter list
- **WHEN** the project config sets `interaction: { adapter: [forge, in-session] }`
- **THEN** the loaded project config has the adapter chain `[forge, in-session]` and no warning

#### Scenario: Unknown adapter name
- **WHEN** the user config sets `interaction: { adapter: [plannotator] }`
- **THEN** a warning names `plannotator` as an unknown adapter, and the chain falls back to `[in-session]`

#### Scenario: Verify settings
- **WHEN** the project config sets `verify: { setup: "bun install --frozen-lockfile", timeout: 120 }`
- **THEN** the loaded project config has that setup command and a timeout of 120 seconds, and no warning

#### Scenario: Invalid verify timeout
- **WHEN** the project config sets `verify: { timeout: -5 }`
- **THEN** a warning names `verify.timeout` and the timeout is 600 seconds
