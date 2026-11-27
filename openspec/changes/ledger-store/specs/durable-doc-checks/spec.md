## MODIFIED Requirements

### Requirement: Behavior change question at the gate
When the target phase lists the `behavior-change` check, `spec_gate define` and `spec_gate review` SHALL first run the gate checks and the gate refusals with the `behavior-change` results left out. When that yields a refusal, `spec_gate` SHALL refuse with it, asking nothing and writing nothing. Otherwise it SHALL ask `behavior-change` through the configured approver chain for each behavior item with no reusable record, one capability at a time, then refresh the change state and run the checks and refusals again, `behavior-change` included, before it sends the gate request. An in-session answer SHALL be recorded at once; while a `decide:behavior-change.<capability>` request is pending, `spec_gate` SHALL refuse, naming the pending request, and send no gate request. An item with a reusable record MUST NOT be asked again.

#### Scenario: Asked once at define
- **WHEN** `spec_gate define` runs with one behavior item and the in-session approver, and the human answers `unchanged`
- **THEN** the record is posted, the define gate request follows, and a later `spec_gate review` with the same item asks nothing

#### Scenario: Other refusal asks nothing
- **WHEN** `spec_gate define` runs with one behavior item and `spec-format` reports an error (or the tree is dirty, or a blocking question is open)
- **THEN** `spec_gate` refuses with that reason, and no `decide:behavior-change` request or `decision` entry is written

#### Scenario: Changed answer blocks the same call
- **WHEN** the human answers `changed` for `rate-limit` during `spec_gate define`
- **THEN** the record is posted, the re-run `behavior-change` check fails, and `spec_gate` refuses naming `specs/rate-limit/spec.md` without sending the gate request

#### Scenario: Flow without the check
- **WHEN** a project flow lists no `behavior-change` check in `define` and `spec_gate define` runs with one behavior item
- **THEN** no `decide:behavior-change` request is written and the gate proceeds as before

#### Scenario: Forge request pending
- **WHEN** the approver chain is `[forge]` and `spec_gate define` runs with one behavior item
- **THEN** a `decide:behavior-change.rate-limit` request is posted and `spec_gate` refuses, naming it

### Requirement: Behavior change rule
The `behavior-change` decision point SHALL be registered with `registerRule`, configured as `decisions.behavior-change: { mode: rule }`, and SHALL always ask a human, with the options `unchanged` and `changed`. Each answer SHALL be posted as a `decision` record with point `behavior-change`, subject the capability, source `human`, the item as facts, the item's files as the top-level `files` field, and as digest the SHA-256 of the item's files joined by newlines. A record SHALL be reusable for an item only when its digest and facts equal the item's.

#### Scenario: Always asks
- **WHEN** `decide("behavior-change", { capability: "rate-limit", files: ["src/limit/cap.ts"] })` runs with an asker
- **THEN** the asker receives a `decide:behavior-change.rate-limit` question with the options `unchanged` and `changed`

#### Scenario: Answer recorded
- **WHEN** the human chooses `unchanged` in session
- **THEN** a `decision` ledger entry holds point `behavior-change`, subject `rate-limit`, source `human`, outcome `unchanged` and the files

#### Scenario: New file asks again
- **WHEN** a record answered `unchanged` for `[src/limit/cap.ts]` and the diff now also changes `src/limit/window.ts`
- **THEN** the record is not reusable and the capability is asked again
