## ADDED Requirements

### Requirement: Behavior conclusion parameter
`spec_gate` SHALL accept a `behavior` parameter: a list of `{ capability, outcome, rationale }` with `outcome` `unchanged` or `changed` and `rationale` one line, non-empty after trimming, of at most 300 Unicode code points. It SHALL validate the shape before running any check, refusing with the field and the rule named and writing nothing. It SHALL neutralise the rationale as agent text (request-briefing "Agent text is untrusted"). A target whose phase does not list the `behavior-change` check SHALL ignore a valid `behavior`.

#### Scenario: Rationale too long
- **WHEN** `spec_gate define` runs with a `behavior` entry whose rationale has 301 code points
- **THEN** the tool refuses naming `behavior` and the 300-character limit, runs no check, and writes nothing

#### Scenario: Flow without the check
- **WHEN** a project flow lists no `behavior-change` check in `define` and `spec_gate define` runs with one behavior item and no `behavior`
- **THEN** no `decision` record is written for it and the gate proceeds as before

### Requirement: Behavior conclusion at the gate
When the target phase lists the `behavior-change` check, `spec_gate define|review` SHALL first evaluate the gate refusals with the `behavior-change` results left out, refusing with any that applies. Then, when the change has behavior items, it SHALL refuse unless `behavior` lists each item's capability once and no other, naming each missing or extra capability. Both refusals write nothing. Otherwise it SHALL post one `agent` `decision` record per item, skipping one whose latest `agent` record at that digest has the same outcome and reason. It SHALL then refresh the state and re-run the checks and refusals, `behavior-change` included, before the gate passes or sends. It MUST NOT send a `decide:behavior-change` request.

#### Scenario: Two capabilities, no dialog
- **WHEN** the diff changes `src/limit/cap.ts` under `rate-limit` and `src/forge/read.ts` under `forge-read`, neither spec changes, and `spec_gate define` runs in session with `behavior` concluding both `unchanged` with rationales
- **THEN** two `decision` records with source `agent` are posted, no `decide:behavior-change` request is written, and the only dialog is the define gate

#### Scenario: Missing conclusion
- **WHEN** the change has behavior items for `rate-limit` and `forge-read` and `spec_gate define` runs with `behavior` listing only `rate-limit`
- **THEN** the tool refuses naming `forge-read`, and no `decision` comment or request is written

#### Scenario: Unknown capability listed
- **WHEN** the change has one behavior item for `rate-limit` and `behavior` also lists `cache`
- **THEN** the tool refuses naming `cache` and writes nothing

#### Scenario: Other refusal writes nothing
- **WHEN** `spec_gate define` runs with a valid `behavior` list and `spec-format` reports an error (or the tree is dirty, or a blocking question is open)
- **THEN** `spec_gate` refuses with that reason, and no `decision` comment is written

#### Scenario: Changed conclusion blocks the same call
- **WHEN** `spec_gate define` runs with `behavior` concluding `rate-limit` `changed` and its spec unchanged
- **THEN** the record is posted, the re-run `behavior-change` check fails, and `spec_gate` refuses naming `specs/rate-limit/spec.md` without sending the gate request

#### Scenario: Same conclusion not re-posted
- **WHEN** the latest agent record for `rate-limit` at the current digest is `unchanged` with reason R, and `spec_gate review` runs with the same outcome and rationale R
- **THEN** no new `decision` comment is posted for `rate-limit`

### Requirement: Behavior conclusion rule
The `behavior-change` decision point SHALL be registered with `registerRule`, configured as `decisions.behavior-change: { mode: rule }`, and MUST NOT ask: through `decide` it SHALL return outcome `null` with a reason naming the `behavior` parameter of `spec_gate`. A conclusion SHALL be a `decision` record with point `behavior-change`, subject the capability, source `agent`, `reviewer` or `human`, the outcome, the rationale as `reason`, the item as facts, its files as the top-level `files` field, and as digest the SHA-256 of the files joined by newlines.

#### Scenario: Rule never asks
- **WHEN** `decide("behavior-change", { capability: "rate-limit", files: ["src/limit/cap.ts"] })` runs with an asker
- **THEN** the asker is not called, and the result has outcome `null`

#### Scenario: Agent conclusion recorded
- **WHEN** `spec_gate define` records `rate-limit` `unchanged` with rationale `refactor only; scenarios green`
- **THEN** a `decision` comment holds point `behavior-change`, subject `rate-limit`, source `agent`, outcome `unchanged`, reason `refactor only; scenarios green`, the files and the digest

### Requirement: Behavior conclusion precedence
The effective conclusion of a behavior item SHALL come from its capability's valid `behavior-change` records with outcome `unchanged` or `changed` (human answers to older requests included). The candidates are those with the item's digest and facts, plus every human or reviewer `changed` record whose `files` share a file with the item. In record order, each newer candidate SHALL replace the current one unless the current one ranks higher: human `changed` 3, reviewer `changed` 2, others 1. At ship, a capability's latest conclusion SHALL use this order over all its records.

#### Scenario: Agent cannot undo a human change
- **WHEN** a human `changed` record for `rate-limit` is followed by an agent `unchanged` record for the same digest
- **THEN** the effective conclusion is `changed` with source `human`

#### Scenario: Agent cannot undo a reviewer dispute
- **WHEN** an agent `unchanged` record is followed by a reviewer `changed` record and then an agent `unchanged` record, all for the same digest
- **THEN** the effective conclusion is `changed` with source `reviewer`

#### Scenario: Adding a file does not undo a human change
- **WHEN** a human `changed` record lists `src/limit/cap.ts`, the diff now also changes `src/limit/window.ts`, and the agent concludes `rate-limit` `unchanged` for both files
- **THEN** the effective conclusion is `changed` with source `human`, and the check still names `specs/rate-limit/spec.md`

#### Scenario: Later agent record wins over an earlier agent record
- **WHEN** an agent `unchanged` record is followed by an agent `changed` record for the same digest
- **THEN** the effective conclusion is `changed` with source `agent`

#### Scenario: Old human answer still counts
- **WHEN** the only record is a human `unchanged` answer to a `decide:behavior-change.rate-limit` request written before this rule, for the item's digest and facts
- **THEN** the effective conclusion is `unchanged` with source `human`

#### Scenario: New file needs a new conclusion
- **WHEN** a record concluded `unchanged` for `[src/limit/cap.ts]` and the diff now also changes `src/limit/window.ts`
- **THEN** the item has no effective conclusion, and `spec_gate` refuses until `behavior` concludes `rate-limit` again

### Requirement: Behavior conclusion check
The `behavior-change` check SHALL report, per behavior item: an `error` naming the `behavior` parameter of `spec_gate <phase>` when the item has no effective conclusion, also naming any open `decide:behavior-change.<capability>` request sent before this rule; an `error` naming `specs/<capability>/spec.md` and the conclusion's source when the effective conclusion is `changed`; nothing when it is `unchanged`. The check SHALL NOT be waivable. The default pack SHALL list it in `define` and `review`.

#### Scenario: Unconcluded item names the parameter
- **WHEN** the change is in `define` with one behavior item for `rate-limit` and no record
- **THEN** the check reports an error naming `behavior` and `spec_gate define`, and the next step names it

#### Scenario: Behavior changed without a spec edit
- **WHEN** the effective conclusion for `rate-limit` is `changed` and the spec file is still unchanged
- **THEN** the check reports an error asking to update `specs/rate-limit/spec.md`, and the gate refuses

#### Scenario: Spec updated after a changed conclusion
- **WHEN** the effective conclusion for `rate-limit` is `changed` and the diff now changes `specs/rate-limit/spec.md`
- **THEN** the check reports nothing for `rate-limit`

### Requirement: Behavior conclusions in the reviewer packet
The packet of a `reviewer` with subject `change` SHALL hold a required source `records:behavior-conclusions`, listing each behavior item with its files and its effective conclusion (outcome, source and reason), or `none` for an item with no effective conclusion. The source SHALL be left out when the change has no behavior item.

#### Scenario: Conclusions in the packet
- **WHEN** a `change` reviewer packet is built with one behavior item for `rate-limit` concluded agent `unchanged`
- **THEN** the packet lists `records:behavior-conclusions` as required, and its text names `rate-limit`, its files, `unchanged`, `agent` and the rationale

### Requirement: Reviewer behavior conclusion
A reviewer result MAY carry `behavior` entries shaped as in "Behavior conclusion parameter"; an entry for a capability that is not a behavior item SHALL be ignored. A `changed` entry over an effective conclusion that is not `changed` SHALL need a `WARNING` or `CRITICAL` finding at one of the item's files; without one the result SHALL be returned to the child once, naming the capability, and a second miss drops the entry, noted in the `finding-summary` notes. After the `finding-summary` of a completed, non-advisory `change` run, the parent SHALL post a `reviewer` record for each entry whose outcome differs from the effective one. Only a spec edit clears it; a rebuttal MUST NOT.

#### Scenario: Reviewer disputes unchanged
- **WHEN** the effective conclusion of `rate-limit` is agent `unchanged`, and the completed `change` reviewer returns `behavior: [{ capability: rate-limit, outcome: changed, rationale: "cap now rejects at 99" }]` with a `WARNING` finding at `src/limit/cap.ts:12`
- **THEN** a `decision` record with source `reviewer` and outcome `changed` is posted, the `behavior-change` check fails naming `specs/rate-limit/spec.md`, and the review gate refuses

#### Scenario: Dispute without a finding
- **WHEN** the reviewer returns a `changed` entry for `rate-limit` over an agent `unchanged` and no `WARNING` or `CRITICAL` finding at a file of that item
- **THEN** the result is returned to the child naming `rate-limit`, and no `decision` record is posted

#### Scenario: Rebuttal does not clear a dispute
- **WHEN** a reviewer `changed` record exists for `rate-limit` and the parent rebuts the linked finding with `finding_rebut`
- **THEN** the effective conclusion stays `changed` and the `behavior-change` check still names `specs/rate-limit/spec.md`

#### Scenario: Reviewer clears an agent change
- **WHEN** the effective conclusion of `rate-limit` is agent `changed` and the completed `change` reviewer returns `unchanged` for it with no finding
- **THEN** a reviewer `unchanged` record is posted and the effective conclusion is `unchanged`

#### Scenario: Second miss drops the entry
- **WHEN** a returned reviewer submits again with the same `changed` entry for `rate-limit` and still no finding at its files
- **THEN** no `decision` record is posted for `rate-limit`, and the `finding-summary` notes name the dropped entry

#### Scenario: Reviewer cannot undo a human change
- **WHEN** the effective conclusion of `rate-limit` is human `changed` and the reviewer returns `unchanged` for it
- **THEN** a reviewer `unchanged` record is posted, the effective conclusion stays human `changed`, and the check still names `specs/rate-limit/spec.md`

#### Scenario: Entry for another capability
- **WHEN** the reviewer returns a `behavior` entry for `cache`, which is not a behavior item
- **THEN** the entry is ignored and no `decision` record is posted for `cache`

#### Scenario: Reviewer confirms
- **WHEN** the reviewer returns `unchanged` for `rate-limit`, whose effective conclusion is agent `unchanged`
- **THEN** no `decision` record is posted

### Requirement: Human behavior override
When a define gate answer with outcome `changes_requested` carries behavior overrides (approver-adapters "Behavior overrides") and is not superseded, completion SHALL post, as an effect before the `stale` and `gate` comments, a `human` `decision` record with outcome `changed` for each override of a current behavior item. The record SHALL hold the item's facts, digest and files, the reason `set by <by> at the gate`, and `overridden_by` with who, when and the previous effective outcome. Completion SHALL skip an override already recorded for the same answer, and one whose capability is no longer a behavior item.

#### Scenario: Human flips a conclusion
- **WHEN** the define gate shows `rate-limit` concluded agent `unchanged`, and the human requests changes with notes and a behavior override for `rate-limit`
- **THEN** a human `changed` record for `rate-limit` is posted, the change stays in `define`, and the next `spec_gate define` refuses naming `specs/rate-limit/spec.md` until that spec is edited

#### Scenario: Superseded answer records no override
- **WHEN** the human requests changes with a behavior override for `rate-limit`, and HEAD moved after the request was sent
- **THEN** the `gate` comment is `superseded` and no human `changed` record is posted

#### Scenario: Override completed twice
- **WHEN** the completion of that answer runs again after a crash before the `stale` comment
- **THEN** only one human `changed` record exists for that answer

## REMOVED Requirements

### Requirement: Behavior change rule

**Reason**: The rule always asked a human for a fact the diff gives (approver-adapters "Interaction contract" item 1). Replaced by "Behavior conclusion rule".

**Migration**: Stored human records stay valid conclusions ("Behavior conclusion precedence"). Packs keep `decisions.behavior-change: { mode: rule }` unchanged.

### Requirement: Behavior change question at the gate

**Reason**: The per-capability dialog asked the human what the diff answers, and humans answered without reading the diff. Replaced by "Behavior conclusion at the gate".

**Migration**: Pass `behavior` to `spec_gate define|review`. A pending request sent before this change completes as before, and its answer is read as a human conclusion.

### Requirement: Behavior change check

**Reason**: The check read only human answers and named the human question. Replaced by "Behavior conclusion check", which reads the effective conclusion of any source.

**Migration**: None for packs: the check id `behavior-change` is unchanged.
