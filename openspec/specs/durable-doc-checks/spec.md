# durable-doc-checks Specification

## Purpose

Defines the define-time checks of durable docs: the `product-impact` check, the warning-only `glossary-terms` check with its define gate section, and the `behavior-change` facts, rule, gate question and check that record once per capability whether code under its `paths` changed its behavior.

## Requirements

### Requirement: Product impact check
The `product-impact` check SHALL read the change issue's `Product impact` line and report an error with severity `error` when the line is missing, is `—` or empty, or is neither `updated` nor `none — <reason>` with a non-empty reason. It SHALL also report an error when the value is `none — <reason>` and the `Capabilities` line has a `new` entry. The check SHALL NOT be waivable. The default pack SHALL list it in `define` and `review`, so a failing result blocks the define gate.

#### Scenario: Missing product impact blocks the define gate
- **WHEN** the change is in `define`, every other define check passes, and the `Product impact` line is `—`
- **THEN** `product-impact` reports an error and `spec_gate define` refuses, naming the check

#### Scenario: None with a reason
- **WHEN** `Product impact: none — internal refactor` and `Capabilities: new [], modified [rate-limit]`
- **THEN** `product-impact` reports nothing

#### Scenario: None with a new capability
- **WHEN** `Product impact: none — small` and `Capabilities: new [cache], modified []`
- **THEN** `product-impact` reports an error naming the new capability `cache`

#### Scenario: Updated
- **WHEN** `Product impact: updated`
- **THEN** `product-impact` reports nothing

### Requirement: Glossary terms check
The `glossary-terms` check SHALL read the lines that `git diff <Base>..HEAD -- specs/` adds to `specs/<capability>/spec.md` files, outside front matter, and report a `warning` for each candidate term the glossary lacks:
- a bold term `**X**`, other than `WHEN`, `THEN`, `AND` and `GIVEN`;
- a capitalized word that is not the first word of a sentence, not inside backticks, not all capitals, and that occurs nowhere under `specs/` at `Base`.

A glossary entry matches a candidate when it is equal ignoring case and a trailing `s`. The check MUST NOT report `error`. The define gate payload SHALL hold a "Glossary" section listing the warnings and the entries the specs diff adds to `specs/glossary.md`; approving the define gate SHALL be the human's approval of those entries.

#### Scenario: New bold term warns
- **WHEN** the specs diff adds the requirement line `Each **Token bucket** refills every second.` and the glossary has no `Token bucket` entry
- **THEN** `glossary-terms` reports a warning naming `Token bucket`, and the define gate is not refused because of it

#### Scenario: Known term
- **WHEN** the added line holds `**Unit**` and the glossary has the entry `- **Units**: ...`
- **THEN** `glossary-terms` reports nothing for `Unit`

#### Scenario: New proper noun warns
- **WHEN** the specs diff adds `Requests go through the Gateway first.`, `Gateway` occurs nowhere under `specs/` at `Base`, and the glossary has no such entry
- **THEN** `glossary-terms` reports a warning naming `Gateway`

#### Scenario: Proper noun exclusions
- **WHEN** the added line is `Clients call `RateLimiter` and the API once.`, and `Clients` starts the sentence
- **THEN** `glossary-terms` reports nothing for `Clients` (sentence start), `RateLimiter` (backticks) or `API` (all capitals)

#### Scenario: Scenario keywords ignored
- **WHEN** the added lines are `- **WHEN** a request arrives` and `- **THEN** it is rejected`
- **THEN** `glossary-terms` reports nothing

#### Scenario: Proposed entries shown at the gate
- **WHEN** the specs diff adds `- **Token bucket**: a refilling request budget` to `specs/glossary.md` and `spec_gate define` sends its request
- **THEN** the request's payload has a "Glossary" section listing that entry

### Requirement: Behavior change facts
For a change, the system SHALL compute the behavior facts: for each living spec whose `paths` match a changed file of `git diff <Base>..HEAD` that is not under `specs/`, while `specs/<capability>/spec.md` is not in that diff, one item `{ capability, files }` with the matching files sorted. A capability whose `spec.md` is in the diff SHALL have no item.

#### Scenario: Code changed, spec unchanged
- **WHEN** `specs/rate-limit/spec.md` has `paths: [src/limit/**]`, the diff changes `src/limit/cap.ts`, and the spec file is unchanged
- **THEN** the facts hold `{ capability: rate-limit, files: [src/limit/cap.ts] }`

#### Scenario: Spec changed too
- **WHEN** the diff changes `src/limit/cap.ts` and `specs/rate-limit/spec.md`
- **THEN** the facts hold no item for `rate-limit`

### Requirement: Behavior change rule
The `behavior-change` decision point SHALL be registered with `registerRule`, configured as `decisions.behavior-change: { mode: rule }`, and SHALL always ask a human, with the options `unchanged` and `changed`, recommending `unchanged` with the rationale `Code under the capability's paths changed but its spec did not; most such edits are refactors.` Each answer SHALL be posted as a `decision` record with point `behavior-change`, subject the capability, source `human`, the item as facts, the item's files as the top-level `files` field, and as digest the SHA-256 of the item's files joined by newlines. A record SHALL be reusable for an item only when its digest and facts equal the item's.

#### Scenario: Always asks
- **WHEN** `decide("behavior-change", { capability: "rate-limit", files: ["src/limit/cap.ts"] })` runs with an asker
- **THEN** the asker receives a `decide:behavior-change.rate-limit` question with the options `unchanged` and `changed`, and `unchanged` recommended

#### Scenario: Answer recorded
- **WHEN** the human chooses `unchanged` in session
- **THEN** a `decision` comment holds point `behavior-change`, subject `rate-limit`, source `human`, outcome `unchanged` and the files

#### Scenario: New file asks again
- **WHEN** a record answered `unchanged` for `[src/limit/cap.ts]` and the diff now also changes `src/limit/window.ts`
- **THEN** the record is not reusable and the capability is asked again

### Requirement: Behavior change question at the gate
When the target phase lists the `behavior-change` check, `spec_gate define` and `spec_gate review` SHALL first run the gate checks and the gate refusals with the `behavior-change` results left out. When that yields a refusal, `spec_gate` SHALL refuse with it, asking nothing and writing nothing. Otherwise it SHALL ask `behavior-change` through the configured approver chain for each behavior item with no reusable record, one capability at a time, then refresh the change state and run the checks and refusals again, `behavior-change` included, before it sends the gate request. An in-session answer SHALL be recorded at once; while a `decide:behavior-change.<capability>` request is pending, `spec_gate` SHALL refuse, naming the pending request, and send no gate request. An item with a reusable record MUST NOT be asked again.

#### Scenario: Asked once at define
- **WHEN** `spec_gate define` runs with one behavior item and the in-session approver, and the human answers `unchanged`
- **THEN** the record is posted, the define gate request follows, and a later `spec_gate review` with the same item asks nothing

#### Scenario: Other refusal asks nothing
- **WHEN** `spec_gate define` runs with one behavior item and `spec-format` reports an error (or the tree is dirty, or a blocking question is open)
- **THEN** `spec_gate` refuses with that reason, and no `decide:behavior-change` request or `decision` comment is written

#### Scenario: Changed answer blocks the same call
- **WHEN** the human answers `changed` for `rate-limit` during `spec_gate define`
- **THEN** the record is posted, the re-run `behavior-change` check fails, and `spec_gate` refuses naming `specs/rate-limit/spec.md` without sending the gate request

#### Scenario: Flow without the check
- **WHEN** a project flow lists no `behavior-change` check in `define` and `spec_gate define` runs with one behavior item
- **THEN** no `decide:behavior-change` request is written and the gate proceeds as before

#### Scenario: Forge request pending
- **WHEN** the approver chain is `[forge]` and `spec_gate define` runs with one behavior item
- **THEN** a `decide:behavior-change.rate-limit` request is posted and `spec_gate` refuses, naming it

### Requirement: Behavior change check
The `behavior-change` check SHALL report, for each behavior item: when no reusable record exists, an `error` whose message names `spec_gate <phase>` as the step that asks the human, or, while a `decide:behavior-change.<capability>` request is open, names that request as waiting for the human; an `error` naming `specs/<capability>/spec.md` when the reusable record's outcome is `changed`; nothing when it is `unchanged`. The check SHALL NOT be waivable. The default pack SHALL list it in `define` and `review`.

#### Scenario: Unanswered item names the gate
- **WHEN** the change is in `define` with one behavior item for `rate-limit`, no record and no open request
- **THEN** the check reports an error naming `spec_gate define`, and the next step names it

#### Scenario: Behavior changed without a spec edit
- **WHEN** the reusable record for `rate-limit` is `changed` and the spec file is still unchanged
- **THEN** the check reports an error asking to update `specs/rate-limit/spec.md`, and the gate refuses

#### Scenario: Spec updated after a changed answer
- **WHEN** the record for `rate-limit` is `changed` and the diff now changes `specs/rate-limit/spec.md`
- **THEN** the check reports nothing for `rate-limit`
