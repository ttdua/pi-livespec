# questions-and-stuck Specification

## Purpose

Defines `spec_question` and the Questions ledger, answers, the requirement cascade derived from the spec diff after the plan lock, the `change_iterations` cap, and `spec_stuck` reports.

## Requirements

### Requirement: Question tool
`spec_question` SHALL append `- [ ] Q<n> (<class>): <text>` to `## Questions` with the next free number. The class is `blocking` by default, and the agent MAY propose `non-blocking`. The question SHALL then go through the approver with kind `question`: mode `blocking` for blocking questions and `async` for non-blocking ones. `spec_question` with `reask: Q<n>` SHALL send an open question again. The question text MUST be one line.

The agent MAY add two to four candidate answers, each with a label and a description, and MAY recommend one with a rationale (see request-briefing "Briefing shape"). Livespec SHALL give the candidates the option ids `A`, `B`, `C` and `D` in the order given, and `recommended` SHALL name one of those ids. A candidate label MUST be one line with no leading, trailing or repeated whitespace, MUST NOT contain a word starting with `--`, and MUST differ from every other candidate label, so its prefilled `/livespec answer` command parses back to exactly that label. The human SHALL stay free to write any other answer. Candidates SHALL NOT be written into the `## Questions` line. With `reask`, the candidates of the new call SHALL be used.

#### Scenario: Blocking by default
- **WHEN** `spec_question` runs with only text
- **THEN** `## Questions` gains `- [ ] Q<n> (blocking): <text>` and a blocking request is sent

#### Scenario: Non-blocking proposal
- **WHEN** `spec_question` runs with class `non-blocking` and the chain is `[forge]`
- **THEN** the request has mode `async` and the next step does not wait for it

#### Scenario: Candidate answers sent
- **WHEN** `spec_question` runs with candidates `per-user limits` and `per-IP limits`, `recommended: A` and a rationale
- **THEN** the request has options `A` and `B` with those labels and descriptions, the briefing recommends `A`, and the `## Questions` line holds only the question text

#### Scenario: Too many candidates
- **WHEN** `spec_question` runs with five candidates
- **THEN** the tool refuses and writes nothing

#### Scenario: Candidate label that cannot round-trip
- **WHEN** `spec_question` runs with a candidate labelled `limit --class blocking`
- **THEN** the tool refuses, names the candidate, and writes nothing

### Requirement: Question answers
When a question is answered, the plugin SHALL:
1. rewrite its line to `- [x] Q<n> (<class>): <text> — Answer: <answer>`, keeping every other line byte-identical;
2. write a `question` comment with the class, the answer, `by`, `at` and the adapter.

Answering a question SHALL NOT untick a unit, write a `stale` comment or move the phase; an answer that needs a requirement change is applied by editing the spec, and the spec edit cascades (see "Spec-diff requirement cascade"). The `question` comment SHALL NOT carry `changes_requirement`; one stored before this change SHALL still be read without error.

The human MAY change the class when answering, or before answering with `/livespec class`. A pending question request SHALL take its effective mode from the question's current class. A dismissed question stays open. No gate SHALL open while a blocking question is open.

#### Scenario: Answer written back
- **WHEN** Q1 is answered `use 60s windows`
- **THEN** its line reads `- [x] Q1 (blocking): <text> — Answer: use 60s windows`, it parses back with that answer, and the `question` comment has no `changes_requirement`

#### Scenario: Answer in build changes nothing else
- **WHEN** in `build`, U3 is done, and Q3 is answered
- **THEN** U3 stays ticked, no `stale` comment is written, and the change stays in `build`

#### Scenario: Human reclassifies
- **WHEN** a writer comments `/livespec class Q2 non-blocking` on an open blocking Q2
- **THEN** Q2's line shows `(non-blocking)`, its pending request counts as async, and neither the next step nor `spec_gate` waits for it

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
- two or three options, each with a description;
- the recommended option and the rationale for it.

It SHALL then send a blocking request with kind `stuck`, those options with their descriptions, and a briefing whose summary is the hypothesis, whose `recommended` is the recommended option and whose `rationale` is the rationale. The hypothesis SHALL follow the briefing `summary` limits. An option without a description, a missing rationale or a hypothesis over the limit MUST be refused before anything is written. A stored report written before descriptions existed SHALL still be sent again when it has no request: its options without descriptions, its recommended option only in the summary, and no briefing. While a stuck report is unanswered, the next step MUST say to wait for the human's choice, and every gate MUST refuse. The answer SHALL be recorded as a `stuck` answer comment with the outcome, the chosen option, notes, by, at and the adapter; a dismissed answer has outcome `dismissed` and selects no option, recorded as `choice: ""`.

#### Scenario: Stuck report waits for a choice
- **WHEN** `spec_stuck` runs with options A, B and C (A recommended) and the chain is `[forge]`
- **THEN** a `stuck` comment and a pending request are posted, and the next step says to wait for the human's choice

#### Scenario: Option count enforced
- **WHEN** `spec_stuck` runs with one option
- **THEN** the tool refuses and writes nothing

#### Scenario: Choice recorded
- **WHEN** a writer comments `/livespec choose B` on the pending stuck request
- **THEN** a stuck answer comment records choice `B` and the next step no longer waits

#### Scenario: Option without a description
- **WHEN** `spec_stuck` runs with options A and B and B has no description
- **THEN** the tool refuses, names B's description, and writes nothing

#### Scenario: Old stuck report sent again
- **WHEN** stuck report S1, stored without option descriptions or rationale, is open with no request and `spec_stuck` runs
- **THEN** S1's request is sent again with its stored options, its summary names the recommended option, and the request has no briefing

### Requirement: Requirement baseline
Requirement content SHALL be the requirement text and its scenarios as parsed, without line positions and with every run of whitespace collapsed to one space, and its digest the sha256 of that content. The scope SHALL be the capabilities the change declares plus every capability a unit's `Covers` names. A plan gate request SHALL record `requirements`, the digest of every requirement in scope at the HEAD the request is bound to, and `requirement_scope`, the capabilities scanned; a self plan gate SHALL record them at HEAD; the approved plan `gate` comment SHALL carry them. The baseline SHALL be the record of the latest approved, non-superseded plan gate; without a lock there SHALL be no cascade, and git history before HEAD SHALL NOT be read for it, so a rebase or force-push does not affect it.

A requirement's acknowledged digest SHALL be the one recorded by the latest own cascade `stale` comment after the baseline gate that names it, or else the baseline's. The requirements compared SHALL be those of `requirement_scope` at HEAD plus every acknowledged one; a requirement SHALL be changed when its digest at HEAD differs from its acknowledged digest, a requirement absent on one side counting as added or removed; a removal acknowledged by a cascade stays acknowledged while the requirement stays absent. A spec file missing at a revision SHALL contribute no requirement, and a spec file SHALL be read with the same lenient parser `change_sync` uses. Capabilities outside `requirement_scope` SHALL NOT be compared until a plan gate records them. The digests SHALL come from the one function that `change_sync` also uses to compare its old and new base.

#### Scenario: Whitespace and moved lines ignored
- **WHEN** after the plan lock, a commit re-indents and re-wraps a multi-line requirement text, adds a blank line between its paragraphs, and shifts every line of the requirement down without changing a word, and the cascade runs
- **THEN** no `stale` comment is written and no unit is unticked

#### Scenario: Edit before the lock
- **WHEN** in `plan` with no plan gate ever approved, a commit edits a requirement and the cascade runs
- **THEN** nothing is written and the phase does not move

#### Scenario: Plan gate records the digests
- **WHEN** `spec_gate plan` sends a request at HEAD `c7` for a change declaring `rate-limit`, and the request is approved
- **THEN** the request and the plan `gate` comment both hold `requirements` with the digest of every `rate-limit` requirement at `c7`, and `requirement_scope` `[rate-limit]`

#### Scenario: Rebased branch on a fresh clone
- **WHEN** in `build`, the branch was rebased and force-pushed, a fresh clone lacks the plan gate's `head_sha`, nothing in the specs changed, and the cascade runs
- **THEN** nothing is written and the change stays in `build`

#### Scenario: Edit after a rebase
- **WHEN** in `build`, a fresh clone lacks the plan gate's `head_sha`, a commit edited `rate-limit/Requirement: Per-IP cap` which done unit U3 covers, and the cascade runs
- **THEN** a `stale` comment names that requirement and U3, U3 is unticked, and the change is in `define`

#### Scenario: Removed requirement cascades once
- **WHEN** after the plan lock, a commit deletes `rate-limit/Requirement: Burst`, the cascade runs, and the cascade then runs again at the same HEAD
- **THEN** exactly one `stale` comment names that requirement as removed

#### Scenario: Capability covered after the lock
- **WHEN** after the plan lock, an approved amendment makes U5 cover `audit-log/Requirement: Retention`, `audit-log` is not in `requirement_scope`, and a commit edits that requirement
- **THEN** the cascade writes nothing for it until a plan gate records `audit-log`

### Requirement: Integration-branch exclusion
A requirement that no own cascade `stale` comment after the baseline gate names SHALL NOT count as changed when its digest at HEAD equals its digest at the integration reference and differs from the baseline digest, meaning the integration branch changed it after the lock and HEAD took that content. A requirement absent at the integration reference SHALL never be excluded, so a removal always cascades. This SHALL apply whichever tool merged the integration branch (`change_sync`, a hand merge or the forge), so edits that other changes landed there never cascade here, while a revert of the change's own edit still does. The integration reference SHALL be `merge-base(HEAD, origin/<integration branch>)`, taken after a best-effort fetch of the integration branch bounded by the git runner's timeout (a failed fetch uses the local ref); when the integration branch is unknown or the merge-base cannot be computed, the change's recorded `Base` SHALL serve instead.

#### Scenario: Edit merged by change_sync ignored
- **WHEN** `change_sync` merged an integration branch whose spec edit changed a requirement, the change's own branch did not touch it, and the cascade runs
- **THEN** the cascade writes nothing for that requirement

#### Scenario: Hand merge of the integration branch ignored
- **WHEN** a change that belongs to no initiative merges `origin/main` by hand after the plan lock, `main` changed `rate-limit/Requirement: Burst` which done unit U2 covers, `Base` is unchanged, and the cascade runs
- **THEN** no `stale` comment is written, U2 stays ticked, and the phase does not move

#### Scenario: Conflict resolved by combining both sides
- **WHEN** after the plan lock, the change and `main` both edited `rate-limit/Requirement: Per-IP cap`, the merge conflict is resolved with text from both sides, and the cascade runs
- **THEN** a `stale` comment names that requirement

#### Scenario: Own edit reverted while main never touched it
- **WHEN** after the plan lock, a cascade acknowledged an edit of `rate-limit/Requirement: Per-IP cap`, `main` never changed it, and a commit restores its text at the lock
- **THEN** a `stale` comment names that requirement

### Requirement: Spec-diff requirement cascade
The plugin SHALL cascade every changed requirement, as "Requirement baseline" defines and "Integration-branch exclusion" limits, once per content change: a revert to an earlier text is a change too. For those requirements, the plugin SHALL, in this order:
1. write a `stale` comment that names those requirements with their content digests at HEAD, `define` and every phase after it, and every unit whose `Covers` names one of them, done or not, which MAY be none;
2. untick the named units that are done, using `untickUnit`, in one versioned body write;
3. move the change back to `define` when it is past define.

While a lock exists, stale units MUST need an amendment before the plan gate opens again. The `change_iterations` count SHALL be the number of cascades that moved the change back to define from a later phase after a plan gate was approved. It is derived from own `stale` comments, so retrying never counts twice. Completion MUST be idempotent: rerunning after a partly applied cascade SHALL finish the missing untick and phase move without writing a second `stale` comment for the same content. A question answer SHALL never start a cascade.

#### Scenario: Spec edit sends the change back
- **WHEN** in `build` after the plan lock, a commit edits the text of `rate-limit/Requirement: Per-IP cap`, U3 covers it and is done, U1 does not cover it, and `/livespec next` runs
- **THEN** the change is in `define`, U3 is unticked and stale, U1 is unchanged, a `stale` comment names that requirement and U3, and `change_iterations` is 1, with no question asked

#### Scenario: Edit no done unit covers
- **WHEN** in `build` after the plan lock, a commit edits a requirement that only the pending unit U4 covers, and `spec_gate build` runs
- **THEN** every done unit stays ticked, a `stale` comment names the requirement and U4, U4 is stale, the change is in `define`, and `spec_gate build` refuses because `build` is no longer the current phase

#### Scenario: Same edit cascades once
- **WHEN** a cascade for an edit of `rate-limit/Requirement: Per-IP cap` was applied, U3 was then amended, and the cascade runs again at the same HEAD
- **THEN** no new `stale` comment is written, U3 is not stale, and `change_iterations` does not rise

#### Scenario: Further edit of the same requirement
- **WHEN** after a cascade for `rate-limit/Requirement: Per-IP cap` and an amendment of U3, a new commit changes that requirement's text again and the cascade runs
- **THEN** a new `stale` comment names it and U3 again

#### Scenario: Edit reverted after a cascade
- **WHEN** a cascade for an edit of `rate-limit/Requirement: Per-IP cap` was applied, the define and plan gates were not approved again, and a commit restores the requirement's text at the baseline
- **THEN** a new `stale` comment names that requirement with the restored digest

#### Scenario: Second edit while in define
- **WHEN** a counted cascade moved the change to `define`, and a commit then edits a different requirement and the cascade runs
- **THEN** a second `stale` comment names that requirement and `change_iterations` does not rise

#### Scenario: Retried cascade counts once
- **WHEN** a cascade's `stale` comment is written, the untick write conflicts, and the next `session_start` runs the cascade again
- **THEN** U3 is unticked, the change is in `define`, exactly one `stale` comment exists for that edit, and `change_iterations` rose by one

### Requirement: Locks without requirement digests
A plan gate approved before plan gates recorded `requirements` SHALL use, as its baseline, the digests computed at its `head_sha` for the current scope, while that commit is in the repository, including a commit rewritten away but still in the object store.

When that commit is not in the repository either, the plugin MUST NOT guess a baseline or skip silently. When no own `stale` comment names that baseline yet, it SHALL write a `stale` comment that names the missing commit and lists `define` and every phase after it, with no unit; when the change is past `define`, it SHALL move the change back to `define`, so the spec and then the plan are approved again, and the new plan approval records digests. A partly applied one SHALL be completed by later runs like any cascade. Such a comment SHALL NOT count as an iteration, and it SHALL be written once per missing commit, so approving `define` again does not send the change back a second time. Until a new plan gate is approved, no requirement is compared.

#### Scenario: Old lock with its commit present
- **WHEN** the approved plan gate records no `requirements`, its `head_sha` is no longer an ancestor of HEAD but is still in the object store, and the cascade runs
- **THEN** the requirement digests at that commit are compared as usual and no baseline `stale` comment is written

#### Scenario: Baseline commit missing
- **WHEN** in `build`, the approved plan gate records no `requirements`, its `head_sha` is not in the repository after a force-push and a fresh clone, and `unit_finish U2` runs
- **THEN** a `stale` comment names the missing commit, the change is in `define`, `unit_finish` refuses, the next step asks for the `define` gate, and `change_iterations` does not rise

#### Scenario: Missing baseline handled once
- **WHEN** a missing baseline commit moved the change to `define`, the define gate is then approved, and the cascade runs in `plan` before the plan gate is approved again
- **THEN** no new `stale` comment is written and the change stays in `plan`

#### Scenario: Baseline commit missing in define
- **WHEN** the change is in `define` after a cascade, the approved plan gate records no `requirements` and its `head_sha` is not in the repository, and the cascade runs
- **THEN** a `stale` comment names the missing commit, the change stays in `define`, and approving the define gate does not send it back again

### Requirement: Cascade triggers
The plugin SHALL run the spec-diff requirement cascade at `session_start` after the forge connects, when `/livespec next` runs, and before `spec_gate` and `unit_finish` resolve the change, after their forge precondition checks. It SHALL skip when the session is not initialized, no change is current, the change state is stale, the flow pack is not valid, or the forge is read-only or blocked, and a failed run MUST be recorded and MUST NOT fail the hook, the command or the tool. Runs in one session SHALL NOT overlap: a run started while another is in flight SHALL wait for it and reuse its result. The cascade's own writes are not writes of the tool that triggered it, so a tool that then refuses (for example `spec_gate` after the change moved back) still refuses without writing anything itself.

#### Scenario: Parallel triggers run once
- **WHEN** `spec_gate build` and `unit_finish U2` are called in parallel in one session after a covered requirement changed
- **THEN** exactly one `stale` comment is written and `change_iterations` rises by one

#### Scenario: Read-only forge skips the cascade
- **WHEN** the forge is read-only and a covered requirement changed after the lock, and `/livespec next` runs
- **THEN** nothing is written and the command still prints the next step
