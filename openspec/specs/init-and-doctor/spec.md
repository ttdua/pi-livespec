# init-and-doctor Specification

## Purpose

Defines `/livespec init`, `/livespec doctor` and the project and user config files they create, read and check.

## Requirements

### Requirement: Init command
`/livespec init` SHALL create, only when missing, `specs/product.md`, `specs/glossary.md`, `specs/constraints.md`, `specs/decisions/` and `.pi/livespec/config.yaml` from templates, and SHALL clone agent-skills when no clone exists. It MUST be idempotent: rerunning it MUST NOT change an existing file, and it MUST finish a partly failed earlier run. It SHALL report what was created, kept and failed. The created `specs/` files MUST pass `/livespec validate`.

#### Scenario: Fresh project
- **WHEN** `/livespec init` runs in a repository with none of these files
- **THEN** all five paths exist, the clone exists, and the report lists them as created

#### Scenario: Idempotent
- **WHEN** `/livespec init` runs a second time after the user edited `specs/product.md`
- **THEN** every file is byte-identical to before and the report lists them as kept

#### Scenario: Clone failure
- **WHEN** the clone fails during init
- **THEN** the files are still created, the report shows the clone failure, and a rerun with a reachable upstream completes the clone

#### Scenario: Templates validate
- **WHEN** `/livespec validate` runs right after init
- **THEN** it reports no error

### Requirement: Constraints drafting prompt
After init, while `specs/constraints.md` still carries the template marker line, the phase card SHALL ask the agent to draft `constraints.md` with the `constraint-driven-development` skill, which the pack names in `init.skills`.

#### Scenario: Template still present
- **WHEN** `specs/constraints.md` begins with the template marker
- **THEN** the phase card asks to draft it with `constraint-driven-development`

#### Scenario: Drafted
- **WHEN** the marker line has been removed
- **THEN** the phase card does not mention drafting constraints

### Requirement: Config files
Project config SHALL live at `.pi/livespec/config.yaml` and user config at `~/.pi/agent/livespec/config.yaml`. Project config SHALL accept the forge keys already defined by forge detection and `integrationBranch`. User config SHALL accept `agentSkills.channel`. Unknown keys MUST be reported as warnings. A project config that sets `agentSkills.channel` MUST be reported by doctor, because the clone is shared by all projects.

#### Scenario: Unknown key
- **WHEN** the project config has the key `integrationBrnach`
- **THEN** a warning names the unknown key

### Requirement: Doctor command
`/livespec doctor` SHALL only report and suggest, and MUST NOT edit settings, config or files. Each check reports `ok`, `warn` or `error` with a message and an optional suggestion. Other specs SHALL be able to register more doctor checks; LS-05 adds the approver check that way.

#### Scenario: Report only
- **WHEN** doctor runs with every check failing
- **THEN** no file under the project or `~/.pi` changes

#### Scenario: Registered check
- **WHEN** a test registers a doctor check
- **THEN** its result appears in the doctor output

### Requirement: Doctor checks
Doctor SHALL check: loaded skills that share a pack skill's name but live outside the clone, reported with their path; pack skills missing from the clone; Superpowers active in the project, with the probe (a) settings override as suggestion and a report when the project is untrusted; the clone state (commit, pin, last check, leftover staging); forge detection, authentication and read-only mode; and an uninitialized project with `openspec/`, suggesting `/livespec migrate-openspec`.

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

### Requirement: Subcommand routing
`/livespec` SHALL route the subcommands `init`, `doctor`, `next` and `skills` in addition to the existing `validate` and `migrate-openspec`. The bare command and unknown subcommands MUST keep the behavior of the version command requirement, and the usage text SHALL list every subcommand.

#### Scenario: Usage lists subcommands
- **WHEN** the user runs `/livespec nonsense`
- **THEN** the usage lists `validate`, `migrate-openspec`, `init`, `doctor`, `next` and `skills`, and nothing changes
