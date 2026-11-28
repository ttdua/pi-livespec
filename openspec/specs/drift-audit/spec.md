# drift-audit Specification

## Purpose

Defines the read-only drift audit: `/livespec audit` over the fetched integration commit, the drift detectors, scout confirmation of heuristic items, the `drift-severity` rule, the `drift-report` comment or printed report, `/livespec triage`, and the audit suggestions after an initiative closes or a commit bypasses livespec.

## Requirements

### Requirement: Audit command
`/livespec audit [#T]` SHALL run a drift audit outside any phase and with no resolved change. It SHALL fetch the integration branch and audit the tree of `origin/<integration>` at the fetched commit (the audited commit), read through git objects, not the working tree. When the fetch fails and a local `origin/<integration>` exists, it SHALL audit that commit, and the report SHALL say the snapshot was not refreshed and why. When no `origin/<integration>` exists, it SHALL refuse, post nothing and leave the audit state unchanged. It MUST NOT edit, create or delete any file in the working tree, and MUST NOT create an issue, a branch or a pull request. Its only forge write SHALL be the `drift-report` comment of "Drift report output". In an uninitialized project it SHALL say how to set livespec up and do nothing else.

#### Scenario: Read-only on files
- **WHEN** `/livespec audit` runs on a repository with drift items
- **THEN** `git status --porcelain` is unchanged after the run, and no issue or branch is created

#### Scenario: Integration snapshot, not the feature branch
- **WHEN** the session is on `livespec/x`, whose `HEAD` lacks commit `bbb` that `origin/main` has, and `bbb` removed `src/gone/a.ts`, the only file matching `paths: [src/gone/**]`
- **THEN** the audit reports `dead-paths` for that glob and names the audited commit `bbb`

#### Scenario: Fetch fails with a local ref
- **WHEN** the fetch fails and `origin/main` is `aaa` locally
- **THEN** the audit runs at `aaa` and the report says the snapshot was not refreshed, naming the fetch error

#### Scenario: No integration ref
- **WHEN** the fetch fails and there is no `origin/main`
- **THEN** the audit refuses, nothing is posted, and `audit.json` is unchanged

#### Scenario: Not initialized
- **WHEN** `/livespec audit` runs in a project without `.pi/livespec/`
- **THEN** it replies that livespec is not set up and suggests `/livespec init`

### Requirement: Drift detectors
The audit SHALL find these items over the files of the audited commit, each with a stable key `<type>:<subject>` and evidence:
- `scenario-untested`: a scenario whose name occurs, ignoring case, in no test file (`**/*.test.*`, `**/*.spec.*`, `**/*_test.*`, `tests/**`, `test/**`) outside `specs/`; subject `<capability>/<scenario>`;
- `removed-reference`: a backticked token in requirement text that is a path (it contains `/` and no glob character) absent from the commit, or an identifier in `camelCase`, `PascalCase` or `snake_case` of at least four characters that occurs in no file outside `specs/`; subject `<capability>/<token>`;
- `dead-paths`: a `paths` glob of a living spec that matches no file; subject `<capability>:<glob>`;
- `unused-term`: a glossary term that occurs, ignoring case, in no file other than `specs/glossary.md`; subject the term;
- `stale-decision`: a line of a file under `specs/`, other than the decision file itself, that names a `superseded` decision (`NNNN-<slug>` or `decisions/NNNN-`) and does not contain the word `superseded`; subject `<decision>@<file>`;
- `product-missing`: a capability with a living spec whose name does not occur in `specs/product.md`; subject the capability;
- `declared-none`: for each first-parent commit of `<fix cursor>..<audited commit>` (without a fix cursor, the first-parent commits of the last 30 days) whose subject names a pull request (`(#N)` or `Merge pull request #N`) with a head branch starting with `fix/`, each capability listed in that pull request's `lane` decision block when the block has `behavior_change: declared-none`; subject `pr#<n>:<capability>`. A pull request whose commit is not in the audited commit is therefore never read, and a commit whose subject names no pull request is not a fix.

When the forge cannot be read, the `declared-none` detector SHALL be skipped with a note, and the other detectors SHALL still run.

#### Scenario: Seeded repository
- **WHEN** a test repository is seeded with one item of each type: a scenario `rejects 101st request` with no test naming it, a requirement citing `` `src/limit/old.ts` `` which does not exist, `paths: [src/gone/**]` matching nothing, the glossary term `Bucket` used nowhere else, `product.md` citing `0002-x` which is superseded, a capability `cache` absent from `product.md`, and a merged `fix/tweak` pull request declaring `declared-none` for `rate-limit`
- **THEN** the detectors return exactly those seven items, each with its type and key

#### Scenario: Tested scenario
- **WHEN** `tests/limit.test.ts` contains `it("rejects 101st request", ...)`
- **THEN** no `scenario-untested` item is returned for that scenario

#### Scenario: Superseded decision mentioned as superseded
- **WHEN** a spec line reads `0002-x is superseded by 0005-y`
- **THEN** no `stale-decision` item is returned for that line

#### Scenario: Forge unavailable
- **WHEN** the forge is unreachable during the audit
- **THEN** the report notes that `declared-none` was skipped, and lists the other items

### Requirement: Scout confirmation
The audit SHALL send the `scenario-untested` and `removed-reference` items to one `scout` child through the dispatch API, with a packet holding the protocol layer, no flow skills, the audited commit SHA, and a task listing each item's key and evidence and the related spec text as untrusted data. The child SHALL run in a temporary worktree checked out at the audited commit, removed after the run, and the task SHALL tell it to judge only that tree. It SHALL request thinking `low` and never a model. The child SHALL return `verdicts`, each with a key, `confirmed` (the drift is real) or `refuted` (the test or reference exists under another name), and a reason. A refuted item SHALL be left out of the classified items and listed under "Refuted by the scout" with its reason. When no capable executor is present, the role agent is disabled, the launch check fails, or the child returns no valid verdict for an item, that item SHALL be kept and marked unconfirmed. The audit SHALL NOT run the scout inline, and the run SHALL write no `dispatch` ledger entry.

#### Scenario: Renamed test refuted
- **WHEN** the scout refutes `scenario-untested:rate-limit/rejects 101st request` with the reason "tested as `rejects the 101st request`"
- **THEN** the item is not classified and appears under "Refuted by the scout" with that reason

#### Scenario: Scout sees the audited snapshot
- **WHEN** the session is on a feature branch that adds `tests/limit.test.ts` naming `rejects 101st request`, and the audited commit lacks that file
- **THEN** the scout's `cwd` is a worktree of the audited commit, which has no such test

#### Scenario: Seeded audit with a confirming scout
- **WHEN** the seeded repository of "Drift detectors" is audited with a fake executor whose scout confirms every item
- **THEN** the report classifies all seven items with the severities of "Drift severity rule"

#### Scenario: No executor
- **WHEN** no capable executor is present
- **THEN** the `scenario-untested` and `removed-reference` items are reported marked unconfirmed, and the other items are unaffected

#### Scenario: Launch mismatch
- **WHEN** the executor applies a different `cwd` than requested and the launch is aborted
- **THEN** the heuristic items are reported marked unconfirmed, and no comment is written

### Requirement: Drift severity rule
The `drift-severity` decision point SHALL be registered with `registerRule`, configured as `decisions.drift-severity: { mode: rule }`, and MUST NOT ask. Its facts SHALL be built by code: `{ type, capabilityHasMajor }`, where `capabilityHasMajor` says whether another item of type `scenario-untested`, `dead-paths` or `removed-reference` names the same capability. It SHALL return:
- `major` with route `change` for `scenario-untested`, `dead-paths`, `removed-reference`, and `declared-none` when `capabilityHasMajor`;
- `minor` with route `small-fix` for `unused-term`, `stale-decision`, `product-missing`, and `declared-none` otherwise.

The audit SHALL classify every item it keeps through `decide()`, after the scout confirmation.

#### Scenario: Major item
- **WHEN** `decide("drift-severity", { type: "dead-paths", capabilityHasMajor: false })` runs
- **THEN** the outcome is `major` with route `change`, source `rule`

#### Scenario: Minor item
- **WHEN** `decide("drift-severity", { type: "unused-term", capabilityHasMajor: false })` runs
- **THEN** the outcome is `minor` with route `small-fix`

#### Scenario: Declared none with other drift
- **WHEN** a `declared-none` item names `rate-limit` and a kept `dead-paths` item names `rate-limit`
- **THEN** the `declared-none` item is `major`

#### Scenario: Declared none alone
- **WHEN** a `declared-none` item names `rate-limit` and no other Major-type item names it
- **THEN** the `declared-none` item is `minor`

### Requirement: Drift report output
The audit SHALL render a drift report: the audited commit; the items grouped `major` then `minor`, one line per item with severity, key, evidence, route and, when applicable, `unconfirmed` or `re-triaged`; then the refuted and ignored items; then notes on skipped detectors. The report SHALL say that routes are suggestions and the audit changed nothing. The target initiative SHALL be `#T` when given, otherwise the oldest pending initiative suggestion, otherwise none. With a target initiative and a writable forge, the audit SHALL post one new own comment of kind `drift-report`, a marker kind this capability registers, holding the audited commit, the items as data and the rendered report, and SHALL print the same report. Without a target initiative, or when the forge is read-only or unavailable, it SHALL only print the report, and say why.

#### Scenario: Posted on the initiative
- **WHEN** `/livespec audit #30` runs with a writable forge and finds two items
- **THEN** a `drift-report` comment by the livespec account is posted on #30 listing both items, and the same report is printed

#### Scenario: No initiative
- **WHEN** `/livespec audit` runs with no argument and no pending initiative suggestion
- **THEN** the report is printed and nothing is written to the forge

#### Scenario: Marker kind registered
- **WHEN** the extension loads
- **THEN** writing a `drift-report` marker comment succeeds

### Requirement: Drift re-triage
A writer SHALL be able to re-triage a reported item with a comment on the initiative whose first line is `/livespec triage <key> major|minor|ignore`. The next audit on that initiative SHALL read those commands from authors with `write` or `admin` permission, ignore the others, and apply the latest command per key to an item with that key: `major` sets severity `major` and route `change`, `minor` sets severity `minor` and route `small-fix`, each marked re-triaged with the author and the rule's original severity; `ignore` moves the item to an "Ignored" list. A command for a key not found SHALL be listed as unmatched.

#### Scenario: Minor raised to major
- **WHEN** a writer comments `/livespec triage unused-term:Bucket major` on #30 and the next audit on #30 finds that item
- **THEN** the item is reported `major` with route `change`, re-triaged by that writer from `minor`

#### Scenario: Major lowered to minor
- **WHEN** a writer comments `/livespec triage dead-paths:rate-limit:src/gone/** minor` and the next audit on #30 finds that item
- **THEN** the item is reported `minor` with route `small-fix`, re-triaged from `major`

#### Scenario: Reader without write access
- **WHEN** the same command is written by an author with `read` permission
- **THEN** the item keeps the rule's severity and route

### Requirement: Audit suggestions
The system SHALL keep the audit state in `<git common dir>/livespec/audit.json`: the commit cursor (the last integration commit checked for manual commits), the fix cursor (the last audited commit whose fix pull requests were checked), the last audited commit and the pending suggestions. It SHALL add a suggestion:
- on the `livespec:initiative-closed` event, naming the initiative;
- at `session_start`, for each of the oldest 50 first-parent commits of `<cursor>..origin/<integration>`, read without a fetch, that touches a file matching a capability's `paths` and did not come through livespec. A commit came through livespec when its subject names a pull request (`(#N)` or `Merge pull request #N`) whose head branch starts with `livespec/` or `fix/`. The cursor SHALL move to the last commit checked, so a later session continues with the next 50.

With no state file, `session_start` SHALL only set the cursor to `origin/<integration>`. A forge error SHALL leave the cursor unchanged. While suggestions are pending, the phase card and the resume card SHALL show an "Audit" section naming each reason and `/livespec audit`. A completed audit SHALL clear the commit suggestions whose commit is an ancestor of the audited commit and the initiative suggestion of the initiative it posted on, SHALL record the audited commit, and, only when the `declared-none` detector ran to the end, SHALL set the fix cursor to the audited commit.

#### Scenario: Manual commit suggests an audit
- **WHEN** the cursor is `aaa`, and `origin/main` gained commit `bbb` "tweak limits" with no pull request, changing `src/limit/cap.ts` under `rate-limit`'s `paths`
- **THEN** the next session's card shows the Audit section naming `bbb` and `rate-limit` and suggesting `/livespec audit`

#### Scenario: Livespec merge is not suggested
- **WHEN** the new commit's subject is `feat: cap (#41)` and pull request #41 has head `livespec/rate-cap`
- **THEN** no suggestion is added and the cursor moves to that commit

#### Scenario: More than 50 commits
- **WHEN** `<cursor>..origin/main` has 60 first-parent commits and only the 55th is manual under a capability's `paths`
- **THEN** the first session checks the oldest 50 and adds nothing, and the next session checks the remaining 10 and suggests the 55th

#### Scenario: Initiative closed
- **WHEN** `livespec:initiative-closed` is emitted for initiative #30
- **THEN** the card suggests `/livespec audit`, and the next `/livespec audit` posts its report on #30

#### Scenario: Audit clears covered suggestions
- **WHEN** initiatives #30 and #31 are pending and `/livespec audit` posts on #30 at an audited commit that contains every suggested commit
- **THEN** the Audit section names only #31

#### Scenario: Fix merged during the audit
- **WHEN** fix pull request #50 merges after the audit fetched commit `aaa`
- **THEN** #50 is not read, the fix cursor becomes `aaa`, and the next audit, whose audited commit contains #50's commit, checks it

#### Scenario: Skipped fix detector keeps the fix cursor
- **WHEN** an audit runs while the forge is unreachable
- **THEN** the fix cursor is unchanged, so the next audit still checks the fix pull requests landed since it
