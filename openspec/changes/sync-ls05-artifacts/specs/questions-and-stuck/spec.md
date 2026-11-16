## MODIFIED Requirements

### Requirement: Requirement cascade
When an answer changes a requirement, the plugin SHALL:
1. move the change back to `define` when it is past define;
2. write a `stale` comment that names the question, `define` and every phase after it, and the units whose `Covers` names that requirement;
3. untick the stale units that are done, using `untickUnit`.

While a lock exists, stale units MUST need an amendment before the plan gate opens again. A unit made stale before the first lock SHALL instead be cleared by the first plan approval (see unit-planning "Re-planning after the lock"). The `change_iterations` count SHALL be the number of cascades that moved the change back to define from a later phase after a plan gate was approved. It is derived from own `stale` comments, so retrying a completion never counts twice. Completion MUST be idempotent: retrying a partly applied cascade SHALL finish the missing effects without repeating the applied ones.

#### Scenario: Answer sends the change back
- **WHEN** in `build`, Q3's answer changes `rate-limit/Requirement: Per-IP cap`, U3 covers it and is done, and U1 does not cover it
- **THEN** the change is in `define`, U3 is unticked and stale, U1 is unchanged, and `change_iterations` is 1

#### Scenario: Cascade before the plan
- **WHEN** in `define`, an answer changes a requirement and no plan gate was ever approved
- **THEN** a `stale` comment is written and `change_iterations` is not incremented

#### Scenario: Second answer while in define
- **WHEN** after a counted return to define, a second answer in `define` changes another requirement
- **THEN** a second `stale` comment is written and `change_iterations` does not rise

#### Scenario: Retried cascade counts once
- **WHEN** a cascade's body write and `stale` comment succeed, the phase move fails, and the next poll completes the answer
- **THEN** the change is in `define`, exactly one `stale` comment exists for the question, and `change_iterations` rose by one

### Requirement: Iteration cap
The cap SHALL block when `change_iterations` is at least `loops.change_iterations` and no stuck report was answered with a chosen option after the latest counted cascade. While it blocks, the next step SHALL ask for a stuck report, and every gate MUST refuse. A stuck answer with outcome `approved` or `approved_with_notes` and a choice SHALL lift the block until the next counted cascade. A dismissed stuck answer MUST NOT lift the block.

#### Scenario: Cap reached
- **WHEN** `change_iterations` is 5 with cap 5 and no stuck answer follows it
- **THEN** the next step asks to send a stuck report with `spec_stuck` and `spec_gate define` refuses

#### Scenario: Stuck answer lifts the cap
- **WHEN** `change_iterations` is 5 with cap 5 and a stuck report was answered after the fifth cascade with outcome `approved` and choice `B`
- **THEN** the next step no longer asks for a stuck report, and a sixth cascade blocks again

#### Scenario: Dismissed stuck answer keeps the cap
- **WHEN** `change_iterations` is 5 with cap 5 and the only stuck report after the fifth cascade was dismissed
- **THEN** the next step asks for a new stuck report and `spec_gate define` refuses

### Requirement: Stuck reports
`spec_stuck` SHALL write a `stuck` comment containing:
- where the work stopped;
- what was tried, with links;
- a hypothesis;
- two or three options;
- the recommended option.

It SHALL then send a blocking request with kind `stuck` and those options. While a stuck report is unanswered, the next step MUST say to wait for the human's choice, and every gate MUST refuse. The answer SHALL be recorded as a `stuck` answer comment with the outcome, the chosen option, notes, by, at and the adapter; a dismissed answer has outcome `dismissed` and selects no option, recorded as `choice: ""`.

#### Scenario: Stuck report waits for a choice
- **WHEN** `spec_stuck` runs with options A, B and C (A recommended) and the chain is `[forge]`
- **THEN** a `stuck` comment and a pending request are posted, and the next step says to wait for the human's choice

#### Scenario: Option count enforced
- **WHEN** `spec_stuck` runs with one option
- **THEN** the tool refuses and writes nothing

#### Scenario: Choice recorded
- **WHEN** a writer comments `/livespec choose B` on the pending stuck request
- **THEN** a stuck answer comment records choice `B` and the next step no longer waits
