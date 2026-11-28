## MODIFIED Requirements

### Requirement: Route effects
The route stage SHALL apply, idempotently, for every aggregate finding that is not `DISPUTED`:
- `unit`: post one own `rebuild` comment with id `rebuild.<unit>.<round>` naming the finding, then untick the unit when it is done, and list the finding in that unit's next implementer packet;
- `in-change`: nothing, the next step names `unit_amend --add`;
- `out-of-scope`: nothing, the finding is listed as a follow-up in the aggregate and at the next human gate until a gate has shown it;
- `question`: a non-blocking question, raised by livespec code through `spec_question`, with text naming `finding:<aggregateCommentId>:<index>`, the candidates `apply the proposed fix` ("The agent applies the reviewer's proposed fix in this change.") and `leave it out of this change` ("The finding is not fixed in this change."), the first recommended with the rationale `The reviewer proposed a fix; applying it keeps the change consistent.`, unless a question already names that key;
- `record`: nothing.

#### Scenario: Unit unticked
- **WHEN** a confirmed `CRITICAL` finding is routed to U2 and U2 is done
- **THEN** a `rebuild.U2.<round>` comment is posted, U2's status line is unticked, U2's next implementer packet lists the finding, and the next step in `build` is `unit_start U2`, not `unit_finish U2`

#### Scenario: Question raised once
- **WHEN** the route stage runs twice for a `question` finding
- **THEN** exactly one question names that finding

#### Scenario: Out of scope does not block
- **WHEN** the only blocking finding of the latest aggregate at HEAD is routed `out-of-scope`
- **THEN** `spec_gate review` passes and the ship gate payload lists the finding as a follow-up

#### Scenario: Routing question carries candidates
- **WHEN** a `needs-decision` finding is routed `question`
- **THEN** the question is `(non-blocking)`, and its request offers `apply the proposed fix` first, recommended, and `leave it out of this change`; either answer resolves the finding as before
