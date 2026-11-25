## Context

LS-09 left one hook for this change: the ship `durable-docs` rule (`src/ship/durable-docs.ts`) raises a confirmation item for every capability whose `paths` match changed code without an `updated` spec row, "until LS-10 adds the `behavior-change` record". Readers partly exist: every packet carries a `specs/product.md` excerpt and implementer packets carry `specs/constraints.md` and the covered requirements (`src/subagents/sources-git.ts`, `sources.ts`); the first model card says "Read specs/product.md" (`PRODUCT_LINE` in `src/hooks/phase-card.ts`). The decision seam (`src/decide/seam.ts`) and `createDecisionAsker` (`src/tools/decide-ask.ts`) already turn a rule's `ask` into a `decide:<point>.<subject>` request and reuse a recorded human answer by digest and facts. `change_close` emits `livespec:initiative-closed`. Markers register through `registerKind`, checks through `registerCheck`, rules through `registerRule`, card sections through `registerCardSection`, and gate payload through `registerGatePayload`.

What is missing: define-time checks for `Product impact`, glossary terms and behavior, the glossary and decision readers, the audit, and any notion of integration-branch commits that bypassed livespec.

## Goals / Non-Goals

**Goals:**
- One trigger and one check per durable file, enforced by code.
- The behavior question is asked once per capability and file set, and ship reuses the answer.
- A reproducible audit that finds every seeded drift item, with severity from a rule.

**Non-Goals:**
- Fixing drift, creating issues or branches for drift items.
- Semantic drift that no detector can see (behavior changed, names unchanged).
- Changing the ship table, the constraints rule or the small-fix lane rule.

## Decisions

### D1. Module layout
New `src/docs/` holds the define-time checks (`product-impact.ts`, `glossary-terms.ts`, `behavior-change.ts`), their registration (`register.ts`) and the packet readers (`readers.ts`). New `src/audit/` holds the detectors (`detect-*.ts`, one per item family), the scout confirmation (`confirm.ts`), the `drift-severity` rule (`severity.ts`), the report and triage (`report.ts`, `triage.ts`), the local audit state (`state.ts`) and the suggestion logic (`suggest.ts`, `card.ts`). The command lives in `src/commands/audit.ts`. Each module has one responsibility so the detectors stay pure functions over a `RepoView` (tracked file list plus a text reader) and are tested against fixtures without git.

### D2. `product-impact` check
Pure over the change header: the value must be `updated` or match `none — <reason>` (em dash, non-empty reason); `—`, empty or anything else is an error; `none` with a non-empty `new` capability list is an error. Registered as a normal (not gate-only, not waivable) check, listed in `define` and `review`. Severity `error` blocks the gate through the existing `failingCheck` refusal. The define payload already shows the line (phase-gates "Gate review payload").

### D3. `glossary-terms` check
Reads `git diff <Base>..HEAD -- specs/` and takes the added lines of `specs/<capability>/spec.md` files, outside front matter. Candidates:
- bold terms `**X**`, except the scenario keywords (`WHEN`, `THEN`, `AND`, `GIVEN`);
- proper nouns: capitalized words not at a sentence start and not inside backticks, excluding RFC keywords and all-caps words, that occur nowhere in `specs/` at `Base`.
A candidate is reported when the glossary (parsed with `parseGlossary`) has no entry equal to it, case-insensitive, ignoring a trailing `s`. Severity `warning`, so it never blocks. A define gate payload section "Glossary" lists the warnings and the entries the specs diff adds to `specs/glossary.md`; approving the gate approves those entries. Alternative rejected: an NLP noun-phrase extractor, a new dependency for a warning.

### D4. `behavior-change` rule, check and question
- **Facts** (built by code): for each living spec whose `paths` match a changed non-`specs/` file in `Base..HEAD` and whose `specs/<capability>/spec.md` is not in that diff: `{ capability, files }`, files sorted.
- **Rule** `behavior-change` (`registerRule`, `decisions.behavior-change: { mode: rule }`): always returns `ask` with options `unchanged` ("behavior did not change") and `changed` ("behavior changed; the spec must be updated").
- **Record**: subject `<capability>`, digest `sha256(files.join("\n"))`, facts as above, plus a top-level `files` field that survives `facts_hash` compaction (decision-seam "Decision records"), so ship can read the coverage of a large record. `reusableAnswer` already requires the same digest and facts, so a record stands until the file set under that capability's `paths` changes; editing the same files again does not re-ask.
- **Check** `behavior-change` (define and review, not waivable): per capability in the facts, no reusable human record → error "needs a human answer"; record `changed` → error "update specs/<capability>/spec.md"; record `unchanged` → nothing. Once the spec file is in the diff the capability leaves the facts.
- **Asking**: `spec_gate` for `define` or `review` first runs the checks and refusals with the `behavior-change` results filtered out; any refusal returns before a write, so the phase-gates "writing nothing" contract holds. Only then it calls `askBehaviorChanges`, which runs `decide("behavior-change", facts, { ask: createDecisionAsker(...) })` for each capability without a record. An in-session answer completes at once; a pending forge request makes `spec_gate` refuse naming the pending `decide:behavior-change.<capability>` request. Then the session state is refreshed and the full check run (now including `behavior-change`), refusals and gate request follow, so a `changed` answer refuses in the same call. phase-gates "Gate tool" is modified to state this one exception to "refuse, writing nothing". Alternative rejected: folding the question into the gate's own options; a gate has one outcome, while the behavior answer is per capability and must be a decision record that ship can read.

### D5. Ship reads the record
`DurableFacts` gains `behavior: { capability, files, outcome }[]`: per capability the latest `behavior-change` record with source `human` from the issue's marked comments, whatever its digest. `capabilityConfirms` skips a capability when that latest record is `unchanged` and its files include every changed file of that capability. A superset is accepted because the ship diff starts at the merge base with the integration branch, while the define/review facts start at `Base`; an older `unchanged` record never counts once a newer one exists. Eligibility (latest human record) and coverage (superset of ship files) are separate steps. Without one, today's confirmation item stays: the fallback for changes that never passed a review gate after LS-10 and for the small-fix lane (which has no issue). The rule stays pure and never asks (ship-phase requirement unchanged in that respect).

### D6. Packet readers
`SourceProvider` gains an optional second parameter, the `Target` (role, unit, subject). This is additive: existing one-parameter providers still type-check. `src/docs/readers.ts` registers, for `implementer` and `reviewer`:
- `glossary`: the entries of `specs/glossary.md` whose term occurs (case-insensitive, word boundary) in the unit text, or for a reviewer in the `## Units` section; id `file:specs/glossary.md`, version the hash of the rendered entries; omitted when no term matches;
- `decisions`: accepted decisions with `spine: true`, plus accepted decisions whose `capabilities` intersect the change's declared capabilities, each `file:specs/decisions/<file>`.
`specs/constraints.md` already reaches implementers; the reviewer manifests add the existing `constraints` provider. The first-card product line already satisfies the phase card reader; nothing changes there.

### D7. Audit: inputs and detectors
`/livespec audit [#T]` fetches the integration branch and audits the tree of `origin/<integration>` (the audited commit) through `git ls-tree -r` and `git show <commit>:<path>`, never the working tree, so the report and the suggestion bookkeeping describe the same revision whatever branch the session is on. Pure detectors run over a `RepoView` of that commit:

| Type | Detector |
|---|---|
| `scenario-untested` | a scenario name (case-insensitive) occurs in no test file (`**/*.test.*`, `**/*.spec.*`, `**/*_test.*`, `tests/**`, `test/**`, outside `specs/`) |
| `removed-reference` | a backticked token in requirement text that is a repo path (contains `/` and no glob character) and is not tracked, or an identifier (`camelCase`, `snake_case` or `PascalCase`, at least 4 characters) that occurs in no tracked file outside `specs/` |
| `dead-paths` | a `paths` glob that matches no tracked file |
| `unused-term` | a glossary term that occurs in no tracked file other than `specs/glossary.md` |
| `stale-decision` | a tracked file under `specs/` other than the decision itself refers to a `superseded` decision (`decisions/NNNN-` or `NNNN-<slug>`) on a line that does not contain `superseded` |
| `product-missing` | a capability name that does not occur in `specs/product.md` |
| `declared-none` | first-parent commits of `<fixCursor>..<audited commit>` (or the last 30 days) whose subject names a pull request with a `fix/*` head and a `lane` block with `behavior_change: declared-none`, one item per listed capability. Commit-based, like the suggestions in D11: no merge SHA or timestamp is needed from the forge, and the cursor is a commit, so no pull request is lost at a boundary |

Every item has a stable key `<type>:<subject>` (e.g. `dead-paths:rate-limit:src/limit/**`, `scenario-untested:rate-limit/rejects 101st request`). Forge reads (fix pull requests, initiative comments) are skipped with a note when the forge is unavailable.

### D8. Scout confirmation
Heuristic items (`scenario-untested`, `removed-reference`) are sent to one `scout` child through `runDispatch`, with `cwd` a temporary worktree of the audited commit (`withTempWorktree` from `src/evidence/worktree.ts`) and metadata `change: audit`, so the child judges the same tree as the detectors. The audit packet holds the protocol layer, no flow skills (the pack's scout skills are phase-scoped and the audit has no phase), the audited SHA, and a task listing each candidate (key, evidence, the spec text) as untrusted text. `confirmed` means the drift is real; `refuted` means the test or reference exists under another name. The scout result schema gains an optional `verdicts: [{ key, verdict: confirmed | refuted, reason }]`. A refuted item is dropped and listed under "Refuted by the scout"; a confirmed one keeps `confirmed: true`. `declared-none` is not sent: its evidence is the pull request's own declaration, and its severity comes from code facts (D9). The run's `RecordDeps.post` is a sink: the audit has no change issue, so no `dispatch` comment is written, and the result goes into the report. Requested thinking is `low` (the fast-model wish; livespec never sets a model). Without a capable executor, with the scout agent disabled, on a launch mismatch, or when the scout fails, the heuristic items are kept with `confirmed: false` and marked "unconfirmed". **Deviation from brainstorm.md**, which said the scout step runs inline through `subagent_packet` without an executor: `subagent_packet`/`subagent_record` need a resolved change and post a `dispatch` record on it, and the audit has neither. Keeping items unconfirmed loses nothing (they stay in the report) and avoids a second, change-less inline protocol. The subagent-dispatch "Inline fallback" and "Effort and model" requirements record this exception.

### D9. `drift-severity` rule
`registerRule("drift-severity", …)`, `decisions.drift-severity: { mode: rule }`, never asks. Facts built by code: `{ type, capabilityHasMajor }`, where `capabilityHasMajor` says whether a kept `scenario-untested`, `dead-paths` or `removed-reference` item names the same capability (the brainstorm's agreed fact). Major (route `change`): `scenario-untested`, `dead-paths`, `removed-reference`, and `declared-none` when `capabilityHasMajor`. Minor (route `small-fix`): `unused-term`, `stale-decision`, `product-missing`, and `declared-none` otherwise. The scout never feeds a classification fact; it only removes refuted items before classification. The audit records the rule's outcome per item in the report (no separate decision comment: the audit has no change issue).

### D10. Report, destination and triage
The report groups items by severity, each line `- [<severity>] <key> — <evidence> → <route>`, with "unconfirmed" when applicable, then the refuted items and the notes. Destination: an explicit `#T`, else the oldest pending `initiative-closed` suggestion (D11), else none. With an initiative and a writable forge the audit posts a new own `drift-report` comment (marker kind registered with `registerKind`) holding the items as data plus the rendered report, and prints the same text; otherwise it prints only (the issue's open question, decided: print). Each run posts a new comment. Triage: a writer replies on the initiative with `/livespec triage <key> major|minor|ignore`; the next audit on that initiative reads those commands (write permission checked as for forge commands, authors without it ignored), applies the latest per key to matching items: `major` sets route `change`, `minor` sets route `small-fix`, `ignore` moves the item to "Ignored"; each re-triaged item keeps the rule's original severity and names the author. Printed reports have no triage.

### D11. Suggestions and local state
`<git common dir>/livespec/audit.json` holds `{ cursor, fixCursor, auditedCommit, pending: [{ kind: "initiative", initiative } | { kind: "commit", sha, capabilities }] }`. It is local, shared by worktrees of a clone, and safe to delete (worst case one missed suggestion).
- `livespec:initiative-closed` adds an `initiative` entry.
- At `session_start`, without a fetch, the session checks the oldest 50 first-parent commits of `<cursor>..origin/<integration>` and moves the cursor to the last one checked; a longer backlog is worked off 50 per session, never skipped. A commit counts as livespec when its subject names a pull request (`(#N)` or `Merge pull request #N`) whose head branch, read from the forge, starts with `livespec/` or `fix/`. Any other commit whose files match a capability's `paths` is added to a `commits` entry. The first run with no state only sets the cursor. Forge errors leave the cursor unchanged so the next session retries.
- A registered card section "Audit" shows the pending reasons and "run /livespec audit". A completed audit clears the commit suggestions whose sha is an ancestor of the audited commit and the initiative suggestion it posted on (other initiatives stay pending), records `auditedCommit`, and sets `fixCursor` to the audited commit only when the `declared-none` detector ran to the end.

### D12. Pack and command wiring
The default pack lists `product-impact`, `glossary-terms` and `behavior-change` after the existing `define` checks and as the `review` checks before `review-clean`, and adds `behavior-change: { mode: rule }` and `drift-severity: { mode: rule }` under `decisions`. The fixture `tests/fixtures/agent-skills.pack.json` follows. `/livespec audit` joins the subcommand router and the usage text.

## Risks / Trade-offs

- [Heuristic false positives: a scenario tested under another name] → scout confirmation; refuted items are dropped; Minor/Major can be re-triaged by a human.
- [Proper-noun heuristic is noisy] → warning only, never blocks; the payload shows it to the human.
- [Squash merges without a `(#N)` subject look manual] → a spurious audit suggestion, never a write; suggestions are cheap to dismiss by running the audit.
- [Unbounded forge reads at session start] → capped at 50 commits per start, one pull request read per distinct number, errors keep the cursor.
- [The audit fetches] → a fetch updates only remote-tracking refs, like `change_sync`; offline, the audit uses the local `origin/<integration>` and says so; with no such ref it refuses.
- [Fix pull requests merged during an audit] → fix pull requests are found from the audited commit's own history, so a later merge is simply not seen yet and the next audit reaches it.
- [Commit subjects can be edited, or a merge may name no pull request] → such a commit is treated as manual (a suggestion) and not as a fix; the same rule decides both, so the two cannot disagree.
- [Behavior question adds a human stop at a self review gate] → asked once per capability and file set; in-session it is one dialog.
- [Changes already past review when LS-10 lands have no records] → ship keeps the confirmation item fallback (D5).

## Migration Plan

No data migration. Existing changes without `behavior-change` records keep today's ship confirmations. Projects with an overriding `.pi/livespec/flow.yaml` that lists `define` checks keep their list; the new checks apply only where the pack lists them. Rollback: revert the pack entries; records and `drift-report` comments are inert data.

## Open Questions

None blocking. The detector patterns (test file globs, identifier shape) are constants in `src/audit/` and can become config later if projects need it.
