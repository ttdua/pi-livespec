## MODIFIED Requirements

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
