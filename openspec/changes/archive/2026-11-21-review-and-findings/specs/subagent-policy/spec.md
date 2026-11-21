## MODIFIED Requirements

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
