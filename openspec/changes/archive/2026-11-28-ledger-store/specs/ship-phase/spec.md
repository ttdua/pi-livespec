## MODIFIED Requirements

### Requirement: Ship tool
`change_ship` SHALL refuse, pushing and opening nothing, unless all of these hold:
- the change is in `ship`, the tree is clean, the current branch is the issue's `Branch` line, and the issue has no `PR` line;
- the ship gate has an approved result not listed by a newer `stale` comment, and HEAD is reviewed against its `head_sha`;
- HEAD is reviewed (see "Reviewed HEAD");
- no human comment (a human voice as pull-request-feedback "Human voices" defines it: not own, by a `write` or `admin` author) on the change issue was created or edited after the valid ship gate result was written, and the issue's gate digest equals the one the ship gate request recorded;
- every file of the change diff is in some unit's `Files` (exact or glob) or under `specs/`;
- no open pull request has the change branch as head, other than one the current account opened whose body holds `Refs #<change>`.

When the freshness condition is the only reason to refuse, `change_ship` SHALL write a `stale` comment listing `ship`, so the next step asks for the ship gate again, and SHALL do nothing else.

When nothing refuses, `change_ship` SHALL first sync the change's ledger (see ledger-store "Ledger sync"); when the result is not `synced`, it MUST refuse, naming the cause, and push and open nothing. Otherwise it SHALL push the branch through `guardedPush`, open exactly one pull request from the change branch to the integration branch, and write `PR: #<n>` in the ownership lines. An open pull request the current account opened with `Refs #<change>` SHALL be adopted instead of opening a second one. The pull request body SHALL hold the Proposal's first paragraph, the units with their status, the Durable docs table, the review result of the latest routed round, and the line `Refs #<change>`, and MUST NOT hold a closing keyword (`close`, `fix` or `resolve` in any form) followed by an issue reference; such a phrase taken from the Proposal SHALL be rewritten to `Refs #<n>`. After opening it, `change_ship` SHALL post an own `ship` record with id `ship.<pr>.<pushed head>`, holding the pull request, the pushed head and the confirmation items the ship gate showed. The marker kind `ship` SHALL be registered.

#### Scenario: One pull request
- **WHEN** every refusal condition is false and `change_ship` runs
- **THEN** the branch is pushed, exactly one pull request is open for the change branch, its body says `Refs #<change>`, and the issue's ownership lines hold `PR: #<n>`

#### Scenario: Commit after the reviewed SHA
- **WHEN** the review gate's `head_sha` is `c3` and a non-merge commit `d4` is HEAD
- **THEN** `change_ship` refuses, naming `d4` and `c3`, and nothing is pushed

#### Scenario: File outside every unit
- **WHEN** the change diff modifies `src/extra.ts`, which no unit's `Files` lists and which is not under `specs/`
- **THEN** `change_ship` refuses, naming `src/extra.ts`

#### Scenario: Another pull request open
- **WHEN** someone else opened a pull request from the change branch
- **THEN** `change_ship` refuses, naming that pull request

#### Scenario: Retry after a partial ship
- **WHEN** a previous `change_ship` opened pull request 41 and failed before writing `PR: #41`
- **THEN** a second `change_ship` adopts pull request 41, writes `PR: #41`, and opens no other pull request

#### Scenario: Human comment after the ship gate
- **WHEN** after the ship gate result was written a human commented on the change issue
- **THEN** `change_ship` refuses as stale, writes a `stale` comment listing `ship`, and the next step asks to request the ship gate again

#### Scenario: Forge approval then ship
- **WHEN** a writer approved the ship gate with `/livespec approve` on the forge and nothing else changed
- **THEN** `change_ship` does not count the approval comment as new input and opens the pull request

#### Scenario: Closing keyword in the Proposal
- **WHEN** the Proposal's first paragraph says "Closes #12"
- **THEN** the pull request body says "Refs #12" and holds no closing keyword

#### Scenario: Clean merge after the ship gate
- **WHEN** the ship gate was approved at `c3` and a clean merge of `origin/main` is HEAD
- **THEN** `change_ship` does not refuse for the ship gate or for review, and opens the pull request

#### Scenario: Ledger not pushed
- **WHEN** every other refusal condition is false and `origin` rejects or cannot be reached for the ledger push
- **THEN** `change_ship` refuses, naming the ledger sync, and pushes no branch and opens no pull request

#### Scenario: Ship gate not approved
- **WHEN** the ship gate has no valid approved result
- **THEN** `change_ship` refuses, naming the ship gate
