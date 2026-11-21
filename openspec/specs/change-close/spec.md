# change-close Specification

## Purpose

Defines how a change ends after a human merges: merge detection, a pull request closed without merge, `change_close` and `--abandon`, the `close-summary` record, the initiative tick and close, and the change-closed and initiative-closed events.

## Requirements

### Requirement: Pull request outcome
A human SHALL always merge the pull request on the forge; no livespec tool merges. The pull request state read with `getPullRequest` at `session_start` and on `/livespec next` SHALL decide, in any phase before `close` and before every other next-step rule but the label repair:
- merged: the next step moves the change to `close`, through `advancePhase` with the merged flag;
- closed and not merged: the next step says to reopen the pull request on the forge or to abandon the change with `change_close --abandon <reason>`; no second pull request SHALL be opened.

Before `change_close`, the change issue MUST stay open.

#### Scenario: Human merged
- **WHEN** a human merges pull request 41 of a change in `ship` and the session starts
- **THEN** the change moves to `close`, the issue stays open, and the next step is `change_close`

#### Scenario: Merged during a fix round
- **WHEN** the change is in `build` after a feedback round and a human merges pull request 41
- **THEN** the change moves to `close`

### Requirement: Close tool
`change_close` SHALL refuse, writing nothing, unless the change is in `close` and its pull request is merged, or `--abandon` applies (see "Closed without merge"). It SHALL then, skipping each step already done:
1. post an own `close-summary` comment with id `close-summary.<change>` naming the pull request, its merge time, the units, the Durable docs rows and the number of review rounds;
2. when the issue has an `Initiative` line, tick the change in the initiative's `## Changes` list with `tickChange` through a versioned body write; when every change of the initiative is then checked and the tracking issue is open, post an own `close-summary` comment with id `close-summary.initiative` on it and close it;
3. close the change issue;
4. emit `livespec:change-closed` with the change, the pull request and the initiative, then `livespec:initiative-closed` with the initiative and its changes when the tracking issue holds the own `close-summary.initiative` comment.

Events SHALL be emitted only by the call that closed the change issue. The marker kind `close-summary` SHALL be registered.

#### Scenario: Close after merge
- **WHEN** the change is in `close`, pull request 41 is merged, and `change_close` runs
- **THEN** a `close-summary` comment is posted, the issue is closed, and `livespec:change-closed` is emitted once

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

### Requirement: Closed without merge
When the pull request is closed and not merged, the phase SHALL NOT move. When a human reopens the pull request, the flow SHALL continue with that pull request. `change_close --abandon <reason>` SHALL accept a change in any phase whose pull request is closed and not merged, refuse an empty reason, post the `close-summary` with the reason, close the issue without ticking the initiative, and emit `livespec:change-closed` marked abandoned. What an initiative does with an abandoned change is left to the initiatives change (LS-09c).

#### Scenario: Pull request closed unmerged
- **WHEN** a human closes pull request 41 without merging
- **THEN** the change stays in its phase and the next step says to reopen #41 on the forge or run `change_close --abandon <reason>`

#### Scenario: Abandoned change has nothing left to do
- **WHEN** the change was abandoned in `ship` and its issue is closed
- **THEN** the next step no longer asks to reopen or abandon the pull request

#### Scenario: Abandon
- **WHEN** `change_close --abandon "superseded by #50"` runs for that change
- **THEN** the `close-summary` holds the reason, the initiative entry stays unchecked, the issue is closed, and `livespec:change-closed` is emitted with `abandoned: true`

### Requirement: Close next steps
In the `close` phase, the next step SHALL be `change_close` while the change issue is open, and SHALL say the flow has no further phase once it is closed.

#### Scenario: Close pending
- **WHEN** the change is in `close` and its issue is open
- **THEN** the next sentence asks to run `change_close`
