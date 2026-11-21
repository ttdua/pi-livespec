# pull-request-feedback Specification

## Purpose

Defines how pull request feedback reaches a change: the feedback poll, which pull request comments and checks count as human voices, how they become findings, ingest-once keys, and the feedback round that sends the change back to review.

## Requirements

### Requirement: Feedback poll
The system SHALL poll pull request feedback at `session_start` after the approval poll, when `/livespec next` runs, and first in `change_push`. A poll SHALL run only when the change is in `ship`, its `PR` line names an open pull request that is not merged, the tree is clean, the forge is writable, and no review round is unrouted, except an unrouted feedback round whose `stale` comment or move to `review` is missing, which the poll SHALL finish. Concurrent callers in one session SHALL share one run. A failed poll SHALL be recorded and MUST NOT fail the hook or command; `change_push` SHALL refuse after a failed poll.

#### Scenario: Not in ship
- **WHEN** the change is in `build` and a human commented on its pull request
- **THEN** the poll ingests nothing

#### Scenario: Poll fails at session start
- **WHEN** reading the pull request's comments fails at `session_start`
- **THEN** the failure is recorded, the session starts, and the phase card is shown

### Requirement: Human voices
A pull request comment, review or review comment SHALL be the plugin's own when its author is the current login and its body holds a livespec marker; every other one SHALL be a human voice. A human voice SHALL count only when its author has `write` or `admin` permission, read once per author per poll and failing closed. Own items MUST NOT become feedback.

#### Scenario: Shared account
- **WHEN** the human uses the same account as the plugin and writes a review comment without a marker
- **THEN** the comment counts as human feedback

#### Scenario: Own finding comment
- **WHEN** the route stage posted a review comment with a `livespec:finding` marker
- **THEN** the poll does not ingest it

#### Scenario: Reader comment
- **WHEN** an author with `read` permission comments on the pull request
- **THEN** the poll does not ingest it

### Requirement: Feedback findings
The poll SHALL map, at the current HEAD:
- a human review comment with a path and line to a `WARNING` `defect` finding at `<path>:<line>`;
- a human conversation comment, or a non-empty body of a human review that is not `approved`, to a `WARNING` `other` finding at `pr#<n>` with scope `needs-decision`;
- a check of the pushed head with state `failure` to a `CRITICAL` `defect` finding at `check:<name>`.

Each finding's evidence SHALL hold the human text inside `<untrusted>` wrapping, or the check name and link. Each item SHALL have a key: `review-comment:<id>@<version>`, `comment:<id>@<version>` or `review:<id>@<version>`, and `check:<pushed head>:<name>`. An item whose key any earlier feedback round lists MUST NOT be ingested again; an edited comment has a new key.

#### Scenario: Located review comment
- **WHEN** a writer leaves a review comment at `src/limit.ts:12`
- **THEN** the feedback round holds a `WARNING` at `src/limit.ts:12`, which routes to the unit whose `Files` list that file

#### Scenario: Comment without location
- **WHEN** a writer comments "should the cap be per user instead?" on the pull request
- **THEN** the feedback round holds a `needs-decision` finding, and routing raises a question `Q<n>` naming it

#### Scenario: Approved review body
- **WHEN** a writer approves the pull request with the body "LGTM"
- **THEN** the poll ingests nothing for it

#### Scenario: Failing CI check
- **WHEN** the check `ci/test` of the pushed head fails
- **THEN** the feedback round holds a `CRITICAL` finding at `check:ci/test`, routed `in-change`

#### Scenario: Polled twice
- **WHEN** the poll runs twice with no new or edited comment and no new failing check
- **THEN** exactly one feedback round exists

#### Scenario: Edited comment
- **WHEN** a writer edits an ingested review comment
- **THEN** the next poll ingests it again as new feedback

### Requirement: Feedback round
When a poll finds items not yet ingested, it SHALL post, in order:
1. a `review-run` record for the next round number, with the current HEAD, `source: pull-request`, no selected reviewers, the findings as its parent findings, and the keys of the ingested items;
2. a `stale` comment listing `review` and `ship`;
3. a move of the change to `review` with `advancePhase`.

The poll SHALL post the round even when the `review_rounds` cap blocks, so feedback is never lost; the cap then holds the next step at `spec_stuck` as review-phase "Review round cap" says, and `spec_review` still runs the aggregate and route stages of that round. The round SHALL then follow review-phase as any round: `spec_review` aggregates it with no reviewers, the findings skip the verifier as parent findings, they are routed with `routeFinding`, and the round counts in `review_rounds`. Fixes SHALL be made on the same branch and reach the same pull request through `change_push`.

#### Scenario: Back to review
- **WHEN** the poll ingests a failing check while the change is in `ship`
- **THEN** a feedback `review-run` and a `stale` comment for `review` and `ship` are posted, the change moves to `review`, and the next step is `spec_review`

#### Scenario: Counts toward the cap
- **WHEN** `loops.review_rounds` is 3, two review rounds exist, and a feedback round leaves a blocking `in-change` finding
- **THEN** `review_rounds` is 3 and the cap blocks a fourth round until a stuck report is answered

#### Scenario: Same pull request
- **WHEN** the feedback round's finding is fixed and the review gate passes at the new HEAD
- **THEN** the next step is `change_push` to the same pull request, and no second pull request is opened
