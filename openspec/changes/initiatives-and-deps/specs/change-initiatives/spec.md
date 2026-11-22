## ADDED Requirements

### Requirement: Split rule
The system SHALL register rule `split` with `registerRule`, configured as `decisions.split: { mode: rule }`. Its facts SHALL be built by code from the change: the number of capabilities in `Capabilities` and the number of units in `## Units`. It SHALL return `propose` when a count exceeds `limits.max_capabilities` or `limits.max_units`, else `single`, and it MUST NOT ask. In `shape`, when the outcome is `propose` and the change has no `Initiative` line, the phase card SHALL name `initiative_propose`.

#### Scenario: Too many capabilities suggests an initiative
- **WHEN** a change in `shape` declares four capabilities and `max_capabilities` is 3
- **THEN** `split` returns `propose` and the card names `initiative_propose`

#### Scenario: Within limits
- **WHEN** a change in `shape` declares two capabilities and no units
- **THEN** `split` returns `single` and the card does not name `initiative_propose`

### Requirement: Initiative propose tool
`initiative_propose` SHALL take a kebab-case initiative name, a goal, a capability list and a list of entries. Each entry has a kebab-case change name, a non-empty short Proposal with no level-2 heading, and `Depends` given as names of other entries or as `#<n>` of existing changes. Exactly one entry SHALL be the current change, named by its title. The tool SHALL run only while the current change is in `shape`, or when the change already has an `Initiative` line (see "Initiative amendment"). It SHALL send a blocking request for the named gate `initiative` through the approver chain. The review payload SHALL show the tracking issue and every entry with its Proposal and `Depends`. It MUST refuse, writing nothing, when:
- a name is not kebab-case;
- a new entry's name equals the title of an open `livespec` issue;
- a `#<n>` in `Depends` is not a `livespec` change issue;
- a `Depends` names an unknown entry;
- the entries form a `Depends` cycle;
- a request for `gate:initiative` is pending.

`spec_gate initiative` MUST refuse and name `initiative_propose`.

#### Scenario: Proposal sent
- **WHEN** change #20 `rate-limit` is in `shape` and `initiative_propose` lists `add-request-context` and `rate-limit` with `Depends: add-request-context`
- **THEN** one pending `gate:initiative` request shows both entries, and no issue is created

#### Scenario: Cycle refused
- **WHEN** the entries say `a` depends on `b` and `b` depends on `a`
- **THEN** the tool refuses, names the cycle `a → b → a`, and requests nothing

#### Scenario: Bare spec_gate refused
- **WHEN** `spec_gate initiative` is called
- **THEN** the tool refuses and names `initiative_propose`

### Requirement: Initiative gate completion
The `initiative` gate SHALL be registered with `registerGate` and decided by a human; its result SHALL be the `gate` comment recorded with the human's adapter. When the answer is approved and valid, completion SHALL, before writing the `gate` comment and skipping each step already done:
1. find the open issue labeled `livespec:initiative` titled with the initiative name, or create it with `Goal`, `Capabilities` and an empty `## Changes` section;
2. for each entry other than the current change, in dependency order, find the open `livespec` issue with that title and `Initiative: #<T>`, or create it in `shape` with `Initiative: #<T>`, `Depends` resolved to issue numbers, `Capabilities: new [], modified []`, `Product impact: —`, the short Proposal and the empty remaining sections;
3. write the `## Changes` list of the tracking issue in dependency order, one `- [ ] #<n> <name> — Depends: <#…|—>` line per entry, through a versioned write;
4. write `Initiative: #<T>`, `Depends` and the short Proposal on the current change through a versioned write.

The answer SHALL be superseded when, at validation, an entry name other than the current change's matches an open `livespec` issue without `Initiative: #<T>`, or the resulting graph has a cycle. No unit SHALL be planned by completion.

#### Scenario: Approval creates everything at once
- **WHEN** the `initiative` request for #20 with entries `add-request-context` and `rate-limit` is approved
- **THEN** a tracking issue labeled `livespec:initiative` lists `#<a> add-request-context — Depends: —` and `#20 rate-limit — Depends: #<a>`, issue `#<a>` is in `shape` with `Initiative: #<T>`, and #20 has `Initiative: #<T>` and `Depends: #<a>`

#### Scenario: Retry after a crash
- **WHEN** completion created the tracking issue and `#<a>` and then failed, and the next poll finishes the answer
- **THEN** no second tracking issue or second `add-request-context` issue is created, and the remaining steps are applied

#### Scenario: Changes requested
- **WHEN** the human answers `changes` on the `initiative` request
- **THEN** no issue is created and the current change stays in `shape`

### Requirement: Initiative amendment
When the current change has an `Initiative: #<T>` line, `initiative_propose` SHALL send a light `initiative` request that amends #<T>, and the review payload SHALL show only the affected entries. An amendment MAY add entries, edit the Proposal of a change whose `## Units` is empty, edit the `Depends` of a change with no `Branch` line, remove an abandoned dependency from any open change's `Depends` (started or parked included), and remove the entry of an abandoned change. It MUST refuse any other edit, naming it, and any amendment that creates a cycle.

On approval, completion SHALL create the new change issues and apply the edits as in "Initiative gate completion", writing each `Depends` edit both on the change's `Depends` line and in its entry, and appending new entries to the `## Changes` list. A removed entry no longer counts toward the initiative, so the `change_close` of the last remaining change closes the initiative as change-close "Close tool" step 2 defines.

#### Scenario: New change added midway
- **WHEN** #20 is in initiative #30 and `initiative_propose` adds entry `audit-log` depending on #20, and the human approves
- **THEN** `audit-log` is created in `shape` with `Initiative: #30` and `Depends: #20`, and #30 lists it after the existing entries

#### Scenario: Abandoned dependency removed from a started change
- **WHEN** #35 has a `Branch` line and `Depends: #34`, #34 was abandoned, and the amendment removes #34 from #35's `Depends` and removes #34's entry
- **THEN** after approval #35 has `Depends: —`, its entry says `Depends: —`, and #34 is no longer listed

#### Scenario: Initiative closes after an abandoned entry is removed
- **WHEN** initiative #30 lists #34 (abandoned) and #35, an approved amendment from #35 removed #34's entry, and #35 later merges and `change_close` runs
- **THEN** #35's entry is ticked, #30 is closed with its `close-summary`, and `livespec:initiative-closed` is emitted

#### Scenario: Amendment cycle refused
- **WHEN** the amendment makes #34 depend on #35 while #35 depends on #34
- **THEN** `initiative_propose` refuses and names the cycle

#### Scenario: Planned change cannot be re-proposed
- **WHEN** the amendment edits the Proposal of an entry whose `## Units` is not empty
- **THEN** the tool refuses, names the entry and says to use `change_split` or `unit_amend`

### Requirement: Change dependencies and readiness
The dependencies of a change SHALL be the union of its `Depends` line and the `Depends` of its entry in its initiative's `## Changes` list. A dependency SHALL be **merged** when its issue is closed and its `PR` line names a pull request that the forge reports as merged. It SHALL be **abandoned** when it is closed and not merged, and **open** otherwise. A change SHALL be **ready** when every dependency is merged. An abandoned dependency MUST NOT count as merged.

#### Scenario: Waiting on an open change
- **WHEN** #35 has `Depends: #34` and #34 is open
- **THEN** #35 is not ready and #34 is reported as open

#### Scenario: Ready after merge
- **WHEN** #34 is closed and its pull request is merged
- **THEN** #35 is ready

#### Scenario: Abandoned dependency
- **WHEN** #34 was closed with `change_close --abandon` and its pull request was not merged
- **THEN** #35 is not ready and #34 is reported as abandoned

### Requirement: Depends cycle rejection
Every tool or completion that writes `Depends` (the `initiative` gate and its amendments, and option A of `new-dependency`, whose draft may give the prerequisite `Depends` on existing changes) MUST compute the dependency graph its write would produce; a tool MUST refuse, writing nothing, and a completion MUST record the answer as superseded, when the graph has a cycle. The refusal SHALL name the cycle as issue numbers or entry names joined by `→`. A change that depends on itself SHALL be a cycle.

#### Scenario: Cycle through an existing change
- **WHEN** #35 depends on #34 and `new_dependency` for #34 drafts option A with a prerequisite that depends on #35
- **THEN** the write is refused and names the cycle

#### Scenario: Self dependency
- **WHEN** an entry lists itself in `Depends`
- **THEN** `initiative_propose` refuses and names the cycle

### Requirement: Initiative progress on the card
On a change with an `Initiative` line, the phase card SHALL show the initiative number, the count of checked entries over all entries, the dependencies of this change with their state, and the entries that are ready and not started. On the open-changes list, each change SHALL show `ready`, `waits for #<n>…` or `parked`. The card SHALL only propose `change_start #<n>` and MUST NOT run it.

#### Scenario: Progress shown
- **WHEN** initiative #30 has entries #34 checked and #35 unchecked, and the card is built on #35's branch
- **THEN** the card shows `initiative #30: 1 of 2 done` and #34 as merged

#### Scenario: Ready changes proposed
- **WHEN** on `main` the open changes are #34 (open, no `Depends`) and #35 (`Depends: #34`)
- **THEN** the list shows #34 as `ready` and #35 as `waits for #34`

### Requirement: Capability overlap warning
At refresh, the system SHALL list every other open `livespec` change with a `Branch` line whose `Capabilities` share a capability name with the current change. When the list is not empty, the card and `spec_status` SHALL show a warning naming each change and the shared capabilities. The warning MUST NOT block any tool or gate.

#### Scenario: Two open changes modify the same capability
- **WHEN** #35 and #36 both declare `modified [rate-limit]` and both have a `Branch` line
- **THEN** #35's card warns that #36 also changes `rate-limit`

### Requirement: Sync with the integration branch
When the change has an initiative, another entry of it is checked, and the local `origin/<integration branch>` is not an ancestor of HEAD, the next step in `build`, `review` and `ship` SHALL be `change_sync`, ahead of the phase's own steps. `change_sync` SHALL refuse on a dirty tree, with a started unit, or outside the change branch. Otherwise it SHALL:
1. fetch the integration branch and, when its tip is not an ancestor of HEAD, run `git merge --no-edit origin/<integration branch>`; on a conflict it SHALL abort the merge, refuse, and say to merge by hand and rerun;
2. record the integration tip as the new `Base` in the issue and in the `livespecBase` git config;
3. run every done unit's `Verify` at HEAD and post one own `regression` comment with the old and new base, HEAD, and per unit the exit code, verdict and redacted output tail;
4. untick every done unit whose `Verify` was red or invalid or whose `Covers` names a requirement changed in the living specs between the old and new base, in one versioned body write, and post a `stale` comment naming those units that is not a counted iteration. When any unit was unticked and the change is in a phase after `build`, the `stale` comment SHALL also list every phase after `build` and the phase label SHALL move to `build`.

The marker kind `regression` SHALL be registered. A merge with conflicts resolved by hand SHALL need the review gate again, as ship-phase "Reviewed HEAD" defines.

#### Scenario: Sibling merged
- **WHEN** #34 of initiative #30 merged after #35's `Base`, and #35 is in `build`
- **THEN** the next step for #35 is `change_sync`

#### Scenario: Regression receipts
- **WHEN** `change_sync` merges cleanly and U1 and U2 are done
- **THEN** a `regression` comment records both units' `Verify` results, and `Base` is the integration tip

#### Scenario: Failing unit after the merge
- **WHEN** U2's `Verify` is red after the merge
- **THEN** U2 is unticked and stale, and the next step asks for `unit_amend U2`

#### Scenario: Regression during review
- **WHEN** the change is in `review`, `change_sync` runs, and U2's `Verify` is red
- **THEN** U2 is unticked and stale, a `stale` comment lists `review`, `ship` and `close`, and the change is in `build`

#### Scenario: Conflict
- **WHEN** the merge conflicts
- **THEN** the merge is aborted, the tool refuses, and HEAD and `Base` are unchanged

### Requirement: Size limits check
The system SHALL register the waivable check `size-limits` and list it in the default pack's `plan` checks. It SHALL report one error when the change has more units than `limits.max_units` and one error when it declares more capabilities than `limits.max_capabilities`, each naming the count and the limit. A limit missing from the pack MUST NOT fail. The plan gate SHALL NOT approve while `size-limits` fails unless the human chooses `waive`.

#### Scenario: Over the unit limit
- **WHEN** the plan has 9 units and `max_units` is 8, and the human approves without waiving
- **THEN** the approval is refused (or, when completed, superseded), no approved `plan` gate is recorded, and the change stays in `plan`

#### Scenario: Waived
- **WHEN** the plan has 9 units and the human chooses `waive` at the plan gate
- **THEN** the gate is approved with `size-limits` under `waivers` and the change moves to `build`

### Requirement: Change split tool
`change_split` SHALL take the issue number `#N`, a list of unit ids and a new kebab-case name, and run on `#N`'s change branch. It MUST refuse, writing nothing, when:
- a listed unit is unknown, done, started or in an open lane;
- a unit that stays lists a moved unit in `Depends`;
- the name is not kebab-case or equals an open `livespec` issue title;
- a request for `gate:plan` is pending on `#N`;
- the change is parked, or a listed unit is named by its latest `parked` record.

Otherwise it SHALL:
1. create the new change issue in `shape` with the moved unit blocks under `## Units`, their status lines pending, `Initiative` copied from `#N`, `Depends: #N` only when a moved unit lists a unit that stays in `Depends`, and `Capabilities` naming the capabilities that the moved units' `Covers` name, as `modified`, or as `new` when `#N` declares them new;
2. remove the moved units from `#N` and drop from `#N`'s `Capabilities` every capability that only moved units cover, with one versioned write;
3. post a `stale` comment on `#N` listing `plan` and every later phase, which is not a counted iteration, and, when `#N` is in a phase after `plan`, move its phase label to `plan`, so its plan gate must be approved again;
4. when `#N` has an initiative, insert the new entry right after `#N`'s entry through a versioned write; otherwise, when the new change gets `Depends: #N`, create an initiative named `<#N's name>-split` listing `#N` and then the new change, and write its `Initiative` line on both.

Spec edits on `#N`'s branch for a capability moved out stay on that branch; `capabilities-match-diff` then reports them on `#N` until they are reverted there, and the new change writes them in its own `define`.

The new change's plan gate SHALL be requested when it reaches `plan`.

#### Scenario: Split with a dependency on a unit that stays
- **WHEN** `change_split #35 --units U5,U6 --into rate-limit-admin` runs and U5 depends on U2, which stays
- **THEN** a new issue `rate-limit-admin` holds U5 and U6 with `Depends: #35`, #35 no longer has U5 and U6, and #35's plan gate must be approved again

#### Scenario: Split brings the capability count within limits
- **WHEN** #35 declares `modified [rate-limit, request-context, audit-log, admin-ui]`, `max_capabilities` is 3, and U5 and U6, the only units covering `admin-ui`, move into `rate-limit-admin`
- **THEN** #35 declares the other three capabilities, `size-limits` no longer fails on capabilities, and `rate-limit-admin` declares `modified [admin-ui]`

#### Scenario: Split during build returns to plan
- **WHEN** #35 is in `build` with U1 done and `change_split #35 --units U4 --into x` runs
- **THEN** #35 is in `plan`, U1 stays done, and the plan gate must be approved again before `build`

#### Scenario: Split refused while parked
- **WHEN** #35 is parked and `change_split #35 --units U4 --into x` runs
- **THEN** the tool refuses, names the parked state, and nothing is created

#### Scenario: Split refused when a remaining unit depends on a moved one
- **WHEN** U7 stays and lists U5 in `Depends`, and `change_split #35 --units U5 --into x` runs
- **THEN** the tool refuses, names U7 and U5, and nothing is created

#### Scenario: Started unit cannot move
- **WHEN** U5 is started and `change_split #35 --units U5 --into x` runs
- **THEN** the tool refuses and names U5
