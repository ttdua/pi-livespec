## MODIFIED Requirements

### Requirement: Durable answers
Once an answer has been validated, the plugin SHALL record it as an own `answer` comment holding the request, the answer and the validation verdict. It SHALL do this before applying any effect, for in-session and forge answers alike. A request SHALL be pending while it has no `answer` comment, applying while it has an `answer` comment but no result record, and completed once a result record exists, read from the merged own records of ledger-store "Ledger records in the change state". The poll and every livespec tool MUST first finish applying requests, without validating them again.

#### Scenario: Crash while applying
- **WHEN** an in-session approval of an amendment is recorded, the body edit succeeds, and the session ends before the `amendment` comment is written
- **THEN** the next session finishes the amendment without asking again, and the result is not superseded

#### Scenario: Decide answer completed by a ledger entry
- **WHEN** a forge answer to `decide:difficulty.U1` is recorded as an `answer` comment and its `decision` entry is appended to the ledger
- **THEN** the request counts as completed and the poll does not apply it again

### Requirement: The plugin writes the result
Whatever adapter answered, the result record SHALL be written by the plugin and SHALL name the request: a `gate`, `amendment`, `question` or `stuck` result as an own marked comment, and a `decision` result as a `decision` ledger entry (see `ledger-store`). The adapter, the answering comment's id and author (forge), `by` and `at` MUST be recorded. A human's comment MUST NOT be read as state by itself, and a marked result comment from another account MUST be ignored.

#### Scenario: Foreign marked gate ignored
- **WHEN** another account posts a valid `<!-- livespec:gate:plan -->` comment with outcome `approved`
- **THEN** the change state has no approved plan gate and the card warns about the foreign marked comment

#### Scenario: Forge answer recorded
- **WHEN** a forge command completes a gate
- **THEN** the `gate` comment records `adapter: forge` and the answering comment id and author

#### Scenario: Decision result in the ledger
- **WHEN** the human answers `decide:difficulty.U1` in session
- **THEN** a `decision` entry naming the request is appended to the ledger and no `decision` comment is posted
