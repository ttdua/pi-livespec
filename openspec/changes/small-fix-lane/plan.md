# Small-fix Lane Implementation Plan

> Executed via `/opsx-apply`, which chooses the executor.
> Spec reference: this change's `specs/` (`small-fix-lane`, `command-guards`, `change-tools`, `init-and-doctor`, `flow-pack`) and `design.md`.

**Goal:** Add the small-fix lane (`fix_start`, rule `lane`, `fix_ship`, `change_new --from-fix`, the fix card) and bare-work logging, so a small fix ships as one tested pull request and a fix that changes the contract is forced into a full change that keeps its commits.

**Architecture:** A new `src/fix/` module holds the fix-branch helpers, the git-built lane facts, the pure `lane` rule and the fix pull request body; it depends on `src/core`, `src/engine/git.ts`, `src/decide` and two exported `src/ship` helpers, never the reverse. Tools in `src/tools/` stay thin (refusals in spec order, then effects). Bare work is a separate `src/guard/bare-work.ts` unit called from the guard hook, with a `tool_result` handler that appends its warning.

**Tech Stack:** TypeScript (ESM, `.ts` imports), Bun, vitest, the `yaml` package, git CLI through `GitExec`; tests use the memory forge and real temporary repos (`tests/tools/helpers.ts` `toolHarness`, `tests/ship/repo.ts` `fixture`).

## Global Constraints

- Default lane config exactly `decisions.lane: { mode: rule, max_files: 3, max_lines: 100 }`.
- Fix branch pattern `fix/<slug>`, `<slug>` passes `isKebabName`.
- `guardedPush` remote `origin`, refspec `HEAD:refs/heads/fix/<slug>`; only `change-ship.ts`, `change-push.ts`, `fix-ship.ts` import `src/guard/push.ts`.
- Bare-work line exactly `<YYYY-MM-DD> — <path> — <tool> outside a change or fix branch` (separator ` — `, em dash), local date, path relative to the project root with `/`.
- Lane outcome map exactly `{ lane: small | forced, reasons: string[], behavior_change?: declared-none, capabilities?: string[] }`; decision `reason` = reasons joined with `; ` or `within the small-fix limits`.
- Fix tools refuse when the fetch or the merge base fails (no fallback base).
- Guard messages start with `livespec guard:`.
- No new dependency; no push from bash; tools refuse in child sessions via `childRefusal`.
- Commit messages in English, conventional style (`feat(small-fix-lane): …`).

## Review Focus

- Spec file deleted or newly created on the fix branch (`showFile` undefined on one side) → treated as all requirements removed or added, never a crash. Test in Task 2 (`spec deleted on the fix branch forces`).
- Merge commits from the integration branch on the fix branch → the merge base moves, so upstream work is not counted. Test in Task 2 (`integration merge is not counted`).
- `testCommand` blocked by the guard (contains `git push`) → refusal with the guard reason, nothing pushed. Test in Task 4 (`guard-blocked test command refuses`).
- Edit of a path outside the project root or a symlink into `.pi/livespec/` → not bare work (the existing block wins). Test in Task 7 (`path outside the project is not logged`).
- Two parallel `edit` calls on `main` for the same file → one log line. Test in Task 7 (`parallel edits log once`).

---

## Contracts

| Name | new / modified | Shape | public |
|---|---|---|---|
| `ProjectConfig.testCommand` | new | `testCommand?: string` in `src/config.ts`; YAML key `testCommand` in `.pi/livespec/config.yaml` | yes |
| `Git.diffNumstat` | new | `diffNumstat(from: string, to: string): Promise<NumstatEntry[]>` (`git diff --numstat -z -M --end-of-options <from>..<to>`; a rename record is `added\tdeleted\t\0old\0new\0` → one entry with the new path); `NumstatEntry = { path: string; added: number; deleted: number; binary: boolean }` (`-` → 0, `binary: true`) | no |
| `Git.showFile` | new | `showFile(rev: string, path: string): Promise<string \| undefined>` (`git show <rev>:<path>`, undefined when missing) | no |
| `Git.renameBranch` | new | `renameBranch(from: string, to: string): Promise<void>` (`git branch -m -- <from> <to>`) | no |
| `Git.isTracked` | new | `isTracked(path: string): Promise<boolean>` (`git ls-files --error-unmatch -- <path>`) | no |
| `Git.subjects` | new | `subjects(from: string, to: string): Promise<string[]>` (`git log --reverse --no-merges --format=%s <from>..<to>`, oldest first) | no |
| `livingSpecs` | modified (exported) | `livingSpecs(root: string): Promise<{ capability: string; paths: string[] }[]>` from `src/ship/context.ts` | no |
| `capOf` | modified (exported) | `capOf(path: string): string \| undefined` from `src/core/capabilities-diff.ts` | no |
| `fixSlug` | new | `fixSlug(branch: string): string \| undefined` in `src/fix/branch.ts` | no |
| `fixMergeBase` | new | `fixMergeBase(git: Git, integration: string): Promise<string>` (throws `GitError` when the fetch or ref fails) | no |
| `LaneFacts` | new | `{ files: string[]; lines: number; spec_changes: SpecChange[]; created_capabilities: string[]; governance: string[]; capability_code: { capability: string; files: string[]; spec_changed: boolean }[] }`; `SpecChange = { capability: string; added_requirements: string[]; removed_requirements: string[]; scenarios: { requirement: string; added: string[]; removed: string[] }[] }` (snake_case: written verbatim into the decision block's `facts`) | no |
| `laneFacts` | new | `laneFacts(git: Git, root: string, mergeBase: string): Promise<LaneFacts>` in `src/fix/lane-facts.ts` | no |
| `LaneConfig` | new | `{ mode: "rule"; max_files: number; max_lines: number }` | yes (pack key `decisions.lane`) |
| `LaneOutcome` | new | `{ lane: "small" \| "forced"; reasons: string[]; behavior_change?: "declared-none"; capabilities?: string[] }` | yes (in the PR decision block) |
| `laneRule` / `laneRuleFn` / `laneSchema` | new | `laneRule(facts: LaneFacts, config: LaneConfig): LaneOutcome`; `laneRuleFn: RuleFn`; `laneSchema: RuleSchema` in `src/fix/lane.ts` | no |
| `fixNextStep` | new | `fixNextStep(fix: FixCard): string` in `src/hooks/phase-card.ts` (the one `Next:` sentence: `fix_ship`, `change_new <name> --from-fix`, nothing to ship, or the facts error) | no |
| `fixPullRequestBody` | new | `fixPullRequestBody(i: { slug: string; subjects: string[]; test: { command: string; exit: number; head: string; output: string }; record: DecisionRecord }): { title: string; body: string }` in `src/fix/pr-body.ts` | no |
| Fix PR body format | new | commit subject list, `## Test` (command, `exit 0`, short SHA, fenced tail ≤ 4096 bytes), then `formatDecisionBlock("lane", record)` | yes |
| Tool `fix_start` | new | params `{ slug: string }`; details `{ branch?: string }` | yes |
| Tool `fix_ship` | new | params `{}`; details `{ pr?: number }` | yes |
| Tool `change_new` | modified | params `{ name: string; from_fix?: boolean }`; details `{ number?: number; branch?: string }` | yes |
| `CardInput` fix kind | new | `FixCard = { slug: string; outcome?: LaneOutcome; error?: string; empty?: true }`; `CardInput` (in `src/hooks/phase-card.ts`) gains `{ kind: "fix" } & FixCard`; `fixCard(session: Session, slug: string): Promise<FixCard>` in `src/hooks/card-input.ts`, memoized on the session by HEAD and integration branch | no |
| `CurrentChange` fix kind | modified | `CurrentChange` in `src/tools/guard.ts` adds `{ kind: "fix"; fix: FixCard }`; `requireChange` refuses on it with `On fix/<slug>: run fix_ship or change_new <name> --from-fix; there is no change issue.`; `spec_next` and `spec_status` details gain `fix?: FixCard & { next: string }` | yes (tool details) |
| Decision-seam unknown-point example | modified | `decisions.nope` instead of `decisions.lane` in `tests/decide/registry.test.ts` | no |
| `isBareWork` / `appendBareWork` | new | `isBareWork(i: { root: string; path: string; branch: string; tracked: (p: string) => Promise<boolean> }): Promise<string \| undefined>` (returns the relative path when bare; rejects when `tracked` rejects, and the guard catches it in its own `try`); `appendBareWork(root: string, rel: string, tool: "write" \| "edit", date: string): Promise<{ written: boolean; error?: string }>` (never rejects); `localDate(d: Date): string` (`YYYY-MM-DD` from `getFullYear`/`getMonth`/`getDate`) in `src/guard/bare-work.ts` | no |
| `specs/bare-work.md` line | new (writer) | `<YYYY-MM-DD> — <path> — <tool> outside a change or fix branch` | yes |

---

## Task 1: Config, git and decision ports — implements 1

**Covers:** 1.1, 1.2, 1.3
**Difficulty:** Easy
**Blocked by:** none

**Files:**
- Modify: `src/config.ts`, `src/engine/git.ts`, `src/ship/context.ts`, `src/core/capabilities-diff.ts`
- Test: `tests/config.test.ts`, `tests/engine/git.test.ts`

**Interfaces:**
- Produces: `ProjectConfig.testCommand`, `Git.diffNumstat`, `Git.showFile`, `Git.renameBranch`, `Git.isTracked`, `Git.subjects`, exported `livingSpecs`, `capOf`.

- [ ] **Step 1:** Write tests `Test command` (`testCommand: bun test` → `project.testCommand === "bun test"`, no warning) and `Invalid test command` (`testCommand: [bun, test]` → a warning containing `testCommand`, `project.testCommand` undefined) in `tests/config.test.ts`.
- [ ] **Step 2:** Run `bunx vitest run tests/config.test.ts`; expect both FAIL.
- [ ] **Step 3:** Add `testCommand` to `ProjectConfig`, `PROJECT_KEYS` and the reader via `optionalString`.
- [ ] **Step 4:** Run the same test; expect PASS.
- [ ] **Step 5:** Write git tests on a temporary repo: `diffNumstat` reports `{ path: "a.txt", added: 2, deleted: 1, binary: false }` and a binary file as `binary: true` with 0/0; `showFile("HEAD", "missing")` is undefined and `showFile("HEAD", "a.txt")` the content; `renameBranch("fix/x", "livespec/y")` keeps the HEAD SHA and removes `fix/x`; `isTracked` true for a committed file, false for an untracked one; `subjects(base, "HEAD")` returns two commit subjects oldest first and skips a merge commit; `rename reports the new path once` (`git mv a.txt b.txt` plus an edit → one entry `b.txt`).
- [ ] **Step 6:** Run; expect FAIL. Implement the five methods with `END_OF_OPTIONS`/`--` like the existing ones (`cat-file -e` exit 128 → undefined for `showFile`; `ls-files --error-unmatch` exit 1 → false).
- [ ] **Step 7:** Run; expect PASS. Export `livingSpecs` and `capOf`; run `bun run typecheck`.
- [ ] **Step 8:** Commit `feat(small-fix-lane): config testCommand and git ports`.

---

## Task 2: Lane rule — implements 2

**Covers:** 2.1, 2.2, 2.3, 2.4, 2.5
**Difficulty:** Hard
**Blocked by:** Task 1

**Files:**
- Create: `src/fix/branch.ts`, `src/fix/lane-facts.ts`, `src/fix/lane.ts`
- Modify: `src/decide/registry.ts`, `src/packs/agent-skills.yaml`, `tests/fixtures/agent-skills.pack.json`, `tests/decide/registry.test.ts`
- Test: `tests/fix/branch.test.ts`, `tests/fix/lane-facts.test.ts`, `tests/fix/lane.test.ts`, `tests/engine/pack-load.test.ts`

**Interfaces:**
- Consumes: Task 1 git ports, `livingSpecs`, `capOf`, `parseSpec`, `isKebabName`, `registerRule`.
- Produces: `fixSlug`, `fixMergeBase`, `LaneFacts`, `laneFacts`, `LaneConfig`, `LaneOutcome`, `laneRule`, `laneRuleFn`, `laneSchema`.

- [ ] **Step 1:** Tests `Hand-made fix branch` / `Not a fix branch`: `fixSlug("fix/typo") === "typo"`, `fixSlug("fix/Typo_1")`, `fixSlug("fixes/typo")`, `fixSlug("fix/")` undefined. Run, FAIL; implement; PASS.
- [ ] **Step 2:** Pure rule tests in `tests/fix/lane.test.ts` over hand-built `LaneFacts` with config `{ mode: "rule", max_files: 3, max_lines: 100 }`: `Small fix` (2 files, 12 lines, one `spec_changes` entry for `forge-read` with every list empty → `lane: "small"`, `reasons: []`); `Added requirement forces` (reason contains `forge-read` and `Retry budget`); `Removed scenario forces` (reason contains the requirement and `Stale cache`); `Too many files` (4 files → reason contains `max_files` and `3`); `Too many lines` (101 lines → reason contains `max_lines` and `100`); a rename counts once; `New capability` (reason contains `retry-policy`); `Governance files` (`specs/constraints.md`, `specs/decisions/0007-x.md` each named); `Code without spec change` (`behavior_change: "declared-none"`, `capabilities: ["forge-read"]`, still `lane: "small"`); `Code with spec change` (no `behavior_change`, no `capabilities`).
- [ ] **Step 3:** Run `bunx vitest run tests/fix/lane.test.ts`; FAIL. Implement `laneRule` as one small function per condition, concatenating reasons in the spec's bullet order; `laneRuleFn` returns `{ outcome, reason: outcome.reasons.join("; ") || "within the small-fix limits" }`. PASS.
- [ ] **Step 4:** Schema tests (`Invalid limit`): `max_files: 0`, `max_lines: "x"` and an unknown key each report an error with line and column; valid config none. Implement `laneSchema` with `checkAllowedKeys(["mode", "max_files", "max_lines"])` plus positive-integer checks.
- [ ] **Step 5:** Facts tests on a real repo (`tests/ship/repo.ts` style): fix branch adding `### Requirement: Retry budget` → `spec_changes[0].added_requirements` = `["Retry budget"]`; `Small fix` facts (editing scenario text only → an entry with empty lists); a rename counts once in `files`; `spec deleted on the fix branch forces` (all requirements listed removed); new `specs/retry-policy/spec.md` → `created_capabilities` = `["retry-policy"]`; `integration merge is not counted` (merge `origin/main` with an upstream file into the fix branch → that file absent from `files`); capability code with `paths: [src/forge/**]` → `capability_code`.
- [ ] **Step 6:** Implement `fixMergeBase` (fetch `origin <integration>`, `mergeBase("HEAD", "origin/<integration>")`) and `laneFacts` (numstat → files/lines; for each changed `specs/<cap>/spec.md`, `parseSpec` of `showFile(M, p)` and `showFile("HEAD", p)` — undefined parses as no requirements; requirement and scenario name set differences; created capabilities = each `capOf` of a changed path where `pathExistsAt(M, "specs/<cap>")` is false and `pathExistsAt(HEAD, "specs/<cap>")` true; governance = `specs/constraints.md` or `specs/decisions/` prefix; capability code via `livingSpecs(root)` and `matchGlob`). Run; PASS.
- [ ] **Step 7:** Change the `Unknown point` test in `tests/decide/registry.test.ts` to `nope: { mode: rule }` expecting "no rule is registered for decision point `nope`". Register `registerRule("lane", laneSchema, laneRuleFn)` in `registerBuiltinRules`; add `lane: { mode: rule, max_files: 3, max_lines: 100 }` to the pack and the fixture; add a `Project override` test (`extends: agent-skills` with `decisions.lane: { mode: rule, max_files: 5 }` → effective `{ mode: "rule", max_files: 5, max_lines: 100 }`) and update the `Spot check` assertion. Run `bun run test`; PASS.
- [ ] **Step 8:** Commit `feat(small-fix-lane): lane rule and facts`.

---

## Task 3: Fix start — implements 3

**Covers:** 3.1
**Difficulty:** Normal
**Blocked by:** Task 2

**Files:**
- Create: `src/tools/fix-start.ts`
- Modify: `src/tools/change-tools.ts`, `tests/extension.test.ts`, `tests/tools/register.test.ts` (tool-name lists)
- Test: `tests/tools/fix-start.test.ts`

**Interfaces:**
- Consumes: `fixSlug`, `integrationBranch`, `Git.fetch`/`revParse`/`switchCreate`/`branchExists`/`isDirty`, `childRefusal`, `toolResult`.
- Produces: tool `fix_start`.

- [ ] **Step 1:** Tests with `toolHarness`: `Start a fix` (branch `fix/typo-in-readme` at `origin/main` SHA, `searchIssues` empty, `originRefs` unchanged); `Dirty tree` (refuses, no `fix/typo` ref); `From a change branch` (`branch: "livespec/rate-limit"` → refusal names it); non-kebab slug refused; existing `fix/typo` refused; unknown integration branch refused; child session refused.
- [ ] **Step 2:** Run; FAIL. Implement: refusals in that order, then `fetch`, `revParse("origin/<integration>")`, `switchCreate("fix/<slug>", sha)`; message `Started fix/<slug> at origin/<integration> <sha>. No issue was created and nothing was pushed.` Register it in `registerChangeTools` via `registerLivespecTool` with a JSON-schema `slug` string, and add `fix_start` to the two tool-name test lists.
- [ ] **Step 3:** Run; PASS. `bun run typecheck`.
- [ ] **Step 4:** Commit `feat(small-fix-lane): fix_start`.

---

## Task 4: Fix ship — implements 4

**Covers:** 4.1, 4.2, 4.3, 4.4
**Difficulty:** Hard
**Blocked by:** Task 2, Task 3

Task 3 is an added dependency: both register tools in `src/tools/change-tools.ts` and the same two test lists.

**Files:**
- Create: `src/fix/pr-body.ts`, `src/tools/fix-ship.ts`
- Modify: `src/tools/change-tools.ts`, `tests/extension.test.ts`, `tests/tools/register.test.ts`, `tests/guard/push-callers.test.ts`
- Test: `tests/fix/pr-body.test.ts`, `tests/tools/fix-ship.test.ts`

**Interfaces:**
- Consumes: `fixSlug`, `fixMergeBase`, `laneFacts`, `decide`, `formatDecisionBlock`, `parseDecisionBlocks`, `neutralizeClosing`, `runVerify`, `verifyEnv`, `guardedPush`, `withEvidenceLock`, `prepareWrite`, `Forge.whoami`/`listPullRequests`/`createPullRequest`/`updatePullRequest`, `integrationBranch`.
- Produces: `fixPullRequestBody`, tool `fix_ship`.

- [ ] **Step 1:** Body tests: `Body round trip` (`parseDecisionBlocks(body)` → one record with `point: "lane"`, `subject: "typo"`, `outcome.lane === "small"`, `reason === "within the small-fix limits"`; `test output cannot inject a decision block` (output containing a ``` line, `<!-- livespec:decision:lane -->` and a yaml fence → still exactly one record); body contains `## Test` and `exit 0`); `Declared none in the block` (record outcome `behavior_change: "declared-none"`, `capabilities: ["forge-read"]`); `No closing keyword` (subject `Fixes #40` → body has `Refs #40`, not `Fixes #40`); title = first subject. Run; FAIL; implement (neutralize the text before appending the block; fence the output with one backtick more than its longest run; indent output lines starting `<!-- livespec:decision:` by two spaces); PASS.
- [ ] **Step 2:** Update `push-callers.test.ts`: allowed set adds `fix-ship.ts`; add test `Refspec from the fix branch` asserting the recorded git call `["push", "--", "origin", "HEAD:refs/heads/fix/typo"]` after a successful `fix_ship`.
- [ ] **Step 3:** Tool tests with `toolHarness` (`config: "testCommand: true\n"` style, branch `fix/typo` with one commit): `Ship a small fix` (origin has `refs/heads/fix/typo` at HEAD; one open PR head `fix/typo` base `main`; details `{ pr }`); `Forced fix refused` (commit adds a requirement → text names it and `change_new <name> --from-fix`; origin unchanged; no PR); `Failing tests` (`testCommand: "echo boom; exit 1"` → text has `exit 1` and `boom`; nothing pushed); `No test command` (text names `testCommand` and `.pi/livespec/config.yaml`); `Rerun updates the pull request` (second commit, second call → same PR number, body shows the new short SHA, `listPullRequests` length 1); `Nothing to ship` (no commit after the merge base → refusal says nothing to ship, nothing pushed); `Foreign pull request` (seeded open PR head `fix/typo` by another login → refusal names it, PR body unchanged); `Lane decision in the pull request only` (seed one open `livespec` issue; after a ship it has no comment); unknown integration branch refused; `updatePullRequest` conflict → error saying the branch was pushed and to rerun; push ok but create fails → error saying the branch was pushed and to rerun; fetch failure (origin removed) refused; dirty tree refused; not a fix branch refused; `guard-blocked test command refuses` (`testCommand: "git push origin main"` → refusal with `livespec guard:`).
- [ ] **Step 4:** Run; FAIL. Implement `fix-ship.ts` as small functions: `fixRefusal` (branch/child/read-only/dirty), `fixRange` (merge base + subjects, empty → refuse), `laneDecision` (facts + `decide("lane", facts, { config: pack.decisions.lane, subject: slug })`), `runTests` (`verifyEnv` + `runVerify` with `tailBytes: 4096`; `{ blocked }` → refusal with the guard reason; `exit !== 0` or `null` → refusal), `pullRequestTarget` (open PRs with head: any foreign author or >1 → refuse; 1 own → update; 0 → create), `publish` (`guardedPush` then create or `updatePullRequest` with the read version); the whole body inside `withEvidenceLock`. Subjects from `Git.subjects(M, "HEAD")`.
- [ ] **Step 5:** Run `bunx vitest run tests/tools/fix-ship.test.ts tests/guard/push-callers.test.ts tests/fix`; PASS. `bun run typecheck`.
- [ ] **Step 6:** Commit `feat(small-fix-lane): fix_ship`.

---

## Task 5: Move a fix into a change — implements 5

**Covers:** 5.1, 5.2
**Difficulty:** Normal
**Blocked by:** Task 2, Task 4

Task 4 is an added dependency: the Done-when test in 5.2 calls `fix_ship` first.

**Files:**
- Modify: `src/tools/change-new.ts`
- Test: `tests/tools/change-new.test.ts`

**Interfaces:**
- Consumes: `fixSlug`, `fixMergeBase`, `Git.subjects`, `CHANGE_BODY_TEMPLATE`, `setHeaderLine`, `livespecBaseKey` (from `change-start.ts`), `Git.renameBranch`, `Git.configSet`, `Forge.listPullRequests`.
- Produces: `change_new` `from_fix` parameter.

- [ ] **Step 1:** Tests: `Forced fix keeps its commits` (fix branch with 2 commits, one adding a requirement; `fix_ship` refuses; `change_new { name: "retry-budget", from_fix: true }` → issue in `livespec:phase/define`, body `Branch: livespec/retry-budget` and `Base` = merge base, Proposal lists both subjects; current branch `livespec/retry-budget` with the same HEAD; `fix/retry` gone; `branch.livespec/retry-budget.livespecBase` = merge base; `buildCardInput` resolves `kind: "change"` with phase `define`); `Open fix pull request` (seeded open PR from `fix/retry` → refusal names `#<n>`, no issue); `Not on a fix branch` (on `main` → refusal, no issue); `From a fix` (change-tools scenario: label `define`, branch renamed); existing `livespec/retry-budget` → refusal; fetch failure → refusal, no issue; `Create change` still creates no branch.
- [ ] **Step 2:** Run; FAIL. Implement `runChangeNewFromFix` beside `runChangeNew` (dispatch on `from_fix`) as `fromFixRefusal` (refusals in spec order; unknown integration branch included), `createMovedIssue` (template, `setHeaderLine` for `Branch`/`Base`, `replaceSection(body, "Proposal", …)` with the subjects, labels) and `moveBranch` (rename, config set); on a rename or config failure return an error naming `#<n>` and the exact `git branch -m fix/<slug> livespec/<name>` / `git config` step. Add `from_fix` to the JSON schema with a description.
- [ ] **Step 3:** Run; PASS. `bun run typecheck`.
- [ ] **Step 4:** Commit `feat(small-fix-lane): change_new --from-fix`.

---

## Task 6: Fix card — implements 6

**Covers:** 6.1, 6.2, 6.3
**Difficulty:** Normal
**Blocked by:** Task 2

**Files:**
- Modify: `src/hooks/card-input.ts`, `src/hooks/phase-card.ts`, `src/hooks/session.ts` (memo slot), `src/tools/guard.ts`, `src/tools/read-change.ts`, `src/tools/spec-next.ts`, `src/tools/spec-status.ts`, `src/commands/next.ts`, `src/tools/format-step.ts`
- Test: `tests/hooks/card-input.test.ts`, `tests/hooks/phase-card.test.ts`, `tests/hooks/session.test.ts`, `tests/tools/spec-status.test.ts`

**Interfaces:**
- Consumes: `fixSlug`, `fixMergeBase`, `laneFacts`, `laneRule`, the pack's `decisions.lane`.
- Produces: `FixCard`, `CardInput` fix kind, `fixCard`, `fixNextStep`, `CurrentChange` fix kind.

- [ ] **Step 1:** Tests: `Small fix card` (card text contains `fix/typo`, `small`, `Next: fix_ship`); `Forced fix card` (`Next:` names `change_new <name> --from-fix` and the reason line); `Empty fix card` (no commit after the merge base → next step says nothing to ship, no `fix_ship`); `No dispatch` (card text contains neither `subagent_dispatch` nor `subagent_packet`); facts failure (no `origin`) → card states the error and names no subagent; `Fix branch` (session start on `fix/typo` with two open changes → the fix card, no change list); `Next on a fix branch` (`spec_next` on `fix/typo` → `fix_ship`, equal to the card's next line; `/livespec next` the same); `refresh twice fetches once` (two refreshes at the same HEAD → one recorded `fetch` in `gitCalls`); `requireChange` on a fix branch refuses with the fix sentence.
- [ ] **Step 2:** Run; FAIL. Implement `fixCard` (memo by HEAD + integration on the session; merge base, subjects empty → `empty`, else facts + `laneRule` with the pack's `decisions.lane`; errors into `error`, never recorded). In `buildCardInput`, after the pack check and before `resolve`, return `{ ...common, kind: "fix", ...fix }` when `fixSlug(branch)` is defined. Add the `fix` case to `currentChange` and `requireChange` in `src/tools/guard.ts`. Add `case "fix"` to `phase-card.ts` (header, outcome, reasons list, one `Next:` line from a shared `fixNextStep(input): string`). `spec_next`, `spec_status` and `/livespec next` format the fix kind with `fixNextStep`.
- [ ] **Step 3:** Run; PASS. `bun run typecheck`.
- [ ] **Step 4:** Commit `feat(small-fix-lane): fix card`.

---

## Task 7: Bare work — implements 7

**Covers:** 7.1, 7.2, 7.3
**Difficulty:** Normal
**Blocked by:** Task 1, Task 2

**Files:**
- Create: `src/guard/bare-work.ts`
- Modify: `src/hooks/guard.ts`
- Test: `tests/guard/bare-work.test.ts`, `tests/hooks/guard.test.ts`

**Interfaces:**
- Consumes: `Git.isTracked`, `Git.branch`, `parseBareWork`, `isLivespecPath`, `fixSlug` (Task 2).
- Produces: `isBareWork`, `appendBareWork`.

- [ ] **Step 1:** Unit tests: `isBareWork` returns `src/app.ts` on `main` for a tracked file; a rejecting `tracked` makes `isBareWork` reject; undefined on `fix/typo`, `livespec/rate-limit`, for `specs/product.md`, for an untracked file, and for `path outside the project is not logged`; `appendBareWork` creates the file with exactly `2026-11-22 — src/app.ts — edit outside a change or fix branch\n`, skips a second call for the same path and date, appends for a new date, and `parallel edits log once` (two concurrent calls → one line); a read-only `specs/` directory → `{ written: false, error }` and no throw.
- [ ] **Step 2:** Run; FAIL. Implement with `parseBareWork` read, `appendFile`, and a module-level promise chain; ensure a trailing newline before appending to a file that lacks one.
- [ ] **Step 3:** Hook tests in `tests/hooks/guard.test.ts`, with `vi.setSystemTime(new Date(2026, 10, 22, 23, 30))` so the local date is `2026-11-22`: `Edit on main is logged` (call allowed, the `tool_result` for that `toolCallId` has an appended text starting with `livespec guard:`); `Logged once per day`; `Not bare work` (no warning, file unchanged); `Log failure allows the edit` (call allowed, warning says the work was not logged); child session → nothing logged and no warning; a tracked-check error → call allowed with a not-logged warning; a blocked-later call leaves no map entry after `tool_execution_end`.
- [ ] **Step 4:** Run; FAIL. Make `checkPath` async with `(session, input, cwd, toolName, toolCallId, isChild)`. After the livespec-files block, when initialized and not a child, run the bare-work branch in its own `try` (`isBareWork`, then `appendBareWork(root, rel, toolName, localDate(new Date()))`; any error → a not-logged warning, never a block) and keep the warning in a `Map<toolCallId, string>`. Register a `tool_result` handler that removes the entry and returns `{ content: [...event.content, { type: "text", text: warning }] }`, and a `tool_execution_end` handler that deletes any remaining entry.
- [ ] **Step 5:** Run; PASS. `bun run typecheck`.
- [ ] **Step 6:** Commit `feat(small-fix-lane): log bare work from the guard`.

---

## Task 8: Docs and end-to-end check — implements 8

**Covers:** 8.1, 8.2
**Difficulty:** Easy
**Blocked by:** Task 3, Task 4, Task 5, Task 6, Task 7

**Files:**
- Modify: `docs/architecture.md`, `src/guard/push.ts` (comment only)

- [ ] **Step 1:** Update the header comment of `src/guard/push.ts` to list `fix_ship`. Extend the small-fix lane paragraph in `docs/architecture.md`: `fix_start`, the `lane` rule and its default limits, `fix_ship` with `testCommand` and the decision block, `behavior_change: declared-none`, `change_new --from-fix`, the fix card, and bare work with the `bash` limit.
- [ ] **Step 2:** Run `bun run typecheck` and `bun run test`; expect 0 errors and all tests passing.
- [ ] **Step 3:** Commit `docs(small-fix-lane): architecture`.

---

## Scenario → test

- small-fix-lane / Hand-made fix branch → `tests/fix/branch.test.ts` "Hand-made fix branch"
- small-fix-lane / Not a fix branch → `tests/fix/branch.test.ts` "Not a fix branch"
- small-fix-lane / Start a fix → `tests/tools/fix-start.test.ts` "Start a fix"
- small-fix-lane / Dirty tree → `tests/tools/fix-start.test.ts` "Dirty tree"
- small-fix-lane / From a change branch → `tests/tools/fix-start.test.ts` "From a change branch"
- small-fix-lane / Small fix → `tests/fix/lane.test.ts` + `tests/fix/lane-facts.test.ts` "Small fix"
- small-fix-lane / Added requirement forces → `tests/fix/lane.test.ts` + `tests/fix/lane-facts.test.ts` "Added requirement forces"
- small-fix-lane / Removed scenario forces → `tests/fix/lane.test.ts` "Removed scenario forces"
- small-fix-lane / Too many files → `tests/fix/lane.test.ts` "Too many files"
- small-fix-lane / Too many lines → `tests/fix/lane.test.ts` "Too many lines"
- small-fix-lane / New capability → `tests/fix/lane.test.ts` + `tests/fix/lane-facts.test.ts` "New capability"
- small-fix-lane / Governance files → `tests/fix/lane.test.ts` "Governance files"
- small-fix-lane / Project override → `tests/engine/pack-load.test.ts` "Project override"
- small-fix-lane / Invalid limit → `tests/fix/lane.test.ts` "Invalid limit"
- small-fix-lane / Code without spec change → `tests/fix/lane.test.ts` "Code without spec change"
- small-fix-lane / Code with spec change → `tests/fix/lane.test.ts` "Code with spec change"
- small-fix-lane / Ship a small fix → `tests/tools/fix-ship.test.ts` "Ship a small fix"
- small-fix-lane / Forced fix refused → `tests/tools/fix-ship.test.ts` "Forced fix refused"
- small-fix-lane / Failing tests → `tests/tools/fix-ship.test.ts` "Failing tests"
- small-fix-lane / No test command → `tests/tools/fix-ship.test.ts` "No test command"
- small-fix-lane / Nothing to ship → `tests/tools/fix-ship.test.ts` "Nothing to ship"
- small-fix-lane / Foreign pull request → `tests/tools/fix-ship.test.ts` "Foreign pull request"
- small-fix-lane / Rerun updates the pull request → `tests/tools/fix-ship.test.ts` "Rerun updates the pull request"
- small-fix-lane / Body round trip → `tests/fix/pr-body.test.ts` "Body round trip"
- small-fix-lane / Declared none in the block → `tests/fix/pr-body.test.ts` "Declared none in the block"
- small-fix-lane / No closing keyword → `tests/fix/pr-body.test.ts` "No closing keyword"
- small-fix-lane / Small fix card → `tests/hooks/phase-card.test.ts` "Small fix card"
- small-fix-lane / Forced fix card → `tests/hooks/phase-card.test.ts` "Forced fix card"
- small-fix-lane / Empty fix card → `tests/hooks/phase-card.test.ts` "Empty fix card"
- small-fix-lane / No dispatch → `tests/hooks/phase-card.test.ts` "No dispatch"
- subagent-policy / Small-fix lane (living, deferred from LS-07) → `tests/hooks/phase-card.test.ts` "No dispatch"
- small-fix-lane / Forced fix keeps its commits → `tests/tools/change-new.test.ts` "Forced fix keeps its commits"
- small-fix-lane / Open fix pull request → `tests/tools/change-new.test.ts` "Open fix pull request"
- small-fix-lane / Not on a fix branch → `tests/tools/change-new.test.ts` "Not on a fix branch"
- command-guards / Edit on main is logged → `tests/hooks/guard.test.ts` "Edit on main is logged"
- command-guards / Logged once per day → `tests/hooks/guard.test.ts` + `tests/guard/bare-work.test.ts` "Logged once per day"
- command-guards / Not bare work → `tests/hooks/guard.test.ts` "Not bare work"
- command-guards / Log failure allows the edit → `tests/hooks/guard.test.ts` "Log failure allows the edit"
- command-guards / No tool calls the push path → `tests/guard/push-callers.test.ts` "Only change_ship, change_push and fix_ship call the push path"
- command-guards / Refspec from the issue → existing `tests/tools/change-ship.test.ts` refspec test (unchanged)
- command-guards / Refspec from the fix branch → `tests/guard/push-callers.test.ts` "Refspec from the fix branch"
- change-tools / Status mid-change, Next command matches tool, No change → existing status/next tool tests (unchanged)
- change-tools / Next on a fix branch → `tests/tools/spec-status.test.ts` "Next on a fix branch"
- change-tools / Create change → `tests/tools/change-new.test.ts` "Create change" (unchanged)
- change-tools / Duplicate name → `tests/tools/change-new.test.ts` "Duplicate name" (unchanged)
- change-tools / From a fix → `tests/tools/change-new.test.ts` "From a fix"
- init-and-doctor / Test command → `tests/config.test.ts` "Test command"
- init-and-doctor / Invalid test command → `tests/config.test.ts` "Invalid test command"
- init-and-doctor / other `Config files` scenarios → existing `tests/config.test.ts` (unchanged)
- context-injection / Fix branch → `tests/hooks/session.test.ts` "Fix branch"
- context-injection / Resume mid-change, Other branch, Product pointer, Forge unavailable, Child session start → existing `tests/hooks/session.test.ts` (unchanged)
- decision-seam / Jev rejected → existing `tests/decide/registry.test.ts` (unchanged)
- decision-seam / Unknown point → `tests/decide/registry.test.ts` "Unknown point" (now `nope`)
- decision-seam / Record fields, Large facts hashed, Proposal record is not current → existing tests (unchanged)
- decision-seam / Lane decision in the pull request only → `tests/tools/fix-ship.test.ts` "Lane decision in the pull request only"
- flow-pack / Default pack loads, Default pack contents, Spot check → existing pack tests in `tests/engine/` with the updated fixture and Spot check assertion
