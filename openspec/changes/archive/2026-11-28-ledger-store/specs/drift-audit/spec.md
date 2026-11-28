## MODIFIED Requirements

### Requirement: Scout confirmation
The audit SHALL send the `scenario-untested` and `removed-reference` items to one `scout` child through the dispatch API, with a packet holding the protocol layer, no flow skills, the audited commit SHA, and a task listing each item's key and evidence and the related spec text as untrusted data. The child SHALL run in a temporary worktree checked out at the audited commit, removed after the run, and the task SHALL tell it to judge only that tree. It SHALL request thinking `low` and never a model. The child SHALL return `verdicts`, each with a key, `confirmed` (the drift is real) or `refuted` (the test or reference exists under another name), and a reason. A refuted item SHALL be left out of the classified items and listed under "Refuted by the scout" with its reason. When no capable executor is present, the role agent is disabled, the launch check fails, or the child returns no valid verdict for an item, that item SHALL be kept and marked unconfirmed. The audit SHALL NOT run the scout inline, and the run SHALL write no `dispatch` ledger entry.

#### Scenario: Renamed test refuted
- **WHEN** the scout refutes `scenario-untested:rate-limit/rejects 101st request` with the reason "tested as `rejects the 101st request`"
- **THEN** the item is not classified and appears under "Refuted by the scout" with that reason

#### Scenario: Scout sees the audited snapshot
- **WHEN** the session is on a feature branch that adds `tests/limit.test.ts` naming `rejects 101st request`, and the audited commit lacks that file
- **THEN** the scout's `cwd` is a worktree of the audited commit, which has no such test

#### Scenario: Seeded audit with a confirming scout
- **WHEN** the seeded repository of "Drift detectors" is audited with a fake executor whose scout confirms every item
- **THEN** the report classifies all seven items with the severities of "Drift severity rule"

#### Scenario: No executor
- **WHEN** no capable executor is present
- **THEN** the `scenario-untested` and `removed-reference` items are reported marked unconfirmed, and the other items are unaffected

#### Scenario: Launch mismatch
- **WHEN** the executor applies a different `cwd` than requested and the launch is aborted
- **THEN** the heuristic items are reported marked unconfirmed, and no comment is written
