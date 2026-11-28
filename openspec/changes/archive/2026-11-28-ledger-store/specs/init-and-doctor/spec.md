## MODIFIED Requirements

### Requirement: Config files
Project config SHALL live at `.pi/livespec/config.yaml` and user config at `~/.pi/agent/livespec/config.yaml`.
- Project config SHALL accept the forge keys already defined by forge detection, `integrationBranch`, `interaction.adapter`, `verify.setup`, `verify.timeout`, `testCommand` and `ledger.retain`.
- User config SHALL accept `agentSkills.channel`, `interaction.adapter`, `lanes`, `packetBudgetTokens` and `isolation.excludePackages`.
- `lanes` MUST be a positive integer with default 3, and `packetBudgetTokens` a positive integer with default 24000. Any other value MUST be reported as a warning, and the default SHALL be used.
- `isolation.excludePackages` MUST be a list of strings, each a package source as written in pi settings. Any other value MUST be reported as a warning and ignored.
- `interaction.adapter` MUST be a list of adapter names. Any other value, and any unknown adapter name, MUST be reported as a warning.
- `verify.setup` MUST be a string, and `verify.timeout` a positive integer number of seconds with default 600. Any other value MUST be reported as a warning, and the default SHALL be used.
- `testCommand` MUST be a string, the shell command `fix_ship` runs; it has no default. Any other value MUST be reported as a warning and ignored.
- `ledger.retain` MUST be a boolean with default `true`. Any other value MUST be reported as a warning, and the default SHALL be used.

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

#### Scenario: Test command
- **WHEN** the project config sets `testCommand: bun test`
- **THEN** the loaded project config has `testCommand` `bun test` and no warning

#### Scenario: Invalid test command
- **WHEN** the project config sets `testCommand: [bun, test]`
- **THEN** a warning names `testCommand` and the loaded project config has no `testCommand`

#### Scenario: Invalid verify timeout
- **WHEN** the project config sets `verify: { timeout: -5 }`
- **THEN** a warning names `verify.timeout` and the timeout is 600 seconds

#### Scenario: Subagent settings
- **WHEN** the user config sets `lanes: 2`, `packetBudgetTokens: 16000` and `isolation: { excludePackages: ["git:github.com/acme/flow"] }`
- **THEN** the loaded user config has those values and no warning

#### Scenario: Subagent defaults
- **WHEN** the user config sets none of `lanes`, `packetBudgetTokens` or `isolation`
- **THEN** `lanes` is 3, `packetBudgetTokens` is 24000 and the extra exclusion list is empty

#### Scenario: Ledger retention
- **WHEN** the project config sets `ledger: { retain: false }`
- **THEN** the loaded project config has `ledger.retain` `false` and no warning; and with no `ledger` key it is `true`

#### Scenario: Invalid ledger retention
- **WHEN** the project config sets `ledger: { retain: "no" }`
- **THEN** a warning names `ledger.retain` and it is `true`

#### Scenario: Invalid lanes
- **WHEN** the user config sets `lanes: 0`
- **THEN** a warning names `lanes` and `lanes` is 3
