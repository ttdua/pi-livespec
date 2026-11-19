## MODIFIED Requirements

### Requirement: Config files
Project config SHALL live at `.pi/livespec/config.yaml` and user config at `~/.pi/agent/livespec/config.yaml`.
- Project config SHALL accept the forge keys already defined by forge detection, `integrationBranch`, `interaction.adapter`, `verify.setup` and `verify.timeout`.
- User config SHALL accept `agentSkills.channel`, `interaction.adapter`, `lanes`, `packetBudgetTokens` and `isolation.excludePackages`.
- `lanes` MUST be a positive integer with default 3, and `packetBudgetTokens` a positive integer with default 24000. Any other value MUST be reported as a warning, and the default SHALL be used.
- `isolation.excludePackages` MUST be a list of strings, each a package source as written in pi settings. Any other value MUST be reported as a warning and ignored.
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

#### Scenario: Subagent settings
- **WHEN** the user config sets `lanes: 2`, `packetBudgetTokens: 16000` and `isolation: { excludePackages: ["git:github.com/acme/flow"] }`
- **THEN** the loaded user config has those values and no warning

#### Scenario: Subagent defaults
- **WHEN** the user config sets none of `lanes`, `packetBudgetTokens` or `isolation`
- **THEN** `lanes` is 3, `packetBudgetTokens` is 24000 and the extra exclusion list is empty

#### Scenario: Invalid lanes
- **WHEN** the user config sets `lanes: 0`
- **THEN** a warning names `lanes` and `lanes` is 3

### Requirement: Doctor checks
Doctor SHALL check: loaded skills that share a pack skill's name but live outside the clone, reported with their path; pack skills missing from the clone; Superpowers active in the project, with the probe (a) settings override as suggestion and a report when the project is untrusted; the clone state (commit, pin, last check, leftover staging); forge detection, authentication and read-only mode; an uninitialized project with `openspec/`, suggesting `/livespec migrate-openspec`; the subagent executor and which of its required capabilities are missing; role agents (`scout`, `implementer`, `reviewer`, `verifier`) whose effective source is not the executor's built-in, reported with the overriding file as information; a configured package known to register a workspace provider (today `@gotgenes/pi-subagents-worktrees`), reported as a warning that a lane child it moves runs its unit sequentially; and the effective list of packages excluded from livespec children.

#### Scenario: Duplicate skill
- **WHEN** a loaded skill `spec-driven-development` has a path under `~/.agents/skills` and the pack names that skill
- **THEN** doctor reports a warning with that path and says pi keeps the first skill found

#### Scenario: Missing pack skill
- **WHEN** the clone lacks `skills/idea-refine/`
- **THEN** doctor reports an error naming `idea-refine`

#### Scenario: Superpowers in an untrusted project
- **WHEN** `using-superpowers` is loaded and the project is not trusted
- **THEN** doctor suggests the settings override and reports that it needs a trusted project

#### Scenario: Forge read-only
- **WHEN** the forge is unreachable
- **THEN** doctor reports read-only mode

#### Scenario: OpenSpec folder
- **WHEN** the project is not initialized and has an `openspec/` folder
- **THEN** doctor suggests `/livespec migrate-openspec`

#### Scenario: Clone state
- **WHEN** the clone has a pin and a leftover staging directory
- **THEN** doctor reports the commit, the pin, the last check time and a warning for the staging directory

#### Scenario: No clone
- **WHEN** no clone exists
- **THEN** doctor reports an error and suggests `/livespec init`

#### Scenario: Forge detection fails
- **WHEN** forge detection throws
- **THEN** doctor reports an error with the detection message

#### Scenario: Forge auth fails
- **WHEN** `whoami` throws a `ForgeError` with code `auth`
- **THEN** doctor reports an authentication error

#### Scenario: Channel in project config
- **WHEN** the project config sets `agentSkills.channel`
- **THEN** doctor warns that the channel is read from the user config only

#### Scenario: Superpowers in a trusted project
- **WHEN** `using-superpowers` is loaded and the project is trusted
- **THEN** doctor suggests the settings override without a trust warning

#### Scenario: Executor missing
- **WHEN** no subagent executor service is published
- **THEN** doctor reports that livespec runs every role inline

#### Scenario: Executor lacks a capability
- **WHEN** the published service has `spawn` but no `wait`
- **THEN** doctor reports `wait` as missing and that livespec runs every role inline

#### Scenario: Role override
- **WHEN** the executor resolves `implementer` to `~/.pi/agent/agents/implementer.md`
- **THEN** doctor reports, as information, that `implementer` is overridden by that file

#### Scenario: Workspace provider package
- **WHEN** the configured packages include `npm:@gotgenes/pi-subagents-worktrees`
- **THEN** doctor warns that lane children it moves run their units sequentially

#### Scenario: Excluded packages listed
- **WHEN** the configured packages include `git:github.com/obra/superpowers`
- **THEN** doctor lists it among the packages excluded from livespec children
