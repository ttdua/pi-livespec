## MODIFIED Requirements

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
