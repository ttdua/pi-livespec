## MODIFIED Requirements

### Requirement: Close tool
`change_close` SHALL refuse, writing nothing, unless the change is in `close` and its pull request is merged, or `--abandon` applies (see "Closed without merge"). It SHALL then, skipping each step already done:
1. post an own `close-summary` comment with id `close-summary.<change>` naming the pull request, its merge time, the units, the Durable docs rows and the number of review rounds;
2. when the issue has an `Initiative` line, tick the change in the initiative's `## Changes` list with `tickChange` through a versioned body write; when every change of the initiative is then checked and the tracking issue is open, post an own `close-summary` comment with id `close-summary.initiative` on it and close it;
3. close the change issue;
4. when the project config sets `ledger.retain: false`, delete the change's ledger as ledger-store "Ledger retention" defines; a failed remote delete SHALL be named in the result and MUST NOT fail the close, and the step SHALL be skipped when no local ledger ref exists;
5. emit `livespec:change-closed` with the change, the pull request and the initiative, then `livespec:initiative-closed` with the initiative and its changes when the tracking issue holds the own `close-summary.initiative` comment.

Events SHALL be emitted only by the call that closed the change issue. The marker kind `close-summary` SHALL be registered.

#### Scenario: Close after merge
- **WHEN** the change is in `close`, pull request 41 is merged, and `change_close` runs
- **THEN** a `close-summary` comment is posted, the issue is closed, `livespec:change-closed` is emitted once, and the ledger is kept

#### Scenario: Close deletes the ledger
- **WHEN** the project config sets `ledger: { retain: false }` and `change_close` closes a merged change
- **THEN** the issue is closed and the change's ledger ref is gone locally and on `origin`

#### Scenario: Not merged
- **WHEN** `change_close` runs while pull request 41 is open
- **THEN** the tool refuses and the issue stays open

#### Scenario: Last change of an initiative
- **WHEN** the change is the last unchecked entry of initiative #30 and `change_close` runs
- **THEN** the entry is ticked, #30 gets a `close-summary` comment and is closed, and `livespec:change-closed` then `livespec:initiative-closed` are emitted

#### Scenario: Retry after a partial close
- **WHEN** a previous `change_close` posted the summary and ticked the initiative, then failed before closing the issue
- **THEN** a second `change_close` posts no second summary, ticks nothing again, closes the issue and emits `livespec:change-closed`

#### Scenario: Retry after the initiative closed
- **WHEN** a previous `change_close` closed initiative #30 and failed before closing the change issue
- **THEN** a second `change_close` closes the change issue and emits `livespec:change-closed` then `livespec:initiative-closed`
