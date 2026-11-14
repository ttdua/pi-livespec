# spec-core Implementation Plan

> Executed via `/opsx-apply`, which chooses the executor.
> Spec reference: this change's `specs/` and `design.md`.

**Goal:** Ship the pure format core (parse, serialize, validate, digest, tick, glob, diff check) plus `/livespec validate` and `/livespec migrate-openspec`.

**Architecture:** Raw-line model (`src/core/lines.ts`) underlies every parser; structured views index into the lines, so unchanged documents serialize byte-exact. Core is I/O-free; `src/commands/` reads files and runs git and feeds text to the core; `src/extension.ts` dispatches subcommands.

**Tech Stack:** TypeScript (NodeNext, `.ts` imports), vitest, `yaml`, `node:crypto`, `node:child_process`. No new dependency.

**Global constraints:** only `yaml` as runtime dependency; run tests with `bun run test`, typecheck with `bun run typecheck`; tabs for indentation (match existing files); test names equal scenario names.

**Review focus:** CRLF documents; empty documents; a unit block as last thing in the file without trailing newline; unit ids ≥ 10 (`U10` vs `U1`); spec text containing `SHALL` only inside a scenario.

---

## Contracts

| Name | new / modified | Shape | public |
|---|---|---|---|
| `Line` / `Doc` | new | `type Line = { text: string; eol: "\n" \| "\r\n" \| "" }`; `splitLines(s): Line[]`; `joinLines(l: Line[]): string` | no |
| `Result` | new | `{ code: string; severity: "error" \| "warning"; file?: string; section?: string; line?: number; message: string }` | yes |
| `Frontmatter` | new | `parseFrontmatter(text): { data: Record<string, unknown>; body: Line[]; raw: Line[] }` (raw empty when absent) | no |
| `matchGlob` / `validateGlob` | new | `matchGlob(pattern: string, path: string): boolean`; `validateGlob(pattern: string): string \| null` (error message or null) | yes |
| `Spec` | new | `parseSpec(text, capability): Spec`; `serializeSpec(s): string`; `Spec = { capability; paths: string[]; purpose: string; requirements: Requirement[]; lines: Line[] }`; `Requirement = { name; text; line: number; scenarios: Scenario[] }`; `Scenario = { name; line; given: string[]; when: string[]; then: string[] }` | yes |
| `Decision` | new | `parseDecision(file, text): Decision`; `Decision = { file: string; number: number; slug: string; status: "accepted" \| "superseded"; statusRaw: string; supersededBy?: number; spine: boolean; capabilities: string[]; lines: Line[] }` (`file` = name given to `parseDecision`, used as result file; `statusRaw` = raw front matter status, `""` when absent; both added in review fix to report invalid statuses and real file names); `serializeDecision` | yes |
| `Glossary` | new | `parseGlossary(text): { entries: { term; definition; line }[]; lines: Line[] }`; `serializeGlossary` | yes |
| `BareWork` | new | `parseBareWork(text): { entries: { date; files: string[]; summary; line }[]; lines }`; `serializeBareWork` | yes |
| `Change` | new | `parseChange(text): Change`; `serializeChange(c): string`; `Change = { header: {base?; branch?; initiative?; depends?; capabilities?: {new: string[]; modified: string[]}; productImpact?; pr?}; questions: Question[]; units: Unit[]; durableDocs: {file; status}[]; lines: Line[] }` | yes |
| `Question` | new | `{ id; kind: "blocking" \| "non-blocking"; text; checked: boolean; answer?: string; line }` | yes |
| `Unit` | new | `{ id: string; title; covers: string[]; difficulty?: string; tags?: string[]; files: string[]; doneMeans: {label; text}[]; scenarios: {label; ref}[]; depends: string[]; verify?: string; kind?: "refactor"; done: boolean; statusLine: number; startLine: number; endLine: number; raw: Record<string, string[]> }` (missing fields stay undefined/empty for the validator) | yes |
| `Initiative` | new | `parseInitiative(text)`: `{ goal; capabilities: string[]; changes: {checked; number; name; depends: number[]; line}[]; lines }`; `serializeInitiative` | yes |
| `unitDigest` | new | `unitDigest(u: Unit): string` (hex sha256) | yes |
| tick API | new | `tickUnit(body, id)`, `untickUnit(body, id)`, `tickChange(body, n)`, `untickChange(body, n)`: `string` result or throws `TickError` | yes |
| validators | new | `validateSpec(s: Spec, file): Result[]`; `validateGlossary(g, file): Result[]`; `validateDecisions(ds: Decision[]): Result[]`; `validateDecisionDiff(diff: string): Result[]`; `validateUnits(c: Change): Result[]` (`units-format`); `checkDoneMapsScenarios(c): Result[]`; `capabilitiesMatchDiff(c: Change, diff: string): Result[]` | yes |
| `runValidate` | new | `runValidate(root: string): Promise<Result[]>`; `formatResults(r: Result[]): string`; `hasErrors(r): boolean` | no |
| `spec_validate` tool | new | name `spec_validate`; parameters `{ type: "object", properties: {} }`; returns text from `formatResults` and `details: { results: Result[] }` | yes |
| `/livespec` subcommands | modified | `/livespec` (version) · `/livespec validate` · `/livespec migrate-openspec` · other → usage text | yes |
| `runMigrate` | new | `runMigrate(root: string): Promise<{ moved: string[]; conflicts: string[] }>` | no |

---

## Task 1: Line model, front matter and glob — implements 1

**Covers:** 1.1, 1.2, 1.3
**Difficulty:** Normal
**Blocked by:** none
**Files:** create `src/core/lines.ts`, `src/core/frontmatter.ts`, `src/core/glob.ts`, `tests/core/lines.test.ts`, `tests/core/glob.test.ts`

- [ ] **Step 1:** Write failing tests: `joinLines(splitLines(s)) === s` for LF, CRLF, mixed, empty, no trailing newline; glob table (`**`, `*`, `?`, `{a,b}`, `[ab]`, invalid `src/{a,b`).
- [ ] **Step 2:** Run `bun run test tests/core` and see failures.
- [ ] **Step 3:** Implement `lines.ts`, `frontmatter.ts` (leading `---` … `---`, parse with `yaml`), `glob.ts` (translate to RegExp; `validateGlob` checks balanced `{}`/`[]`).
- [ ] **Step 4:** Run tests and `bun run typecheck`; commit `feat(core): line model, front matter, glob`.

---

## Task 2: Durable file formats — implements 2

**Covers:** 2.1, 2.2, 2.3
**Difficulty:** Normal
**Blocked by:** Task 1
**Files:** create `src/core/spec.ts`, `src/core/decision.ts`, `src/core/glossary.ts`, `src/core/bare-work.ts`, `tests/core/spec.test.ts`, `tests/core/decision.test.ts`, `tests/core/glossary.test.ts`, `tests/core/bare-work.test.ts`, `tests/fixtures/rate-limit.spec.md`

- [ ] **Step 1:** Add the brief's `rate-limit` spec as a fixture; write failing tests for round trip (LF, CRLF, unknown `## Notes`), requirement/scenario extraction, `paths`, decision fields, glossary entries, bare-work entries, free-text pass-through.
- [ ] **Step 2:** Implement `parseSpec`/`serializeSpec` (requirements under `## Requirements`, `### Requirement:`, `#### Scenario:`, `**WHEN**`/`**THEN**` bullets).
- [ ] **Step 3:** Implement decision (number/slug from file name, front matter), glossary (`- **Term**: def`), bare-work (`date — files — summary` per line; the exact separator is ` — `, recorded in a code comment).
- [ ] **Step 4:** Run tests, typecheck; commit `feat(core): durable file parsers`.

---

## Task 3: Change and initiative bodies, digest, tick — implements 3

**Covers:** 3.1, 3.2, 3.3, 3.4, 3.5
**Difficulty:** Hard
**Blocked by:** Task 1
**Files:** create `src/core/change.ts`, `src/core/initiative.ts`, `src/core/digest.ts`, `src/core/tick.ts`, `tests/core/change.test.ts`, `tests/core/initiative.test.ts`, `tests/core/digest.test.ts`, `tests/core/tick.test.ts`, `tests/fixtures/change-body.md`, `tests/fixtures/initiative-body.md`

- [ ] **Step 1:** Add the brief's example change and initiative bodies as fixtures (change body extended with a U1 unit); write failing tests for round trip, ownership lines, `Capabilities: new [], modified [rate-limit]`, questions, unit fields, `Depends: —`, `Kind: refactor`, initiative entries.
- [ ] **Step 2:** Implement `parseChange`/`serializeChange` (units split on `### U<n> — `; field lines by prefix; `Done means`/`Scenarios` collect following `- [label]` lines; status line is the last `- [ ] pending` / `- [x] done` line of the block).
- [ ] **Step 3:** Implement `parseInitiative`/`serializeInitiative`.
- [ ] **Step 4:** Write failing digest tests (stable, Difficulty/Tags/status excluded, contract change alters, CRLF/trailing-space equal); implement `unitDigest` per design (canonical order Covers, Files, Done means, Scenarios, Depends, Verify, Kind).
- [ ] **Step 5:** Write failing tick tests (one-line diff, already done → `TickError`, unknown id, untick restores bytes, `U10` vs `U1`, `tickChange`/missing); implement by splicing one line.
- [ ] **Step 6:** Run tests, typecheck; commit `feat(core): change/initiative bodies, digest, tick`.

---

## Task 4: Validators — implements 4

**Covers:** 4.1, 4.2, 4.3, 4.4, 4.5
**Difficulty:** Hard
**Blocked by:** Task 2, Task 3
**Files:** create `src/core/result.ts`, `src/core/validate-spec.ts`, `src/core/validate-decisions.ts`, `src/core/validate-units.ts`, `src/core/capabilities-diff.ts`, `tests/core/validate-spec.test.ts`, `tests/core/validate-decisions.test.ts`, `tests/core/validate-units.test.ts`, `tests/core/capabilities-diff.test.ts`

- [ ] **Step 1:** Write failing tests per scenario in `spec-validation` (see mapping below).
- [ ] **Step 2:** Implement `result.ts` and `validate-spec.ts` (codes `spec-normative`, `spec-scenario-missing`, `spec-when-then`, `spec-duplicate-requirement`, `spec-paths-glob`, `glossary-order`, `glossary-duplicate`).
- [ ] **Step 3:** Implement `validate-decisions.ts` (`decision-number`, `decision-superseded`, `decision-deleted`; diff deletion read from `deleted file mode` or `--- a/specs/decisions/...` with `+++ /dev/null`).
- [ ] **Step 4:** Implement `validate-units.ts` (`units-format`, `done-maps-scenarios`).
- [ ] **Step 5:** Implement `capabilities-diff.ts` (parse `diff --git` + `new file mode`; ignore top-level `specs/*.md` and `specs/decisions/`; no `Base` → warning `change-not-started`).
- [ ] **Step 6:** Run tests, typecheck; commit `feat(core): validators`.

---

## Task 5: Validate command, tool and dispatch — implements 5

**Covers:** 5.1, 5.2, 5.3, 5.4
**Difficulty:** Normal
**Blocked by:** Task 4
**Files:** create `src/commands/validate.ts`, `src/tools/spec-validate.ts`, `tests/commands/validate.test.ts`, `tests/helpers/repo.ts`; modify `src/extension.ts`, `tests/extension.test.ts`

- [ ] **Step 1:** Write a temp-repo helper (`mkdtemp`, `git init`) and failing tests: clean repo, error repo, missing `specs/`, tool results equal command results, bare `/livespec`, unknown subcommand usage.
- [ ] **Step 2:** Implement `runValidate` (walk `specs/`: `<cap>/spec.md`, `glossary.md`, `decisions/*.md`; skip free-text files), `formatResults`, `hasErrors`.
- [ ] **Step 3:** Implement the `spec_validate` tool via `pi.registerTool`, and subcommand dispatch (`validate` sends a message with `formatResults` and notifies an error level when `hasErrors`; unknown → usage).
- [ ] **Step 4:** Run tests, typecheck; commit `feat: /livespec validate and spec_validate`.

---

## Task 6: Migrate command — implements 6

**Covers:** 6.1, 6.2, 6.3
**Difficulty:** Normal
**Blocked by:** Task 5
**Files:** create `src/commands/migrate.ts`, `tests/commands/migrate.test.ts`; modify `src/extension.ts`

- [ ] **Step 1:** Write failing tests on temp git repos: moved with identical bytes and rename status, only `spec.md` files moved (`notes.md`, `README.md`, `config.yaml`, `changes/` untouched), folders without `spec.md` ignored, conflict refuses everything, nothing to migrate.
- [ ] **Step 2:** Implement `runMigrate` (collect only `openspec/specs/*/spec.md`, never other files; if any target exists return conflicts and touch nothing; else `mkdir -p` and `git mv`) and wire `migrate-openspec` in dispatch.
- [ ] **Step 3:** Run tests, typecheck; commit `feat: /livespec migrate-openspec`.
- [ ] **Step 4:** Copy only the `spec.md` files from `~/Projects/oss/pi-superspec/openspec/specs/*/` (not the whole tree) into a scratch git repo, run migrate then validate; record errors and warnings for the verify record (report, do not relax rules).

---

## Task 7: Align spec checks with OpenSpec severities — implements 7

**Covers:** 7.1, 7.2, 7.3
**Difficulty:** Normal
**Blocked by:** Task 4, Task 5
**Files:** modify `src/core/spec.ts`, `src/core/validate-spec.ts`, `tests/core/spec.test.ts`, `tests/core/validate-spec.test.ts`, `tests/commands/validate.test.ts`, `tests/extension.test.ts` if affected

- [ ] **Step 1:** Write failing tests: GIVEN parsed into `given`; `spec-normative` and `spec-when-then` are `warning`; GIVEN+THEN gives no result; THEN-only gives a warning; spec with zero requirements gives error `spec-no-requirements`.
- [ ] **Step 2:** Implement the parser and validator changes; severity helper `warning(...)` next to `error(...)`.
- [ ] **Step 3:** Fix affected command tests (warnings alone give exit code 0).
- [ ] **Step 4:** Run tests and typecheck; commit `fix(core): align spec check severities with OpenSpec`.

---

## Scenario → test

package-scaffold:
- Command prints the version → `tests/extension.test.ts › prints the package version`
- Command has no side effects → `tests/extension.test.ts › bare command has no side effects`
- Unknown subcommand → `tests/extension.test.ts › unknown subcommand prints usage`

spec-formats (`tests/core/spec.test.ts` unless noted):
- Living spec round trip → `spec › living spec round trip`
- Unknown section preserved → `spec › unknown section preserved`
- CRLF preserved → `spec › CRLF preserved`
- Requirements and scenarios extracted → `spec › requirements and scenarios extracted`
- Paths read from front matter → `spec › paths read from front matter`
- No front matter → `spec › no front matter`
- Superseded decision → `decision.test › superseded decision`
- Optional fields absent → `decision.test › optional fields absent`
- Entries parsed in order → `glossary.test › entries parsed in order`
- Other lines preserved → `glossary.test › other lines preserved`
- Line parsed → `bare-work.test › line parsed`
- Free text passes through → `validate.test › free text passes through`
- Double star spans directories → `glob.test › double star spans directories`
- Single star stays in one segment → `glob.test › single star stays in one segment`
- Invalid glob detected → `glob.test › invalid glob detected`

change-issue-format:
- Example body round trip → `change.test › example body round trip`
- Optional ownership lines → `change.test › optional ownership lines`
- Capabilities line → `change.test › capabilities line`
- Unknown section kept → `change.test › unknown section kept`
- Open and answered questions → `change.test › open and answered questions`
- Example unit fields → `change.test › example unit fields`
- Depends dash → `change.test › depends dash`
- Kind refactor → `change.test › kind refactor`
- Example initiative round trip → `initiative.test › example initiative round trip`
- Change entries → `initiative.test › change entries`
- Digest stable under reserialization → `digest.test › stable under reserialization`
- Difficulty and Tags excluded → `digest.test › difficulty and tags excluded`
- Status excluded → `digest.test › status excluded`
- Contract change alters digest → `digest.test › contract change alters digest`
- Whitespace normalization → `digest.test › whitespace normalization`
- Tick changes one line → `tick.test › tick changes one line`
- Tick an already done unit → `tick.test › tick an already done unit`
- Unknown unit → `tick.test › unknown unit`
- Untick restores bytes → `tick.test › untick restores bytes`
- Tick one change line → `tick.test › tick one change line`
- Missing change → `tick.test › missing change`

spec-validation:
- Result shape → `validate-spec.test › result shape`
- Missing normative word → `validate-spec.test › missing normative word` (warning)
- Scenario missing trigger → `validate-spec.test › scenario missing trigger`
- GIVEN accepted as trigger → `validate-spec.test › given accepted as trigger`
- Spec without requirements → `validate-spec.test › spec without requirements`
- Requirement without scenario → `validate-spec.test › requirement without scenario`
- Scenario missing THEN → `validate-spec.test › scenario missing THEN`
- Duplicate requirement name → `validate-spec.test › duplicate requirement name`
- Invalid paths glob → `validate-spec.test › invalid paths glob`
- Valid spec → `validate-spec.test › valid spec`
- Unsorted terms → `validate-spec.test › unsorted terms`
- Duplicate term → `validate-spec.test › duplicate term`
- Duplicate number → `validate-decisions.test › duplicate number`
- Superseded without pointer → `validate-decisions.test › superseded without pointer`
- Pointer to missing decision → `validate-decisions.test › pointer to missing decision`
- Decision deleted in diff → `validate-decisions.test › decision deleted in diff`
- Missing field → `validate-units.test › missing field`
- Bad difficulty → `validate-units.test › bad difficulty`
- Two Verify commands → `validate-units.test › two verify commands`
- Duplicate unit id → `validate-units.test › duplicate unit id`
- Depends on missing unit → `validate-units.test › depends on missing unit`
- Example units valid → `validate-units.test › example units valid`
- Done item without scenario → `validate-units.test › done item without scenario`
- Scenario without done item → `validate-units.test › scenario without done item`
- Labels match → `validate-units.test › labels match`
- Declared but untouched → `capabilities-diff.test › declared but untouched`
- Touched but undeclared → `capabilities-diff.test › touched but undeclared`
- New must be created → `capabilities-diff.test › new must be created`
- Consistent diff → `capabilities-diff.test › consistent diff`
- Not started → `capabilities-diff.test › not started`
- Clean repository → `commands/validate.test › clean repository`
- Error present → `commands/validate.test › error present`
- Tool returns results → `commands/validate.test › tool returns results`
- Missing specs folder → `commands/validate.test › missing specs folder`

openspec-migration:
- Specs moved → `migrate.test › specs moved`
- Only spec files are moved → `migrate.test › only spec files are moved`
- Directories without spec files → `migrate.test › directories without spec files`
- Target exists → `migrate.test › target exists`
- Nothing to migrate → `migrate.test › nothing to migrate`
- Migrate then validate → `migrate.test › migrate then validate` (fixture repo) plus the Task 6 Step 4 manual run on pi-superspec specs
