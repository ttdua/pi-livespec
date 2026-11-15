## MODIFIED Requirements

### Requirement: Config files
Project config SHALL live at `.pi/livespec/config.yaml` and user config at `~/.pi/agent/livespec/config.yaml`.
- Project config SHALL accept the forge keys already defined by forge detection, `integrationBranch` and `interaction.adapter`.
- User config SHALL accept `agentSkills.channel` and `interaction.adapter`.
- `interaction.adapter` MUST be a list of adapter names. Any other value, and any unknown adapter name, MUST be reported as a warning.

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
