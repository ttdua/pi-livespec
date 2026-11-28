# subagent-policy Specification

## Purpose

Defines the pack's per-phase `subagents` entries and how they are evaluated: the sub-schema, the `when` conditions, advisory roles, the build-loop next steps, and the default entries of the `agent-skills` pack. The policy suggests next steps; it never moves the flow.

## Requirements

### Requirement: Subagents sub-schema
The system SHALL register a validator for the per-phase `subagents` key. Each entry SHALL be a map with `role` (`scout`, `implementer`, `reviewer`, `verifier`), `mode` (`off`, `always`, `auto`), and optionally `subject` (required for `reviewer`: `spec`, `plan`, `unit`, `change` or `persona:<name>`), `when` (a list of conditions), `advisory` (boolean, default `false`) and `skills` (a list of skill names). It MUST report with line and column: unknown keys, unknown values, `reviewer` without `subject`, `when` with `mode` other than `auto`, `auto` without `when`, an unparsable condition, and keys naming a model or lane count. The validator SHALL report every `persona:<name>` subject as a persona the content check needs.

#### Scenario: Valid entry
- **WHEN** phase `build` sets `subagents: [{ role: reviewer, subject: unit, mode: auto, when: ["difficulty>=medium"] }]`
- **THEN** validation passes

#### Scenario: Reviewer without subject
- **WHEN** an entry sets `role: reviewer` and no `subject`
- **THEN** validation returns an error with that entry's line and column

#### Scenario: Model key
- **WHEN** an entry sets `model: x`
- **THEN** validation returns an error stating that packs never name models

### Requirement: When conditions
An `auto` entry SHALL hold when any of its conditions holds:
- `units>=N`: the change has at least N units;
- `difficulty>=low|medium|high`: for unit roles the unit's `Difficulty`, otherwise the highest unit `Difficulty`, is at least that level;
- `tags:<tag>`: the unit's tags (unit roles) or the change's tags hold `<tag>`;
- `unfamiliar-code`: in `build`, a file of the unit's `Files` matches no capability's `paths`; in `shape`, `define` and `plan`, a capability named in `Capabilities` has no spec or no `paths`, or the repository has no specs;
- `context>=N%`: the main session's context usage is at least N minus 2 percent, read with `ctx.getContextUsage()`; it MUST NOT hold before the first completed turn.

#### Scenario: Unfamiliar code in build
- **WHEN** U2's `Files` include `src/new/x.ts` and no capability's `paths` match it
- **THEN** `unfamiliar-code` holds for U2

#### Scenario: Context threshold with margin
- **WHEN** a condition is `context>=60%` and usage reads 58.5%
- **THEN** the condition holds

#### Scenario: First turn
- **WHEN** a condition is `context>=60%` and no turn has completed
- **THEN** the condition does not hold

### Requirement: Policy decides suggestions, not the flow
`off` SHALL never suggest a dispatch, `always` SHALL suggest it every time the phase's step for that role is reached, and `auto` SHALL suggest it when its conditions hold. A suggestion SHALL appear as the phase card's next step naming `subagent_dispatch` with its arguments. When no capable executor exists, the next step SHALL name `subagent_packet` and inline work instead. The policy MUST NOT move a phase, tick a unit or post a gate. The small-fix lane MUST NOT suggest any dispatch.

#### Scenario: Auto implementer
- **WHEN** the change has 4 units and U1 is next in `build` with a capable executor
- **THEN** the card's next step is `subagent_dispatch implementer U1`

#### Scenario: Below the threshold
- **WHEN** the change has 2 units, U1 has `Difficulty: low`, no tag matches and context is at 30%
- **THEN** the card's next step is to work U1 inline

#### Scenario: Small-fix lane
- **WHEN** the change is in the small-fix lane
- **THEN** no next step names `subagent_dispatch`

### Requirement: Advisory roles
An entry with `advisory: true` SHALL attach the role's findings to the payload of the phase's next human gate and MUST NOT refuse a tick, block a gate or move the flow. Its result MAY make a `self` gate ask the human, through phase-gates "Self gate escalation"; that is not a block.

#### Scenario: Advisory spec review
- **WHEN** the `define` spec reviewer reports a `CRITICAL` finding
- **THEN** the define gate's payload lists that finding, and the gate can still be requested

#### Scenario: Advisory finding escalates the plan gate
- **WHEN** the `plan` reviewer reports a `CRITICAL` finding at HEAD and the plan gate is self
- **THEN** `spec_gate plan` sends a human gate request whose payload lists that finding, and does not refuse

### Requirement: Build loop steps
In `build`, the next step for a ready unit SHALL follow this order: `unit_start` (parent), the implementer (dispatched or inline), the unit reviewer when its entry holds, then `unit_finish` (parent). When the unit reviewer reports a blocking finding, the next step SHALL be a fix round by the implementer with a new commit, never an amend, followed by another review. After `unit_rebuilds` rounds that still end with a blocking finding, the next step SHALL be `spec_stuck` with the reason `re-plan required`.

#### Scenario: Review before finish
- **WHEN** U1's implementer returned `DONE` and the unit reviewer entry holds for U1
- **THEN** the next step is `subagent_dispatch reviewer U1 unit`, not `unit_finish U1`

#### Scenario: Rebuild cap
- **WHEN** U1's third review still reports a `WARNING` and `unit_rebuilds` is 2
- **THEN** the next step is `spec_stuck` with reason `re-plan required`

### Requirement: Default pack entries
The default `agent-skills` pack SHALL declare:
- `shape`: `scout`, `auto`, `when: [unfamiliar-code]`;
- `define`: `scout`, `auto`, `when: [unfamiliar-code]`; `reviewer` subject `spec`, `always`, advisory;
- `plan`: `scout`, `auto`, `when: [unfamiliar-code]`; `reviewer` subject `plan`, `always`, advisory;
- `build`: `implementer`, `auto`, `when: ["units>=3", "difficulty>=medium", "context>=60%"]`; `reviewer` subject `unit`, `auto`, `when: ["difficulty>=medium"]`, `skills: [code-review-and-quality]`;
- `review`: the reviewer and verifier entries of review-phase "Reviewer selection".

The `review` phase's entries SHALL be run by `spec_review` only; the phase-level next step MUST NOT suggest them one at a time. The `subagents` sub-schema SHALL report `code-reviewer` as a persona the content check needs when an entry has subject `change`.

#### Scenario: Build entries
- **WHEN** the default pack is loaded
- **THEN** phase `build` has the implementer and unit-reviewer entries above and validation passes

#### Scenario: Review entries
- **WHEN** the default pack is loaded
- **THEN** phase `review` has the `change`, `persona:security-auditor`, `persona:web-performance-auditor` and `persona:test-engineer` reviewer entries and the `verifier` entry, and the content check needs `code-reviewer`, `security-auditor`, `web-performance-auditor` and `test-engineer`

#### Scenario: No one-by-one suggestion in review
- **WHEN** the change is in `review` and no aggregate records HEAD
- **THEN** the next step names `spec_review`, not `subagent_dispatch reviewer change`
