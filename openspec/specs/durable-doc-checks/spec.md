# durable-doc-checks Specification

## Purpose

Defines the define-time checks of durable docs: the `product-impact` check, the warning-only `glossary-terms` check with its define gate section, and the `behavior-change` facts, the agent's per-capability conclusion at `spec_gate` (whether code under the capability's `paths` changed its behavior), its precedence, the check, the reviewer packet source, and how a conclusion is disputed at the gate.

## Requirements

### Requirement: Product impact check
The `product-impact` check SHALL read the change issue's `Product impact` line and report an error with severity `error` when the line is missing, is `—` or empty, or is neither `updated` nor `none — <reason>` with a non-empty reason. It SHALL also report an error when the value is `none — <reason>` and the `Capabilities` line has a `new` entry. The check SHALL NOT be waivable. The default pack SHALL list it in `define` and `review`, so a failing result blocks the define gate.

#### Scenario: Missing product impact blocks the define gate
- **WHEN** the change is in `define`, every other define check passes, and the `Product impact` line is `—`
- **THEN** `product-impact` reports an error and `spec_gate define` refuses, naming the check

#### Scenario: None with a reason
- **WHEN** `Product impact: none — internal refactor` and `Capabilities: new [], modified [rate-limit]`
- **THEN** `product-impact` reports nothing

#### Scenario: None with a new capability
- **WHEN** `Product impact: none — small` and `Capabilities: new [cache], modified []`
- **THEN** `product-impact` reports an error naming the new capability `cache`

#### Scenario: Updated
- **WHEN** `Product impact: updated`
- **THEN** `product-impact` reports nothing

### Requirement: Glossary terms check
The `glossary-terms` check SHALL read the lines that `git diff <Base>..HEAD -- specs/` adds to `specs/<capability>/spec.md` files, outside front matter, and report a `warning` for each candidate term the glossary lacks:
- a bold term `**X**`, other than `WHEN`, `THEN`, `AND` and `GIVEN`;
- a capitalized word that is not the first word of a sentence, not inside backticks, not all capitals, and that occurs nowhere under `specs/` at `Base`.

A glossary entry matches a candidate when it is equal ignoring case and a trailing `s`. The check MUST NOT report `error`. The define gate payload SHALL hold a "Glossary" section listing the warnings and the entries the specs diff adds to `specs/glossary.md`; approving the define gate SHALL be the human's approval of those entries.

#### Scenario: New bold term warns
- **WHEN** the specs diff adds the requirement line `Each **Token bucket** refills every second.` and the glossary has no `Token bucket` entry
- **THEN** `glossary-terms` reports a warning naming `Token bucket`, and the define gate is not refused because of it

#### Scenario: Known term
- **WHEN** the added line holds `**Unit**` and the glossary has the entry `- **Units**: ...`
- **THEN** `glossary-terms` reports nothing for `Unit`

#### Scenario: New proper noun warns
- **WHEN** the specs diff adds `Requests go through the Gateway first.`, `Gateway` occurs nowhere under `specs/` at `Base`, and the glossary has no such entry
- **THEN** `glossary-terms` reports a warning naming `Gateway`

#### Scenario: Proper noun exclusions
- **WHEN** the added line is `Clients call `RateLimiter` and the API once.`, and `Clients` starts the sentence
- **THEN** `glossary-terms` reports nothing for `Clients` (sentence start), `RateLimiter` (backticks) or `API` (all capitals)

#### Scenario: Scenario keywords ignored
- **WHEN** the added lines are `- **WHEN** a request arrives` and `- **THEN** it is rejected`
- **THEN** `glossary-terms` reports nothing

#### Scenario: Proposed entries shown at the gate
- **WHEN** the specs diff adds `- **Token bucket**: a refilling request budget` to `specs/glossary.md` and `spec_gate define` sends its request
- **THEN** the request's payload has a "Glossary" section listing that entry

### Requirement: Behavior change facts
For a change, the system SHALL compute the behavior facts: for each living spec whose `paths` match a changed file of `git diff <Base>..HEAD` that is not under `specs/`, while `specs/<capability>/spec.md` is not in that diff, one item `{ capability, files }` with the matching files sorted. A capability whose `spec.md` is in the diff SHALL have no item.

#### Scenario: Code changed, spec unchanged
- **WHEN** `specs/rate-limit/spec.md` has `paths: [src/limit/**]`, the diff changes `src/limit/cap.ts`, and the spec file is unchanged
- **THEN** the facts hold `{ capability: rate-limit, files: [src/limit/cap.ts] }`

#### Scenario: Spec changed too
- **WHEN** the diff changes `src/limit/cap.ts` and `specs/rate-limit/spec.md`
- **THEN** the facts hold no item for `rate-limit`

### Requirement: Behavior conclusion parameter
`spec_gate` SHALL accept a `behavior` parameter: a list of `{ capability, outcome, rationale }` with `outcome` `unchanged` or `changed` and `rationale` one line, non-empty after trimming, of at most 300 Unicode code points. It SHALL validate the shape before running any check, refusing with the field and the rule named and writing nothing. It SHALL neutralise the rationale as agent text (request-briefing "Agent text is untrusted"). A target whose phase does not list the `behavior-change` check SHALL ignore a valid `behavior`.

#### Scenario: Rationale too long
- **WHEN** `spec_gate define` runs with a `behavior` entry whose rationale has 301 code points
- **THEN** the tool refuses naming `behavior` and the 300-character limit, runs no check, and writes nothing

#### Scenario: Flow without the check
- **WHEN** a project flow lists no `behavior-change` check in `define` and `spec_gate define` runs with one behavior item and no `behavior`
- **THEN** no `decision` record is written for it and the gate proceeds as before

### Requirement: Behavior conclusion at the gate
When the target phase lists the `behavior-change` check, `spec_gate define|review` SHALL first evaluate the gate refusals with the `behavior-change` results left out, refusing with any that applies. Then, when the change has behavior items, it SHALL refuse unless `behavior` lists each item's capability once and no other, naming each missing or extra capability. It SHALL also refuse while an open legacy `decide:behavior-change.<capability>` request exists for a current behavior item, naming the request and telling the human to answer or dismiss it. These refusals write nothing. Otherwise it SHALL post one `agent` `decision` record per item, skipping one whose latest `agent` record at that digest has the same outcome and reason. It SHALL then refresh the state and re-run the checks and refusals, `behavior-change` included, before the gate passes or sends. It MUST NOT send a `decide:behavior-change` request.

#### Scenario: Two capabilities, no dialog
- **WHEN** the diff changes `src/limit/cap.ts` under `rate-limit` and `src/forge/read.ts` under `forge-read`, neither spec changes, and `spec_gate define` runs in session with `behavior` concluding both `unchanged` with rationales
- **THEN** two `decision` records with source `agent` are posted, no `decide:behavior-change` request is written, and the only dialog is the define gate

#### Scenario: Missing conclusion
- **WHEN** the change has behavior items for `rate-limit` and `forge-read` and `spec_gate define` runs with `behavior` listing only `rate-limit`
- **THEN** the tool refuses naming `forge-read`, and no `decision` entry or request is written

#### Scenario: Unknown capability listed
- **WHEN** the change has one behavior item for `rate-limit` and `behavior` also lists `cache`
- **THEN** the tool refuses naming `cache` and writes nothing

#### Scenario: Legacy request still open
- **WHEN** a `decide:behavior-change.rate-limit` request from before this rule is still open, `rate-limit` is a behavior item, and `spec_gate define` runs with a valid `behavior` list
- **THEN** the tool refuses naming that request and saying to answer or dismiss it, and no `decision` entry or request is written

#### Scenario: Other refusal writes nothing
- **WHEN** `spec_gate define` runs with a valid `behavior` list and `spec-format` reports an error (or the tree is dirty, or a blocking question is open)
- **THEN** `spec_gate` refuses with that reason, and no `decision` entry is written

#### Scenario: Changed conclusion blocks the same call
- **WHEN** `spec_gate define` runs with `behavior` concluding `rate-limit` `changed` and its spec unchanged
- **THEN** the record is posted, the re-run `behavior-change` check fails, and `spec_gate` refuses naming `specs/rate-limit/spec.md` without sending the gate request

#### Scenario: Same conclusion not re-posted
- **WHEN** the latest agent record for `rate-limit` at the current digest is `unchanged` with reason R, and `spec_gate review` runs with the same outcome and rationale R
- **THEN** no new `decision` entry is appended for `rate-limit`

### Requirement: Behavior conclusion rule
The `behavior-change` decision point SHALL be registered with `registerRule`, configured as `decisions.behavior-change: { mode: rule }`, and MUST NOT ask: through `decide` it SHALL return outcome `null` with a reason naming the `behavior` parameter of `spec_gate`. A conclusion SHALL be a `decision` ledger entry with point `behavior-change`, subject the capability, source `agent`, the outcome, the rationale as `reason`, the item as facts, its files as the top-level `files` field, and as digest the SHA-256 of the files joined by newlines. A human answer to a `decide:behavior-change` request sent before this rule SHALL still count as a conclusion with source `human`.

#### Scenario: Rule never asks
- **WHEN** `decide("behavior-change", { capability: "rate-limit", files: ["src/limit/cap.ts"] })` runs with an asker
- **THEN** the asker is not called, and the result has outcome `null`

#### Scenario: Agent conclusion recorded
- **WHEN** `spec_gate define` records `rate-limit` `unchanged` with rationale `refactor only; scenarios green`
- **THEN** a `decision` ledger entry holds point `behavior-change`, subject `rate-limit`, source `agent`, outcome `unchanged`, reason `refactor only; scenarios green`, the files and the digest

### Requirement: Behavior conclusion precedence
The effective conclusion of a behavior item SHALL come from its capability's valid `behavior-change` records with outcome `unchanged` or `changed`: those with the item's digest and facts, plus every human `changed` record whose `files` share a file with the item. The latest candidate SHALL win, except that a human `changed` MUST NOT be replaced by an agent record. At ship, a capability's latest conclusion SHALL use this order over all its records.

#### Scenario: Agent re-concludes after request changes
- **WHEN** an agent `unchanged` record for `rate-limit` is followed by an agent `changed` record for the same digest
- **THEN** the effective conclusion is `changed` with source `agent`

#### Scenario: Agent cannot undo a human change
- **WHEN** a human `changed` answer for `rate-limit`, written before this rule, is followed by an agent `unchanged` record for the same files or a superset of them
- **THEN** the effective conclusion is `changed` with source `human`, and the check still names `specs/rate-limit/spec.md`

#### Scenario: Old human answer still counts
- **WHEN** the only record is a human `unchanged` answer to a `decide:behavior-change.rate-limit` request written before this rule, for the item's digest and facts
- **THEN** the effective conclusion is `unchanged` with source `human`

#### Scenario: New file needs a new conclusion
- **WHEN** a record concluded `unchanged` for `[src/limit/cap.ts]` and the diff now also changes `src/limit/window.ts`
- **THEN** the item has no effective conclusion, and `spec_gate` refuses until `behavior` concludes `rate-limit` again

### Requirement: Behavior conclusion check
The `behavior-change` check SHALL report, per behavior item: an `error` naming the `behavior` parameter of `spec_gate <phase>` when the item has no effective conclusion, also naming any open `decide:behavior-change.<capability>` request sent before this rule; an `error` naming `specs/<capability>/spec.md` when the effective conclusion is `changed`; nothing when it is `unchanged`. The check SHALL NOT be waivable. The default pack SHALL list it in `define` and `review`.

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
The packet of a `reviewer` with subject `change` SHALL hold a required source `records:behavior-conclusions`, listing each behavior item with its files and its effective conclusion (outcome, source and reason), or `none` for an item with no effective conclusion. The source SHALL be left out when the change has no behavior item. The rubric of the `change` subject SHALL say that a conclusion the reviewer disputes is reported as a `WARNING` finding located at one of the item's files, so the dispute blocks review as review-findings "Blocking findings" defines.

#### Scenario: Conclusions in the packet
- **WHEN** a `change` reviewer packet is built with one behavior item for `rate-limit` concluded agent `unchanged`
- **THEN** the packet lists `records:behavior-conclusions` as required, and its text names `rate-limit`, its files, `unchanged`, `agent` and the rationale

#### Scenario: Rubric names the dispute
- **WHEN** a `change` reviewer packet is built for a change with a behavior item
- **THEN** its rubric says to report a disputed behavior conclusion as a `WARNING` finding at one of the item's files

#### Scenario: Reviewer dispute blocks review
- **WHEN** the effective conclusion of `rate-limit` is agent `unchanged`, and the completed `change` reviewer reports a `WARNING` finding at `src/limit/cap.ts:12` saying the cap now rejects at 99
- **THEN** the finding blocks review until it is fixed or rebutted, and a rebuttal is listed in the next human gate payload

### Requirement: Disputing a conclusion at the gate
The human SHALL dispute a behavior conclusion by requesting changes at the define gate with notes that name the capability; no other answer channel SHALL be added. On the next `spec_gate define`, the agent's new conclusion for that capability SHALL replace its earlier one ("Behavior conclusion precedence"), so a `changed` conclusion then requires the spec edit.

#### Scenario: Human requests changes naming a capability
- **WHEN** the define gate shows `rate-limit` concluded agent `unchanged`, the human requests changes with notes `rate-limit behavior changed: cap now rejects at 99`, and the agent then runs `spec_gate define` with `behavior` concluding `rate-limit` `changed`
- **THEN** the change stays in `define`, an agent `changed` entry is appended, and `spec_gate` refuses naming `specs/rate-limit/spec.md` until that spec is edited

### Requirement: Disputed conclusion not restated
When the valid result of the define gate is `changes_requested`, not superseded, and its notes name a behavior item's capability (case-insensitive, on word boundaries where `-` is a word character), `spec_gate define` SHALL refuse, writing nothing, if `behavior` concludes that capability `unchanged` with a rationale equal to the reason of an agent conclusion for it recorded before that gate result. The refusal SHALL name the capability and say to conclude `changed`, or to give a new rationale that answers the notes. A new rationale, or a `changed` conclusion, SHALL be accepted.

#### Scenario: Same unchanged after a dispute refused
- **WHEN** the define gate result is `changes_requested` with notes `rate-limit behavior changed`, and `spec_gate define` runs with `behavior` concluding `rate-limit` `unchanged` with the same rationale as before
- **THEN** the tool refuses naming `rate-limit`, and no `decision` entry or request is written

#### Scenario: New rationale accepted
- **WHEN** the same gate result, and `behavior` concludes `rate-limit` `unchanged` with a new rationale
- **THEN** the conclusion is appended and the gate is requested again, showing the new rationale

#### Scenario: Notes that do not name the capability
- **WHEN** the define gate result is `changes_requested` with notes `tighten wording`, and `behavior` restates `rate-limit` `unchanged` with the same rationale
- **THEN** the tool does not refuse for `rate-limit`
