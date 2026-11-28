## MODIFIED Requirements

### Requirement: Tags re-checked at review
The start stage SHALL run the `tags` rule over the files of `git diff <Base>..HEAD` (as `Files`, with no title, `Covers` or `Done means` text) and record the tags no unit carries, possibly none, in one `decision` ledger entry `tags.review` with source `rule`, posted every round (the latest wins). These tags SHALL count for reviewer selection. Unit bodies and unit decision records MUST NOT change.

#### Scenario: Auth file without a security tag
- **WHEN** no unit has tag `security` and the change's diff modifies `src/auth/session.ts`
- **THEN** the `tags.review` record holds `security`, `persona:security-auditor` is selected, and no unit's `Tags` line changes

### Requirement: Review round cap
`review_rounds` SHALL be derived as the number of aggregate records newer than the latest stuck answer, with outcome `approved` or `approved_with_notes` and a chosen option, to a stuck report sent while the cap blocked; a `counter` entry `review_rounds` MUST be ignored. The cap SHALL block when `review_rounds` has reached `loops.review_rounds`, the latest round is routed, and its aggregate left a blocking finding routed `unit` or `in-change`, whatever HEAD is now. While it blocks, `spec_review` MUST NOT start a new round and the next step SHALL be `spec_stuck`.

#### Scenario: Cap reached
- **WHEN** `loops.review_rounds` is 3, the third round is routed, and its aggregate still has a blocking `unit` finding that unticked U2
- **THEN** the next step asks for a stuck report with `spec_stuck`, not a return to `build`, and `spec_review` refuses to start round 4

#### Scenario: Last round finishes before the cap
- **WHEN** `loops.review_rounds` is 3 and round 3's aggregate is posted but its verifiers have not run
- **THEN** the next step is `spec_review`, which runs the verify and route stages of round 3

#### Scenario: Stuck answer restarts the budget
- **WHEN** after that, a stuck report is answered with outcome `approved` and choice `A`
- **THEN** `review_rounds` reads 0 and `spec_review` may start round 4
