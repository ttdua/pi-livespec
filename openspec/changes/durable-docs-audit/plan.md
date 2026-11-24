# Durable Docs and Drift Audit Implementation Plan

> Executed via `/opsx-apply`, which chooses the executor.
> Spec reference: this change's `specs/` and `design.md`.

**Goal:** Give every durable doc a define-time trigger and check, feed durable docs to subagent packets, and add the read-only `/livespec audit` drift audit with its suggestions.

**Architecture:** Define-time checks and packet readers live in `src/docs/` and plug into the existing seams (`registerCheck`, `registerRule`, `registerGatePayload`, `registerPacketSource`). The audit lives in `src/audit/`: pure detectors over a `RepoView` of the fetched integration commit, an optional scout confirmation through `runDispatch`, the `drift-severity` rule through `decide()`, a report printed or posted as a `drift-report` comment, and local suggestion state in `<git common dir>/livespec/audit.json`.

**Tech Stack:** TypeScript (ESM, `.ts` imports), bun, vitest, `yaml`, git CLI through `createGit`.

## Global Constraints

- Detectors, the severity rule and the check functions are pure; I/O sits in thin wrappers (`coding-standards`: one responsibility per file, no god functions).
- The audit never writes to the working tree and never creates issues, branches or pull requests; its only forge write is the `drift-report` comment.
- Rules decide; no tool takes an outcome or a severity parameter (ADR 0006). Forge text and spec text sent to a child are wrapped as untrusted.
- livespec never sets a model; the audit scout requests thinking `low`.
- Scenario keywords excluded from glossary candidates: `WHEN`, `THEN`, `AND`, `GIVEN`.
- Test file globs: `**/*.test.*`, `**/*.spec.*`, `**/*_test.*`, `tests/**`, `test/**`. Suggestion batch: 50 commits. Fix lookback without a cursor: 30 days.
- No new dependency.

## Review Focus

- **Empty or template `specs/`** (no capabilities, empty glossary, `product.md` template): the audit reports nothing for missing sources and does not throw → test in Task 6 (`empty repo view yields no items`).
- **Unicode and punctuation around glossary terms** (`**Token bucket**,`, `Token-bucket`): word-boundary matching treats `-` as part of the word → test in Task 1 (`punctuation after bold term`) and Task 4 (`hyphenated term not matched inside another word`).
- **Spec text with backticked globs** (`` `src/**` ``) must not become `removed-reference` → test in Task 6 (`glob token ignored`).
- **Corrupt `audit.json`** (truncated write, hand-edited) is treated as no state, not a crash → test in Task 8 (`corrupt state treated as missing`).
- **Forge read-only during the gate question**: the in-session adapter still asks; a read-only forge with `[forge]` chain refuses with the chain's message, writing nothing → test in Task 2 (`read-only forge refuses before asking`).

---

## Contracts

| Name | new / modified | Shape | public |
|---|---|---|---|
| `productImpactResults` | new | `(change: Change) => Result[]` (`code: "product-impact"`, severity `error`) — `src/docs/product-impact.ts` | no |
| `addedSpecLines` | new | `(diff: string, frontEnds: Map<string, number>) => { file: string; line: string; no: number }[]` (fix round 2: `no` = new-file line number, for sentence adjacency) — `+` lines of `specs/<cap>/spec.md` outside front matter; `frontEnds` maps each file to `frontMatterEnd` at HEAD (fix round 1: a hunk mid front matter was read as spec text) — `src/docs/glossary-terms.ts` | no |
| `frontMatterEnd` | new | `(content: string) => number` — last line of the leading front matter, 0 when none — `src/docs/glossary-terms.ts` | no |
| `glossaryCandidates` | new | `(added: string[], glossary: Glossary, knownAtBase: string) => string[]` — `src/docs/glossary-terms.ts` | no |
| `addedGlossaryEntries` | new | `(diff: string) => string[]` — `+- **Term**: …` lines added to `specs/glossary.md` | no |
| `CheckGit` | modified | `{ diff(from: string, to: string, path: string): Promise<string>; head(): Promise<string>; showFile(rev: string, path: string): Promise<string \| undefined>; listTree(rev: string): Promise<string[]> }` — `src/engine/registry.ts` | no |
| `Git.listTree` | new | `(rev: string) => Promise<string[]>` — `git ls-tree -r --name-only -z <rev>` — `src/engine/git.ts` | no |
| `Git.commitPaths` | new | `(commit: string) => Promise<string[]>` — non-merge: `changedPaths`; merge: `git diff --name-only <commit>^1 <commit>` — `src/engine/git.ts` | no |
| `Git.firstParentCommits` | new | `(commit: string, o: { after?: string; since?: string }) => Promise<{ sha: string; subject: string }[]>` — `git log --first-parent --reverse --format=%H%x00%s [--since=<since>] <after>..<commit> \| <commit>`, oldest first — `src/engine/git.ts` | no |
| `Git.commonDir` | new | `() => Promise<string>` — absolute `git rev-parse --git-common-dir` — `src/engine/git.ts` | no |
| `collectReviewFacts` | modified | `(git: Pick<Git, "diffStat" \| "diffNames" \| "diff">, base: string \| undefined) => Promise<ReviewFacts>` — `src/engine/gate-payload.ts` | no |
| `ReviewFacts` | modified | `{ specsStat: string; specsFiles: string[]; specsDiff: string; issueUrl?: string }` (`specsDiff` = `git diff <Base>..HEAD -- specs/`, `""` without Base) — `src/engine/gate-payload.ts` | no |
| `registerDocChecks` | new | `() => void` — registers `product-impact`, `glossary-terms`, `behavior-change` checks and the define payload — `src/docs/register.ts` | no |
| `BehaviorItem` | new | `{ capability: string; files: string[] }` (files sorted) — `src/docs/behavior-change.ts` | no |
| `behaviorFacts` | new | `(diffFiles: string[], specs: { capability: string; paths: string[] }[]) => BehaviorItem[]` | no |
| `behaviorDigest` | new | `(files: string[]) => string` — sha256 hex of `files.join("\n")` | no |
| `latestBehaviorRecords` | new | `(marked: MarkedComment[]) => Map<string, DecisionRecord>` — latest `behavior-change` record with `source: "human"` and no `proposal` per capability (subject) | no |
| decision point `behavior-change` | new | `decisions.behavior-change: { mode: rule }`; rule always returns `{ ask: { summary, options: [{ id: "unchanged", label: "Behavior did not change" }, { id: "changed", label: "Behavior changed; the spec must be updated" }] } }`; subject = capability | yes (pack key) |
| `DecisionRecord.files` | modified | `files?: string[]`, kept by `compactFacts`, validated as a string list — `src/decide/records.ts` | no |
| `DecideSnapshot.files` | modified | `files?: string[]`; set by `decisionRequest` when `point === "behavior-change"`; copied by `applyDecide` | no |
| `askBehaviorChanges` | new | `(w: WriteContext, state: ChangeState, ctx: ApproverCtx) => Promise<{ ok: true; asked: boolean } \| { ok: false; message: string }>` — `src/docs/behavior-ask.ts` | no |
| `DurableFacts.behavior` | modified | `behavior: { capability: string; files: string[]; outcome: string \| null }[]` | no |
| `durableFacts` | modified | `(diff: ChangeDiff, change: Change, specs: DurableFacts["specs"], behavior: DurableFacts["behavior"]) => DurableFacts` | no |
| `SourceProvider` | modified | `(ctx: PacketContext, target?: Target) => Promise<PacketSource[]>` — `src/subagents/source-types.ts` | yes (exported API) |
| `registerDocReaders` | new | `() => void` — `src/docs/readers.ts` | no |
| `ScoutVerdict` | new | `{ key: string; verdict: "confirmed" \| "refuted"; reason: string }` — `src/subagents/roles.ts` | yes (child contract) |
| `SubagentResult.verdicts` | modified | `verdicts?: ScoutVerdict[]`; `resultSchema("scout")` accepts it (not required) | yes (child contract) |
| `RepoView` | new | `{ commit: string; files: string[]; read(path: string): Promise<string \| undefined> }` — `src/audit/repo-view.ts` | no |
| `repoViewAt` / `memoryView` | new | `(git: Pick<Git, "listTree" \| "showFile">, commit: string) => Promise<RepoView>` / `(files: Record<string, string>, commit?: string) => RepoView` | no |
| `DriftType` | new | `"scenario-untested" \| "removed-reference" \| "dead-paths" \| "unused-term" \| "stale-decision" \| "product-missing" \| "declared-none"` — `src/audit/items.ts` | no |
| `DriftItem` | new | `{ type: DriftType; key: string; subject: string; capability?: string; evidence: string; confirmed?: boolean }`, `key = \`${type}:${subject}\`` | no |
| `Severity` / `Route` | new | `"major" \| "minor"` / `"change" \| "small-fix"` | no |
| `ClassifiedItem` | new | `DriftItem & { severity: Severity; route: Route; retriaged?: { by: string; from: Severity } }` | no |
| `pullRequestOf` | new | `(subject: string) => number \| undefined` — `/\(#(\d+)\)\s*$/` or `/^Merge pull request #(\d+)/` — `src/audit/items.ts` | no |
| `isIdentifierToken` / `isPathToken` | new | `(token: string) => boolean` — see Task 6 Step 5 — `src/audit/detect-specs.ts` | no |
| `detectSpecs` / `detectDocs` | new | `(view: RepoView) => Promise<DriftItem[]>` | no |
| `detectFixes` | new | `(commits: { sha: string; subject: string }[], forge: Pick<Forge, "getPullRequest">) => Promise<DriftItem[]>` | no |
| `severityFacts` | new | `(item: DriftItem, kept: DriftItem[]) => { type: DriftType; capabilityHasMajor: boolean }` — `src/audit/severity.ts` | no |
| decision point `drift-severity` | new | `decisions.drift-severity: { mode: rule }`; outcome `{ severity: Severity; route: Route }`, never asks | yes (pack key) |
| `classify` | new | `(items: DriftItem[]) => Promise<ClassifiedItem[]>` (through `decide`) | no |
| `ConfirmDeps` | new | `{ service?: SubagentsServiceLike; events: EventsLike; git: Git; root: string; exclusions: string[]; signal?: AbortSignal }` (`exclusions` resolved by the command with the existing `excludedPackages(configuredPackages(...), user isolation.excludePackages)` policy) — `src/audit/confirm.ts` | no |
| `confirmItems` | new | `(items: DriftItem[], commit: string, deps: ConfirmDeps) => Promise<{ kept: DriftItem[]; refuted: { key: string; reason: string }[]; note?: string }>` | no |
| `applyTriage` | new | `(items: ClassifiedItem[], comments: Comment[], canWrite: (login: string) => Promise<boolean>) => Promise<{ items: ClassifiedItem[]; ignored: string[]; unmatched: string[] }>` — `src/audit/triage.ts` | no |
| `AuditReport` | new | `{ commit: string; refreshed: boolean; fetchError?: string; items: ClassifiedItem[]; refuted: { key: string; reason: string }[]; ignored: string[]; unmatched: string[]; notes: string[] }` — `src/audit/report.ts` | no |
| `renderReport` | new | `(r: AuditReport) => string` | no |
| marker kind `drift-report` | new | id `drift-report.<first 12 of commit>.<base36 ms>`, data `{ commit: string; items: ClassifiedItem[]; refuted: { key: string; reason: string }[]; ignored: string[] }` | yes (forge format) |
| triage command | new | initiative comment first line `/livespec triage <key> major\|minor\|ignore` | yes (forge command) |
| `AuditState` | new | `{ cursor?: string; fixCursor?: string; auditedCommit?: string; pending: ({ kind: "initiative"; initiative: number } \| { kind: "commit"; sha: string; capabilities: string[] })[] }` — `src/audit/state.ts` | no |
| `audit.json` | new | `AuditState` as JSON at `<git common dir>/livespec/audit.json` | no |
| `readAuditState` / `writeAuditState` | new | `(git: Pick<Git, "commonDir">) => Promise<AuditState>` (missing or corrupt → `{ pending: [] }`) / `(git: Pick<Git, "commonDir">, s: AuditState) => Promise<void>` (temp file + rename) | no |
| `AuditDeps` | new | `{ git: Git; root: string; integration: string \| undefined; forge?: Forge; writable: boolean; state: AuditState; confirm: ConfirmDeps; specs: (view: RepoView) => Promise<{ capability: string; paths: string[] }[]> }` — `src/commands/audit.ts` | no |
| `AuditOutcome` | new | `{ ok: true; text: string; commit: string; posted?: number; fixesRan: boolean } \| { ok: false; text: string }` | no |
| `runAudit` | new | `(deps: AuditDeps, target?: number) => Promise<AuditOutcome>`; default target = first `initiative` entry of `deps.state.pending` | no |
| `scanCommits` | new | `(deps: { git: Git; forge?: Forge; integration: string; specs: { capability: string; paths: string[] }[] }, s: AuditState) => Promise<AuditState>` — `src/audit/suggest.ts` | no |
| `addInitiative` / `completeAudit` | new | `(s: AuditState, n: number) => AuditState` / `(s: AuditState, o: Extract<AuditOutcome, { ok: true }>, isAncestor: (a: string, b: string) => Promise<boolean>) => Promise<AuditState>` | no |
| `Session.auditState` | new | `auditState: AuditState`, default `{ pending: [] }` — `src/hooks/session.ts` | no |
| `CardInput.audit` | modified | common field `audit?: string[]` (pending reasons, rendered by the `audit` card section) — `src/hooks/phase-card.ts`, filled in `src/hooks/card-input.ts` from `Session.auditState` | no |
| `/livespec audit [#T]` | new | subcommand; optional initiative number | yes (CLI) |

---

## Task 1: Product impact and glossary checks — implements 1

**Covers:** 1.1, 1.2, 1.3
**Difficulty:** Normal
**Blocked by:** none

**Files:**
- Create: `src/docs/product-impact.ts`, `src/docs/glossary-terms.ts`, `src/docs/register.ts`
- Modify: `src/engine/checks.ts` (call `registerDocChecks()` in `registerBuiltinChecks`; pass `showFile`/`listTree` in `CheckGit`), `src/engine/registry.ts` (`CheckGit`), `src/engine/git.ts` (`listTree`), `src/engine/gate-payload.ts` (`ReviewFacts.specsDiff`, `collectReviewFacts`), `src/tools/spec-gate.ts` (`collectReviewFacts` call gains `diff`)
- Test: `tests/docs/product-impact.test.ts`, `tests/docs/glossary-terms.test.ts`, `tests/engine/git.test.ts` (`listTree`)
- Migrate typed consumers (no casts): `tests/engine/gates.test.ts`, `tests/review/payload.test.ts`, `tests/tools/lane-tools.test.ts`, `tests/tools/unit-finish-findings.test.ts` (`ReviewFacts` gains `specsDiff: ""`), `tests/review/status.test.ts` (`CheckContext.git` stub gains `showFile`/`listTree`); find any other with `rg -n "specsStat|CheckGit|git: \{ diff" tests src`

**Interfaces:** Contracts `productImpactResults`, `addedSpecLines`, `glossaryCandidates`, `addedGlossaryEntries`, `CheckGit`, `Git.listTree`, `ReviewFacts`, `registerDocChecks` (Task 2 adds to it). Gate-level tests use a test flow override (`.pi/livespec/flow.yaml` with `extends: agent-skills` and the define checks listed), as `tests/tools/spec-gate.test.ts` does, because the default pack lists the checks only in Task 5.

- [ ] **Step 1: Write failing tests** in `tests/docs/product-impact.test.ts`: `"—"` → one error `code: "product-impact"`; `"none — internal refactor"` with `modified [rate-limit]` → `[]`; `"none — small"` with `new [cache]` → one error whose message contains `cache`; `"updated"` → `[]`; `"none — "` (empty reason) → error; missing line → error.
- [ ] **Step 2: Write failing tests** in `tests/docs/glossary-terms.test.ts`: `Each **Token bucket** refills every second.` with empty glossary → `["Token bucket"]`; `**Unit**` with entry `Units` → `[]`; `- **WHEN** a request arrives` / `- **THEN** it is rejected` → `[]`; `Requests go through the Gateway first.` with `knownAtBase` lacking `Gateway` → `["Gateway"]`; ``Clients call `RateLimiter` and the API once.`` → `[]`; `punctuation after bold term`: `**Token bucket**,` → `["Token bucket"]`; `addedSpecLines` skips front matter and non-spec files.
- [ ] **Step 3: Add the test** `Proposed entries shown at the gate`: `gatePayload(state, pack, "define", { ...facts, specsDiff })` summary contains `Glossary:` and the added entry; and `known at Base in another spec`: `Gateway` occurs at `Base` in an untouched `specs/auth/spec.md` → no warning.
- [ ] **Step 4: Declare** the contract types and stubs, migrate the typed consumers listed above, run `bun run typecheck` (exit 0), then **run** `bunx vitest run tests/docs tests/engine/git.test.ts` — expect FAIL.
- [ ] **Step 5: Implement** `productImpactResults(change)` (value from `change.header.productImpact`; `none — ` prefix with non-empty trimmed reason; message names the new capabilities) and the `glossary-terms` check: `addedSpecLines(await git.diff(base, "HEAD", "specs/"))`, `knownAtBase` = concatenated `git.showFile(Base, f)` of every file of `git.listTree(Base)` under `specs/`, `parseGlossary` of the working-tree glossary; severity `warning`, no `Base` → `[]`.
- [ ] **Step 6: Implement** the define gate payload: `registerGatePayload("define", …)` renders `Glossary:` with one line per `glossary-terms` warning from `state.checks` plus `addedGlossaryEntries(facts.specsDiff)`; undefined when both are empty. `collectReviewFacts` also returns `specsDiff`.
- [ ] **Step 7: Run** `bunx vitest run tests/docs tests/engine tests/tools/spec-gate.test.ts` — PASS.
- [ ] **Step 8: Commit** `feat(durable-docs): product-impact and glossary-terms checks`.

---

## Task 2: Behavior change rule, check and gate question — implements 2

**Covers:** 2.1, 2.2, 2.3, 2.4
**Difficulty:** Hard
**Blocked by:** Task 1

**Files:**
- Create: `src/docs/behavior-change.ts`, `src/docs/behavior-ask.ts`
- Modify: `src/docs/register.ts`, `src/decide/registry.ts`, `src/decide/records.ts`, `src/interaction/approver.ts` (`DecideSnapshot.files`), `src/tools/decide-ask.ts` (snapshot carries `files` for point `behavior-change`), `src/interaction/complete-decide.ts`, `src/tools/spec-gate.ts`
- Test: `tests/docs/behavior-change.test.ts`, `tests/decide/records.test.ts`, `tests/tools/spec-gate-behavior.test.ts`

**Interfaces:** Contracts `BehaviorItem`, `behaviorFacts`, `behaviorDigest`, `latestBehaviorRecords` (Task 3 uses it), `askBehaviorChanges`, `DecisionRecord.files`, `DecideSnapshot.files`, decision point `behavior-change`. Consumes `decide`, `createDecisionAsker`, `reusableAnswer`, `openRequestFor`, `readRequests`, `gateRefusal`, `runChecks`. Gate tests use a flow override listing `behavior-change` in `define` and `review` (the default pack gets it in Task 5).

- [ ] **Step 1: Write failing tests** in `tests/docs/behavior-change.test.ts`: `behaviorFacts(["src/limit/cap.ts"], [{ capability: "rate-limit", paths: ["src/limit/**"] }])` → `[{ capability: "rate-limit", files: ["src/limit/cap.ts"] }]`; with `specs/rate-limit/spec.md` also in the list → `[]`; `decide("behavior-change", item, { config: { mode: "rule" }, subject: item.capability, digest: behaviorDigest(item.files), ask })` → `ask` receives `point: "behavior-change"`, `subject: "rate-limit"`, `digest: behaviorDigest(["src/limit/cap.ts"])` and option ids `["unchanged", "changed"]`; check: no record → error message contains `spec_gate define`; open request → message names `decide:behavior-change.rate-limit`; `changed` record → error naming `specs/rate-limit/spec.md`; `unchanged` record → `[]`; record for `[cap.ts]` with facts now `[cap.ts, window.ts]` → error (not reusable).
- [ ] **Step 2: Write failing tests** in `tests/decide/records.test.ts`: `Behavior files kept with hashed facts` — a `behavior-change` record with 300 files → parsed comment has `facts_hash`, no `facts`, and `files` of length 300; `latestBehaviorRecords` over marked comments `[unchanged(rate-limit), changed(rate-limit), rule-sourced(auth), proposal(api)]` → only `rate-limit` → `changed`.
- [ ] **Step 3: Declare** contract types and stubs, `bun run typecheck` (exit 0), then **run** `bunx vitest run tests/docs/behavior-change.test.ts tests/decide/records.test.ts` — FAIL.
- [ ] **Step 4: Implement** `src/docs/behavior-change.ts` (facts, digest, rule + schema via `checkAllowedKeys(node, ["mode"], …)`, check reading `ctx.marked` with `reusableAnswer(marked, "behavior-change", cap, behaviorDigest(files), item)` and open requests with `openRequestFor(readRequests(marked), …)`); register the rule in `registerBuiltinRules`; add `files` to `DecisionRecord`, `optionalFieldsValid`, `DecideSnapshot`, `decisionRequest` (when `intent.point === "behavior-change"`, from `intent.facts.files`) and `applyDecide`. Run step-3 tests — PASS.
- [ ] **Step 5: Write failing tests** in `tests/tools/spec-gate-behavior.test.ts` (pattern of `tests/tools/spec-gate*.test.ts`, in-session approver stub): `Asked once at define` (answer `unchanged` → one `decision` comment, then a `gate:define` request; a later `spec_gate review` posts no new `decide:` request); `Other refusal asks nothing` ×3 (dirty tree, blocking question, `spec-format` error → refusal text, zero new comments); `Changed answer blocks the same call` (record posted, refusal names `specs/rate-limit/spec.md`, no `gate:define` request); `Forge request pending` (`[forge]` chain → one `request` comment for `decide:behavior-change.rate-limit`, refusal names it); `New file asks again at the gate` (an `unchanged` record for `[cap.ts]`, diff now `cap.ts`, `window.ts` → `spec_gate define` posts a new `decide:` answer); `Behavior answer before a refusal`; `read-only forge refuses before asking` (Review Focus).
- [ ] **Step 6: Implement** `askBehaviorChanges` and wire it in `runSpecGate` for `define`/`review`: run `withGateChecks`, drop results with `check === "behavior-change"`, `gateRefusal` → return on refusal; for each item without a reusable record call `decide` with `createDecisionAsker(w, state, ctx)` (pending → refuse naming `decide:behavior-change.<cap>`); if anything was asked, `afterForgeWrite` and re-read the state; then the existing flow (full checks, refusal, plan, request).
- [ ] **Step 7: Run** `bunx vitest run tests/docs tests/tools tests/decide` — PASS.
- [ ] **Step 8: Commit** `feat(durable-docs): behavior-change rule, check and gate question`.

---

## Task 3: Ship reads the behavior record — implements 3

**Covers:** 3.1, 3.2
**Difficulty:** Normal
**Blocked by:** Task 2

**Files:**
- Modify: `src/ship/durable-docs.ts`, `src/ship/context.ts`
- Test: `tests/ship/durable-docs.test.ts`, `tests/ship/docs-table.test.ts` (fixture gains `behavior: []`), `tests/ship/context.test.ts`

**Interfaces:** Contracts `DurableFacts.behavior`, `durableFacts`; consumes `latestBehaviorRecords` (Task 2).

- [ ] **Step 1: Write failing tests** in `tests/ship/durable-docs.test.ts`: `Behavior answered earlier` (`behavior: [{ capability: "rate-limit", files: ["src/limit/cap.ts"], outcome: "unchanged" }]` → `confirm` has no `rate-limit:` item, payload still has `not needed — refactor`); `Record misses a file` (record `[cap.ts]`, diff `cap.ts`, `window.ts` → item naming both); `Newer changed record wins` (`outcome: "changed"` → item present); `Superset record` (record `[cap.ts, window.ts]`, diff `cap.ts` → no item). Existing scenarios stay unchanged with `behavior: []`.
- [ ] **Step 2: Write failing test** in `tests/ship/context.test.ts`: `Newer changed record wins (records)` — marked comments with an older `unchanged` and a newer `changed` human record for `rate-limit` → `shipStateFor` facts give `behavior[0].outcome === "changed"` and the confirmation item; a record whose facts were hashed still yields its `files`.
- [ ] **Step 3: Declare** `DurableFacts.behavior` and the new `durableFacts` signature (callers pass `[]` for now), `bun run typecheck` (exit 0), then **run** `bunx vitest run tests/ship` — FAIL.
- [ ] **Step 4: Implement**: `capabilityConfirms` skips a capability when `facts.behavior` has its entry with `outcome === "unchanged"` and every file is in `files`; `durableFacts(diff, change, specs, behavior)` gains the parameter; `src/ship/context.ts` builds it from `latestBehaviorRecords(state.marked ?? [])` (latest human record per capability, `files` from the top-level field).
- [ ] **Step 5: Run** `bunx vitest run tests/ship` — PASS.
- [ ] **Step 6: Commit** `feat(ship): durable-docs reads the behavior-change record`.

---

## Task 4: Packet readers — implements 4

**Covers:** 4.1, 4.2, 4.3, 4.4
**Difficulty:** Normal
**Blocked by:** none

**Files:**
- Create: `src/docs/readers.ts`
- Modify: `src/subagents/source-types.ts`, `src/subagents/sources.ts`, `src/extension.ts` (call `registerDocReaders()`)
- Test: `tests/docs/readers.test.ts`, `tests/subagents/sources.test.ts`

**Interfaces:** Contracts `SourceProvider`, `registerDocReaders`; consumes `parseGlossary`, `parseDecision`, `registerPacketSource`, `declaredCapabilities`.

- [ ] **Step 1: Write failing tests** in `tests/docs/readers.test.ts` (use `tests/subagents/packet-world.ts`): `Glossary entries for the unit` (entries `Token bucket`, `Receipt`; U2 mentions `token bucket` → source `file:specs/glossary.md` text contains only `Token bucket`); no matching term → no glossary source; `hyphenated term not matched inside another word`; `Spine and capability decisions` (sources include `0001-a.md`, `0003-c.md`, not `0004-d.md`). In `tests/subagents/sources.test.ts`: `Reviewer sees constraints` (subject `change` lists `file:specs/constraints.md`).
- [ ] **Step 2: Declare** `SourceProvider`'s optional `target` and a `registerDocReaders` stub, `bun run typecheck` (exit 0), then **run** `bunx vitest run tests/docs/readers.test.ts tests/subagents/sources.test.ts` — FAIL.
- [ ] **Step 3: Implement**: `SourceProvider` gains `target?: Target`; `registered()` passes `cx.target`; `readers.ts` providers `glossaryReader` (term match `new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, "i")` on the unit text or the `## Units` section) and `decisionReader` (read `specs/decisions/*.md`, `status: accepted` and `spine` or capability overlap with `declaredCapabilities`), registered for `implementer` and `reviewer`; add `constraints` to `REVIEWER_ALL` and `REVIEW_BASE`.
- [ ] **Step 4: Run** `bunx vitest run tests/docs tests/subagents` — PASS (existing packet hash tests stay green because the new sources are appended after the manifest).
- [ ] **Step 5: Commit** `feat(packets): glossary, decision and constraints readers`.

---

## Task 5: Pack, fixture and scout schema — implements 5

**Covers:** 5.1, 5.2, 5.3
**Difficulty:** Easy
**Blocked by:** Task 1, Task 2, Task 6

**Files:**
- Modify: `src/packs/agent-skills.yaml`, `tests/fixtures/agent-skills.pack.json`, `src/subagents/roles.ts`
- Test: the pack tests that load the fixture (`rg -l agent-skills.pack.json tests`), `tests/subagents/roles.test.ts`

- [ ] **Step 1: Update tests first**: fixture and spot-check assertions per flow-pack "Default flow pack" (define checks end with `product-impact`, `glossary-terms`, `behavior-change`; review checks `[product-impact, glossary-terms, behavior-change, review-clean]`; `decisions.behavior-change.mode` and `decisions.drift-severity.mode` = `rule`); `Scout verdicts accepted` (`checkSchema(resultSchema("scout"), { status: "DONE", notes: "", discoveries: [], sources_used: [], verdicts: [{ key: "dead-paths:x:src/**", verdict: "refuted", reason: "moved" }] })` → ok; `verdict: "maybe"` → error).
- [ ] **Step 2: Declare** `ScoutVerdict` and `SubagentResult.verdicts`, `bun run typecheck` (exit 0), then **run** `bunx vitest run tests/engine/pack-load.test.ts tests/subagents/roles.test.ts` — FAIL.
- [ ] **Step 3: Implement** the YAML changes and the scout schema.
- [ ] **Step 4: Run** `bun run test` — PASS (other flows' gate tests that build a `define` change may need a valid `Product impact` line in their fixtures; fix those fixtures, not the check).
- [ ] **Step 5: Commit** `feat(pack): durable doc checks and audit decision points`.

---

## Task 6: Drift detectors and severity — implements 6

**Covers:** 6.1, 6.2, 6.3, 6.4
**Difficulty:** Hard
**Blocked by:** Task 2

**Files:**
- Create: `src/audit/repo-view.ts`, `src/audit/items.ts` (`DriftType`, `DriftItem`, `pullRequestOf`), `src/audit/detect-specs.ts`, `src/audit/detect-docs.ts`, `src/audit/detect-fixes.ts`, `src/audit/severity.ts`
- Modify: `src/decide/registry.ts`
- Test: `tests/audit/seeded.ts`, `tests/audit/detect.test.ts`, `tests/audit/severity.test.ts`, `tests/engine/git.test.ts` (`listTree`)

**Interfaces:** Contracts `RepoView`, `repoViewAt`/`memoryView`, `DriftType`, `DriftItem`, `Severity`/`Route`, `ClassifiedItem`, `pullRequestOf`, `isIdentifierToken`/`isPathToken`, `detectSpecs`/`detectDocs`, `detectFixes`, `severityFacts`, `classify`, decision point `drift-severity`. Uses `Git.listTree` (Task 1).

- [ ] **Step 1: Write the seeded fixture** `tests/audit/seeded.ts`: `seededFiles(): Record<string, string>` with the seven seeded items of drift-audit "Seeded repository" and `seededFixes()` returning one commit `fix: tweak (#7)` and a forge stub whose PR #7 has head `fix/tweak` and a body with `formatDecisionBlock("lane", { …, outcome: { lane: "small", behavior_change: "declared-none", capabilities: ["rate-limit"] } })`.
- [ ] **Step 2: Write failing tests** in `tests/audit/detect.test.ts`: `Seeded repository` (keys exactly: `scenario-untested:rate-limit/rejects 101st request`, `removed-reference:rate-limit/src/limit/old.ts`, `dead-paths:rate-limit:src/gone/**`, `unused-term:Bucket`, `stale-decision:0002-x@specs/product.md`, `product-missing:cache`, `declared-none:pr#7:rate-limit`); `Tested scenario`; `Superseded decision mentioned as superseded`; `glob token ignored`; `empty repo view yields no items`; `pullRequestOf("feat: cap (#41)") === 41`, `pullRequestOf("Merge pull request #12 from x/y") === 12`, `pullRequestOf("tweak limits") === undefined`; a commit whose PR head is `livespec/x` → no item; `isIdentifierToken`: true for `rateLimit`, `RateLimiter`, `Change`, `Bucket`, `URLParser`, `rate_limit`; false for `abc`, `API`, `the`, `a.b`; `isPathToken`: true for `src/limit/old.ts`, false for `src/**`.
- [ ] **Step 3: Write failing tests** in `tests/audit/severity.test.ts`: `Major item`, `Minor item`, `Declared none with other drift`, `Declared none alone` (through `decide("drift-severity", …)` and through `classify`).
- [ ] **Step 4: Declare** contract types and stubs, `bun run typecheck` (exit 0), then **run** `bunx vitest run tests/audit` — FAIL.
- [ ] **Step 5: Implement** `repoViewAt` (reader = `git.showFile(commit, path)`), detectors per drift-audit "Drift detectors" (`isIdentifierToken`: length ≥ 4, `/^[A-Za-z][A-Za-z0-9_]*$/`, and either contains `_`, or has a lowercase and an uppercase letter, or is a capitalized word `/^[A-Z][a-z0-9]+$/`; an all-caps token is not an identifier; `isPathToken`: contains `/` and none of `*?[{`), severity rule + schema registered in `registerBuiltinRules`, `classify` computing `capabilityHasMajor` from the kept items.
- [ ] **Step 6: Run** `bunx vitest run tests/audit` — PASS.
- [ ] **Step 7: Commit** `feat(audit): drift detectors and drift-severity rule`.

---

## Task 7: Audit command, scout, report and triage — implements 7

**Covers:** 7.1, 7.2, 7.3, 7.4
**Difficulty:** Hard
**Blocked by:** Task 5, Task 6, Task 4

**Files:**
- Create: `src/audit/confirm.ts`, `src/audit/report.ts`, `src/audit/triage.ts`, `src/audit/state.ts` (the `AuditState` type only), `src/commands/audit.ts`
- Modify: `src/engine/git.ts` (`firstParentCommits`)
- Modify: `src/commands/subcommands.ts` (`auditReply`), `src/extension.ts` (route, `USAGE`, description)
- Test: `tests/audit/confirm.test.ts`, `tests/audit/report.test.ts`, `tests/audit/triage.test.ts`, `tests/engine/git.test.ts` (`firstParentCommits`), `tests/commands/audit.test.ts`, `tests/extension.test.ts` (usage lists `audit`)

**Interfaces:** Contracts `ConfirmDeps`, `confirmItems`, `applyTriage`, `AuditReport`, `renderReport`, marker kind `drift-report`, triage command, `AuditState`, `AuditDeps`, `AuditOutcome`, `runAudit`, `/livespec audit [#T]`. `runAudit` receives the state (fix cursor, pending initiatives) in `AuditDeps.state`; Task 7 defines the `AuditState` type in `src/audit/state.ts` (type only) and `auditReply` passes `{ pending: [] }` until Task 8 adds `readAuditState`/`completeAudit`. Consumes Task 6 exports, `runDispatch`, `withTempWorktree`, the protocol text of `src/subagents/protocol.ts`; tests use `fakeExecutor` and `MemoryWorld` (`tests/forge/memory-forge.ts`).

- [ ] **Step 1: Write failing tests** in `tests/audit/confirm.test.ts`: `Renamed test refuted`; `No executor` (all heuristic items `confirmed: false`); `Launch mismatch` (fake executor reports another `cwd` → unconfirmed; no `createComment` on any issue of the `MemoryWorld` forge); `Scout sees the audited snapshot` and `Audit scout launch` (spawn options: `cwd` is a worktree at the audited SHA, `metadata.change === "audit"`, `thinkingLevel === "low"`, no `model`, and `excludeExtensionPackages` contains both a known-flow package and a user `isolation.excludePackages` entry passed in `ConfirmDeps.exclusions`); `Audit scout writes no dispatch record`.
- [ ] **Step 2: Write failing tests** in `tests/audit/report.test.ts` and `tests/audit/triage.test.ts`: `Posted on the initiative`, `No initiative`, `Marker kind registered`, `Minor raised to major`, `Major lowered to minor`, `Reader without write access`, unmatched key listed.
- [ ] **Step 2b: Write failing tests** in `tests/engine/git.test.ts`: `firstParentCommits` with `after` returns only first-parent commits after it, oldest first, with subjects; side-branch-only commits of a merge are excluded; with `since` a commit dated 31 days ago (`GIT_COMMITTER_DATE`) is excluded and one dated 29 days ago is included; nothing after `commit` is returned.
- [ ] **Step 3: Write failing tests** in `tests/commands/audit.test.ts` (real temp repo with a bare `origin`, `MemoryWorld`): `Read-only on files`, `Integration snapshot, not the feature branch`, `Fetch fails with a local ref`, `No integration ref`, `Forge unavailable`, `Seeded audit with a confirming scout`, `Not initialized`, `Audit routed`, `Audit scout not inline`; update `Usage lists subcommands` in `tests/extension.test.ts`.
- [ ] **Step 4: Declare** contract types and stubs, `bun run typecheck` (exit 0), then **run** `bunx vitest run tests/audit tests/commands/audit.test.ts tests/engine/git.test.ts` — FAIL.
- [ ] **Step 5: Implement** `confirm.ts` (packet text = protocol prefix + task listing items wrapped by `untrusted()` + `Audited commit: <sha>`; `runDispatch` with `post: async () => {}`; map outcome kinds other than `result` to unconfirmed with a note), `report.ts` (render; `registerKind("drift-report")`; post via `createComment` when target and writable), `triage.ts`, `runAudit` (fetch → `origin/<integration>` with fallback/refusal → `repoViewAt` → detectors (fixes over `git.firstParentCommits(commit, state.fixCursor ? { after: state.fixCursor } : { since: "30.days" })`) → confirm → classify → triage → report).
- [ ] **Step 6: Run** `bunx vitest run tests/audit tests/commands tests/engine/git.test.ts tests/extension.test.ts` — PASS.
- [ ] **Step 7: Commit** `feat(audit): /livespec audit command, scout confirmation, report and triage`.

---

## Task 8: Audit suggestions — implements 8

**Covers:** 8.1, 8.2, 8.3, 8.4
**Difficulty:** Hard
**Blocked by:** Task 7

**Files:**
- Create: `src/audit/suggest.ts`, `src/audit/card.ts`
- Modify: `src/audit/state.ts` (read/write), `src/engine/git.ts` (`commitPaths`, `commonDir`), `src/hooks/session.ts` (`auditState` on the session, session-start step, `livespec:initiative-closed` listener), `src/hooks/phase-card.ts` (`CardInput.audit`), `src/hooks/card-input.ts` (fill `audit` in `Common`), `src/commands/subcommands.ts` and `src/commands/audit.ts` (read state, call `completeAudit`, write state, update `session.auditState`)
- Test: `tests/audit/state.test.ts`, `tests/audit/suggest.test.ts`, `tests/engine/git.test.ts` (`commitPaths`, `commonDir`), `tests/hooks/phase-card.test.ts`, `tests/e2e/audit-flow.test.ts`

**Interfaces:** Contracts `Git.commitPaths`, `Git.commonDir`, `readAuditState`/`writeAuditState`, `scanCommits`, `addInitiative`/`completeAudit`, `CardInput.audit`, `audit.json`. Data flow: session start → `readAuditState` → `scanCommits` → `writeAuditState` → `session.auditState`; `buildCardInput` copies the pending reasons into `Common.audit`; the `audit` card section renders them purely; `/livespec audit` reads the state, passes it in `AuditDeps.state`, then `completeAudit` → write → `session.auditState`.

- [ ] **Step 1: Write failing tests** in `tests/audit/state.test.ts`: round trip; `corrupt state treated as missing`; write is atomic (no partial file after a thrown rename stub).
- [ ] **Step 2: Write failing tests** in `tests/audit/suggest.test.ts`: first run sets cursor only; `Manual commit suggests an audit`; `Livespec merge is not suggested`; `More than 50 commits` (60 commits, 55th manual → first scan adds nothing and cursor = 50th; second scan suggests the 55th); forge error keeps cursor; `Initiative closed`; `Audit clears covered suggestions`; `Skipped fix detector keeps the fix cursor`; `Fix merged during the audit`; `manual --no-ff merge` (a merge commit without a pull request number, bringing `src/limit/cap.ts` → suggestion, cursor past it). In `tests/hooks/phase-card.test.ts`: `audit section` (`audit: ["commit bbb touches rate-limit"]` → card contains it and `/livespec audit`; resume card too).
- [ ] **Step 3: Write failing e2e** `tests/e2e/audit-flow.test.ts`: a manual commit pushed to `origin/main` under a capability's `paths` → next `session_start` card contains `Audit` and `/livespec audit`; running the audit clears it.
- [ ] **Step 4: Declare** contract types and stubs, `bun run typecheck` (exit 0), then **run** `bunx vitest run tests/audit tests/hooks/phase-card.test.ts tests/engine/git.test.ts tests/e2e/audit-flow.test.ts` — FAIL.
- [ ] **Step 5: Implement** state, scanning (oldest 50 of `git.firstParentList("<cursor>..origin/<integration>")`, `commitPaths`, `pullRequestOf` + `forge.getPullRequest(n).head`), the event listener (`pi.events.on("livespec:initiative-closed", …)`), the session-start step (errors recorded on the session, never thrown) and the card section (`Audit: <reasons> — run /livespec audit`).
- [ ] **Step 6: Run** `bun run test` — PASS.
- [ ] **Step 7: Commit** `feat(audit): audit suggestions after initiatives and manual commits`.

---

## Task 9: Durable documentation — implements 9

**Covers:** 9.1, 9.2
**Difficulty:** Easy
**Blocked by:** Task 3, Task 4, Task 8

**Files:**
- Modify: `docs/architecture.md`, `docs/glossary.md`

- [ ] **Step 1:** Add `docs/` and `audit/` to the module diagram; add a "Durable docs" section (product-impact, glossary-terms, behavior-change question at define/review, ship reuse, readers) and an "Audit" section (snapshot, detectors, scout, `drift-severity`, report, triage, suggestions, `audit.json`).
- [ ] **Step 2:** Add `- **Drift report**: ...` to `docs/glossary.md` in A to Z order.
- [ ] **Step 3: Run** `bun run typecheck && bun run test` — both exit 0.
- [ ] **Step 4: Commit** `docs: durable docs and drift audit`.

---

## Scenario → test

- decision-seam / Record fields → tests/decide/records.test.ts (existing)
- decision-seam / Large facts hashed → tests/decide/records.test.ts (existing)
- decision-seam / Lane decision in the pull request only → tests/tools/fix-ship.test.ts (existing)
- decision-seam / Proposal record is not current → tests/decide/records.test.ts (existing)
- decision-seam / Behavior files kept with hashed facts → tests/decide/records.test.ts
- drift-audit / Read-only on files → tests/commands/audit.test.ts
- drift-audit / Integration snapshot, not the feature branch → tests/commands/audit.test.ts
- drift-audit / Fetch fails with a local ref → tests/commands/audit.test.ts
- drift-audit / No integration ref → tests/commands/audit.test.ts
- drift-audit / Not initialized → tests/commands/audit.test.ts
- drift-audit / Seeded repository → tests/audit/detect.test.ts
- drift-audit / Tested scenario → tests/audit/detect.test.ts
- drift-audit / Superseded decision mentioned as superseded → tests/audit/detect.test.ts
- drift-audit / Forge unavailable → tests/commands/audit.test.ts
- drift-audit / Renamed test refuted → tests/audit/confirm.test.ts
- drift-audit / Scout sees the audited snapshot → tests/audit/confirm.test.ts
- drift-audit / Seeded audit with a confirming scout → tests/commands/audit.test.ts
- drift-audit / No executor → tests/audit/confirm.test.ts
- drift-audit / Launch mismatch → tests/audit/confirm.test.ts
- drift-audit / Major item → tests/audit/severity.test.ts
- drift-audit / Minor item → tests/audit/severity.test.ts
- drift-audit / Declared none with other drift → tests/audit/severity.test.ts
- drift-audit / Declared none alone → tests/audit/severity.test.ts
- drift-audit / Posted on the initiative → tests/audit/report.test.ts
- drift-audit / No initiative → tests/audit/report.test.ts
- drift-audit / Marker kind registered → tests/audit/report.test.ts
- drift-audit / Minor raised to major → tests/audit/triage.test.ts
- drift-audit / Major lowered to minor → tests/audit/triage.test.ts
- drift-audit / Reader without write access → tests/audit/triage.test.ts
- drift-audit / Manual commit suggests an audit → tests/audit/suggest.test.ts + tests/e2e/audit-flow.test.ts
- drift-audit / Livespec merge is not suggested → tests/audit/suggest.test.ts
- drift-audit / More than 50 commits → tests/audit/suggest.test.ts
- drift-audit / Initiative closed → tests/audit/suggest.test.ts
- drift-audit / Audit clears covered suggestions → tests/audit/suggest.test.ts
- drift-audit / Fix merged during the audit → tests/audit/suggest.test.ts
- drift-audit / Skipped fix detector keeps the fix cursor → tests/audit/suggest.test.ts
- durable-doc-checks / Missing product impact blocks the define gate → tests/tools/spec-gate-behavior.test.ts › product impact refusal
- durable-doc-checks / None with a reason → tests/docs/product-impact.test.ts
- durable-doc-checks / None with a new capability → tests/docs/product-impact.test.ts
- durable-doc-checks / Updated → tests/docs/product-impact.test.ts
- durable-doc-checks / New bold term warns → tests/docs/glossary-terms.test.ts
- durable-doc-checks / Known term → tests/docs/glossary-terms.test.ts
- durable-doc-checks / New proper noun warns → tests/docs/glossary-terms.test.ts
- durable-doc-checks / Proper noun exclusions → tests/docs/glossary-terms.test.ts
- durable-doc-checks / Scenario keywords ignored → tests/docs/glossary-terms.test.ts
- durable-doc-checks / Proposed entries shown at the gate → tests/docs/glossary-terms.test.ts
- durable-doc-checks / Code changed, spec unchanged → tests/docs/behavior-change.test.ts
- durable-doc-checks / Spec changed too → tests/docs/behavior-change.test.ts
- durable-doc-checks / Always asks → tests/docs/behavior-change.test.ts
- durable-doc-checks / Answer recorded → tests/tools/spec-gate-behavior.test.ts › Asked once at define (asserts the decision comment fields)
- durable-doc-checks / New file asks again → tests/tools/spec-gate-behavior.test.ts › New file asks again at the gate
- durable-doc-checks / Asked once at define → tests/tools/spec-gate-behavior.test.ts
- durable-doc-checks / Other refusal asks nothing → tests/tools/spec-gate-behavior.test.ts
- durable-doc-checks / Changed answer blocks the same call → tests/tools/spec-gate-behavior.test.ts
- durable-doc-checks / Forge request pending → tests/tools/spec-gate-behavior.test.ts
- durable-doc-checks / Unanswered item names the gate → tests/docs/behavior-change.test.ts
- durable-doc-checks / Behavior changed without a spec edit → tests/docs/behavior-change.test.ts
- durable-doc-checks / Spec updated after a changed answer → tests/docs/behavior-change.test.ts
- flow-pack / Default pack loads → tests/engine/pack-load.test.ts (existing)
- flow-pack / Default pack contents → tests/engine/pack-load.test.ts (updated fixture)
- flow-pack / Spot check → tests/engine/pack-load.test.ts (updated)
- init-and-doctor / Usage lists subcommands → tests/extension.test.ts (updated)
- init-and-doctor / Audit routed → tests/commands/audit.test.ts
- phase-gates / Blocking question keeps the gate closed → tests/engine/gates.test.ts (existing)
- phase-gates / Failing check that is not waivable → tests/engine/gates.test.ts (existing)
- phase-gates / Gate-only check runs at the gate → tests/evidence/red-on-base.test.ts (existing)
- phase-gates / Forge answer completed without rerunning gate-only checks → tests/evidence/red-on-base.test.ts (existing)
- phase-gates / Self gate → tests/tools/spec-gate.test.ts (existing)
- phase-gates / Registered gate → tests/tools/spec-gate.test.ts (existing)
- phase-gates / Named gate option recorded → tests/tools/spec-gate.test.ts (existing)
- phase-gates / Named gate option does not waive → tests/tools/spec-gate.test.ts (existing)
- phase-gates / Gate with a proposer → tests/tools/spec-gate.test.ts (existing)
- phase-gates / Gate effect runs once before the result → tests/interaction/complete.test.ts (existing)
- phase-gates / Proposer gate survives work in progress → tests/interaction/complete.test.ts (existing)
- phase-gates / Parked change refuses the plan gate → tests/engine/gates.test.ts (existing)
- phase-gates / Forge answer on a parked change → tests/interaction/complete.test.ts (existing)
- phase-gates / Validator supersedes → tests/interaction/complete.test.ts (existing)
- phase-gates / No effect on changes requested → tests/interaction/complete.test.ts (existing)
- phase-gates / Behavior answer before a refusal → tests/tools/spec-gate-behavior.test.ts
- ship-phase / Capability code without a spec row → tests/ship/durable-docs.test.ts (existing)
- ship-phase / Behavior answered earlier → tests/ship/durable-docs.test.ts
- ship-phase / Record misses a file → tests/ship/durable-docs.test.ts
- ship-phase / Newer changed record wins → tests/ship/context.test.ts › Newer changed record wins (records)
- ship-phase / Superset record → tests/ship/durable-docs.test.ts
- ship-phase / Constraints without a decision → tests/ship/durable-docs.test.ts (existing)
- ship-phase / Constraints with a decision → tests/ship/durable-docs.test.ts (existing)
- ship-phase / Changed durable doc without a row → tests/ship/durable-docs.test.ts (existing)
- subagent-dispatch / Blocked without evidence → tests/subagents/dispatch.test.ts (existing)
- subagent-dispatch / Verifier without a verdict → tests/tools/subagent-record.test.ts (existing)
- subagent-dispatch / Scout verdicts accepted → tests/subagents/roles.test.ts
- subagent-dispatch / Raised after a failure → tests/subagents/dispatch.test.ts (existing)
- subagent-dispatch / Routed by another layer → tests/subagents/dispatch.test.ts (existing)
- subagent-dispatch / Audit scout effort → tests/audit/confirm.test.ts › Audit scout launch
- subagent-dispatch / Implementer launch → tests/subagents/dispatch.test.ts (existing)
- subagent-dispatch / Audit scout launch → tests/audit/confirm.test.ts
- subagent-dispatch / No executor → tests/tools/subagent-record.test.ts › no executor (existing)
- subagent-dispatch / Inline review recorded → tests/tools/subagent-record.test.ts (existing)
- subagent-dispatch / Audit scout not inline → tests/commands/audit.test.ts
- subagent-dispatch / Discoveries reach the dependent unit → tests/tools/subagent-dispatch.test.ts (existing)
- subagent-dispatch / Marker kind registered → tests/subagents/records.test.ts › dispatch marker kind registered (existing)
- subagent-dispatch / Audit scout writes no dispatch record → tests/audit/confirm.test.ts
- subagent-packets / Answered question included → tests/subagents/sources.test.ts (existing)
- subagent-packets / Spec review sees the diff → tests/subagents/sources.test.ts (existing)
- subagent-packets / Diff as a file → tests/subagents/sources.test.ts (existing)
- subagent-packets / Persona file → tests/subagents/sources.test.ts (existing)
- subagent-packets / Verifier of an in-change finding → tests/subagents/sources.test.ts (existing)
- subagent-packets / Glossary entries for the unit → tests/docs/readers.test.ts
- subagent-packets / Spine and capability decisions → tests/docs/readers.test.ts
- subagent-packets / Reviewer sees constraints → tests/subagents/sources.test.ts
