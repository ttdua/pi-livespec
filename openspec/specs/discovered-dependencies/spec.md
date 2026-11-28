# discovered-dependencies Specification

## Purpose

Defines what happens when a missing prerequisite is found during build: `new_dependency` and the `new-dependency` gate with options A to D and `split`, their follow-ups, the derived `discovered_deps` counter, `change_park` with its wip branches and `parked` record, the parked state, and `change_resume`.

## Requirements

### Requirement: New dependency tool
`new_dependency` SHALL take the evidence, an optional unit id, and a drafted proposal for each option:
- A: the prerequisite change's name, short Proposal and optional `Depends` on existing changes;
- B: the units to add;
- C: the stub amendment and the follow-up change's name and short Proposal;
- D: the action `shape` or `drop` and the reason.

It SHALL send a blocking request for the named gate `new-dependency`, registered with `registerGate` and decided by a human. The request SHALL offer the options `A`, `B`, `C` and `D`, plus `split` when at least one unit is done and one is not, each with a livespec-written description of what follows, and SHALL carry the agent's required briefing with `recommended` and `rationale` (approver-adapters "Interaction contract"); without one the tool MUST refuse, naming `briefing`, writing nothing. The recommended option SHALL be listed first; no option is labelled as a default. The review payload SHALL show each option's draft, the evidence wrapped as untrusted, and, for A without an initiative, the initiative that approval would create. It MUST refuse, writing nothing, in a child session, when a `gate:new-dependency` request is pending, when option A's draft is invalid or would create a `Depends` cycle, or when the `discovered_deps` cap blocks. `spec_gate new-dependency` MUST refuse and name `new_dependency`.

#### Scenario: Gate sent with default A
- **WHEN** U3's implementer returned `BLOCKED` with `missing-prerequisite` and `new_dependency` runs with drafts for A to D
- **THEN** with a briefing recommending A, one pending `gate:new-dependency` request offers A first, recommended, then B, C and D, each described

#### Scenario: Split offered at the finished boundary
- **WHEN** U1 and U2 are done, U3 is pending, and `new_dependency` runs
- **THEN** the request also offers `split`

#### Scenario: New dependency without a briefing
- **WHEN** `new_dependency` runs with valid drafts and no briefing
- **THEN** the tool refuses, names `briefing`, and writes nothing

### Requirement: New dependency options
When the `new-dependency` answer is approved and valid, completion SHALL apply the chosen option before writing the `gate` comment, skipping each step already done:
- `A`: create the prerequisite change in `shape`. When the change has an initiative, add the prerequisite entry to it before the change's entry. Otherwise create an initiative named `<change>-deps` whose `## Changes` lists the prerequisite and then the change, and write `Initiative: #<T>` on the change. Then add `#<new>` to the change's `Depends` line and to its entry's `Depends` in the `## Changes` list. This write SHALL be allowed on a started change, as the one exception to change-initiatives "Initiative amendment";
- `B`: nothing; the next step SHALL name `unit_amend --add`;
- `C`: create the follow-up change in `shape` with no `Depends`; the next step SHALL name `unit_amend` for the stub;
- `D` with `shape`: post a `stale` comment listing `shape` and every later phase, which is not a counted iteration, and move the phase label to `shape`;
- `D` with `drop`: nothing; the next step SHALL name `change_close --abandon <reason>`;
- `split`: nothing; the next step SHALL name `change_split` with the units not done.

After an approved `A`, the next step SHALL be `change_park`.

#### Scenario: Option A without an initiative
- **WHEN** change #40 `per-ip-cap` has no initiative and the human chooses A with prerequisite `token-store`
- **THEN** `token-store` is created in `shape`, an initiative `per-ip-cap-deps` lists `#<t> token-store — Depends: —` then `#40 per-ip-cap — Depends: #<t>`, #40 has `Initiative` and `Depends: #<t>`, and the next step is `change_park`

#### Scenario: Option A inside an initiative
- **WHEN** change #40 is the entry `- [ ] #40 per-ip-cap — Depends: #34` of initiative #30 and the human chooses A with prerequisite `token-store`
- **THEN** #30 lists `#<t> token-store` before #40, #40's entry and its `Depends` line both name #34 and #<t>

#### Scenario: Option B
- **WHEN** the human chooses B
- **THEN** no issue is created and the next step names `unit_amend --add`

#### Scenario: Option D back to shape
- **WHEN** the change is in `build` with an approved `shape` gate and the human chooses D with action `shape`
- **THEN** a `stale` comment lists `shape` and every later phase, the change is in `shape`, it does not advance until the `shape` gate passes again, and `change_iterations` is unchanged

### Requirement: New dependency follow-up
After a valid approved `new-dependency` result, the next step SHALL name the follow-up of its choice until that follow-up is done:
- `A`: `change_park`, done when a `parked` record is newer than the result;
- `B` and `C`: `unit_amend`, done when an approved `amendment` result is newer than the result;
- `D` with `drop`: `change_close --abandon <reason>`, done when the issue is closed;
- `split`: `change_split` with the units not done, done when a `stale` comment listing `plan` is newer than the result.

`D` with `shape` has no follow-up beyond the phase move.

#### Scenario: Follow-up of B ends with the amendment
- **WHEN** the human chose B and a later `unit_amend --add` was approved
- **THEN** the next step no longer names `unit_amend` for the dependency

### Requirement: Discovered dependencies counter
`discovered_deps` SHALL be derived as the number of valid approved `new-dependency` gate results whose choice is `A`, `B`, `C` or `split`; an own `counter` comment for it MUST be ignored. The engine SHALL report it with its cap `loops.discovered_deps`. The cap SHALL block when the count is at least the cap and no stuck answer with a chosen option is dated after the latest counted result. While it blocks, `new_dependency` MUST refuse and the next step after a `missing-prerequisite` result SHALL name `spec_stuck`, so the human can send the work back to the initiative's shape.

#### Scenario: Counter shown
- **WHEN** one `new-dependency` gate was approved with choice A
- **THEN** `nextStep` reports `discovered_deps` as 1 of 2

#### Scenario: Cap exceeded
- **WHEN** two `new-dependency` gates were approved with choices A and B, and a third prerequisite is found
- **THEN** `new_dependency` refuses and names `spec_stuck`

#### Scenario: Option D does not count
- **WHEN** the only `new-dependency` result chose D
- **THEN** `discovered_deps` is 0

### Requirement: Park tool
`change_park` SHALL run only in the parent session on the change branch, when the latest valid `new-dependency` result chose `A` and no `parked` record newer than it exists. For every in-progress unit (an open lane, or a started unit in the change worktree) that has commits since its pre SHA or uncommitted work, it SHALL:
- in that unit's worktree, create branch `livespec/<change>--wip-<unit>` at HEAD;
- commit every tracked and untracked file not ignored by git;
- push the branch through `guardedPush` with refspec `HEAD:refs/heads/livespec/<change>--wip-<unit>`.

It SHALL then switch the change worktree back to the change branch, close each open lane record with `closed: true` and outcome `parked`, remove its worktree and delete its local `--lane-<unit>` branch (the wip branch keeps its commits), add the label `livespec:parked`, and post one own `parked` comment last. That comment holds what the change waits for, each unit with its wip branch and head, and the time. Finished units SHALL keep their commits and receipts. Each step SHALL be skipped when already done, so a rerun after a crash completes the park. The marker kind `parked` SHALL be registered.

#### Scenario: Two lanes in progress
- **WHEN** U2 and U3 are started in open lanes, U2's lane has one commit and U3's lane has uncommitted edits, and `change_park` runs after option A for #41
- **THEN** `livespec/per-ip-cap--wip-U2` and `livespec/per-ip-cap--wip-U3` are pushed holding that work, both lanes are closed as `parked`, the issue has label `livespec:parked`, and a `parked` comment names #41, U2 and U3

#### Scenario: Unit with no work is not branched
- **WHEN** U4 is started in the change worktree with no commit since its pre SHA and a clean tree
- **THEN** no wip branch is created for U4 and the `parked` record lists it without a branch

#### Scenario: Rerun after a failed push
- **WHEN** a previous `change_park` pushed U2's branch and failed before U3's push
- **THEN** a second `change_park` reuses U2's wip branch, pushes U3's, and posts one `parked` comment

### Requirement: Parked state
A change SHALL be parked while its latest own `parked` record is not a resume. While parked:
- units the record lists SHALL count as pending, not started, and their attempt counters MUST NOT increase;
- the next step SHALL say which changes it waits for, or, once every one is merged, that a human runs `change_resume #<n>`;
- the phase card in every session SHALL show the parked state and its wip branches;
- `change_start`, `unit_start`, `unit_finish`, `change_split` and every gate except `new-dependency` and `initiative` MUST refuse; `new_dependency` and `initiative_propose` SHALL still run.

The changes a parked change waits for SHALL be its current dependencies that the `parked` record names; a dependency removed from `Depends` after the park SHALL no longer be waited for.

#### Scenario: Card while waiting
- **WHEN** #40 is parked waiting for #41 and #41 is open
- **THEN** the card shows that #40 is parked, waits for #41, and lists its wip branches

#### Scenario: Abandoned prerequisite removed
- **WHEN** #40 is parked waiting for #41, #41 is abandoned, and an approved initiative amendment removes #41 from #40's `Depends`
- **THEN** #40 no longer waits for any change, and the next step says a human runs `change_resume #40`

#### Scenario: Resume proposed
- **WHEN** #41 is closed with a merged pull request
- **THEN** the next step for #40 says a human runs `change_resume #40`

### Requirement: Resume tool
`change_resume #N` SHALL run in the parent session on `#N`'s change branch and MUST refuse unless the change is parked, every change it waits for is merged, and the tree is clean. It SHALL then:
1. merge the integration branch in, record the new `Base`, post a `regression` comment for every finished unit and make stale the finished units whose `Verify` fails or whose covered requirement the prerequisite changed, as change-initiatives "Sync with the integration branch" defines;
2. merge each wip branch of the `parked` record into the change branch with `git merge --no-ff --no-edit`, in unit order, skipping branches already merged;
3. delete each remote wip branch of the `parked` record on `origin` through the guarded delete (command-guards "Guarded push"), in unit order;
4. post a `parked` comment marked as a resume and remove the label `livespec:parked`.

On a merge conflict it SHALL abort that merge, refuse, name the branch, and leave the change parked. After resume, a unit the `parked` record lists SHALL be startable with a green `Verify`, recorded with verdict `resumed` (unit-evidence "Unit start tool").

Step 3 SHALL consider only the units of the `parked` record that list a branch and a head; units without them have no wip branch and are ignored. It SHALL delete a remote wip branch only when all of the following hold:
- its unit is a unit id of the change issue;
- the record's branch equals `<Branch line>--wip-<unit>`;
- the record's head is a full commit sha (40 or 64 hex digits);
- the remote head equals that recorded head, held as a lease so that a push in between is not deleted.

A remote wip branch that no longer exists, including one found gone after a rejected delete, SHALL count as deleted. A record entry that fails one of the first three checks MUST NOT be passed to the guarded delete (step 2 is unchanged by these checks). Such an entry, and a branch whose remote head differs from the recorded head (including one that moved between the read and the delete), SHALL be kept, MUST NOT refuse the resume, and SHALL be named in the result as kept. Any other failure to read or delete a branch SHALL refuse, name the branch, and leave the change parked; a rerun SHALL skip the wip merges and the branches already done. Local wip branches are not deleted.

#### Scenario: Resume with two lanes keeps all work
- **WHEN** #40 was parked with wip branches for U2 and U3, #41 merged, and `change_resume #40` runs
- **THEN** HEAD contains the integration tip, U2's wip commit and U3's wip edits, a `regression` comment covers the finished units, and the change is no longer parked

#### Scenario: Remote wip branches deleted after resume
- **WHEN** #40 was parked with wip branches for U2 and U3, #41 merged, and `change_resume #40` succeeds
- **THEN** neither `livespec/per-ip-cap--wip-U2` nor `livespec/per-ip-cap--wip-U3` exists on `origin`, and the result names both as deleted

#### Scenario: Wip branch already gone
- **WHEN** a human deleted `livespec/per-ip-cap--wip-U2` on `origin` before `change_resume #40` runs
- **THEN** the resume succeeds, U3's wip branch is deleted, and no error names U2's branch

#### Scenario: Wip branch moved since the park
- **WHEN** someone pushed a new commit to `livespec/per-ip-cap--wip-U3` after the park, and `change_resume #40` runs
- **THEN** the resume succeeds, U3's wip branch stays on `origin` at the new commit, and the result names it as kept because its head moved

#### Scenario: Record entry that is not a wip branch of the change
- **WHEN** the latest `parked` record of #40 lists U2 with branch `main`, and `change_resume #40` runs
- **THEN** the resume succeeds, `main` on `origin` is unchanged, and the result names `main` as kept

#### Scenario: Delete fails and rerun completes
- **WHEN** every wip branch is merged and deleting U2's wip branch fails because `origin` cannot be reached
- **THEN** `change_resume` refuses naming U2's branch and the change stays parked; a rerun once `origin` is reachable merges nothing again, deletes both wip branches and resumes the change

#### Scenario: Prerequisite not merged
- **WHEN** #41 is still open and `change_resume #40` runs
- **THEN** the tool refuses, names #41, and changes nothing

#### Scenario: Finished unit regresses
- **WHEN** U1 was finished before the park and its `Verify` is red after the integration merge
- **THEN** U1 is unticked and stale, and the next step asks for `unit_amend U1`
