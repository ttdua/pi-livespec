# Verification Report

**Change**: `spec-core`
**Verified at**: `2026-11-14` (re-run after iteration 2)
**Iteration**: `2`
**Verifier**: `parent session (inline); evidence collected in this run, no verifier agent`

---

## 1. Structural Validation (`openspec validate spec-core`)

- [x] The command passes for this change

```text
$ openspec validate spec-core
Change 'spec-core' is valid        (exit 0)
```

---

## 2. Task Completion (`tasks.md`)

- [x] Every box is ticked

`openspec instructions apply` reports `{"total":26,"complete":26,"remaining":0}`; `grep -c '\- \[ \]' tasks.md` returns 0.

| Open task | Reason | Blocks archive? |
|---|---|---|
| none | — | — |

---

## 3. Requirement Evidence

- [x] ADDED / MODIFIED: implementation evidence (file / line)
- [x] REMOVED: not applicable (the change removes no requirement)
- [x] RENAMED: not applicable

| Requirement | Operation | Status | Evidence (file:line) |
|---|---|---|---|
| package-scaffold / Version command | MODIFIED | Pass | `src/extension.ts:7` (USAGE), `src/extension.ts:12-31` (dispatch: bare, `validate`, `migrate-openspec`, unknown) |
| spec-formats / Byte-exact round trip | ADDED | Pass | `src/core/lines.ts:4,20` (`splitLines`, `joinLines`); `src/core/spec.ts:104` (`serializeSpec`) |
| spec-formats / Living spec format | ADDED | Pass | `src/core/spec.ts:40` (`parseSpec`) |
| spec-formats / Decision record format | ADDED | Pass | `src/core/decision.ts:28` |
| spec-formats / Glossary format | ADDED | Pass | `src/core/glossary.ts:8` |
| spec-formats / Bare-work log format | ADDED | Pass | `src/core/bare-work.ts:14` |
| spec-formats / Free-text durable files | ADDED | Pass | `src/commands/validate.ts` (skips product, constraints and bare-work content checks); test `free text passes through` |
| spec-formats / Glob matching | ADDED | Pass | `src/core/glob.ts:6,12` |
| change-issue-format / Change issue body parsing | ADDED | Pass | `src/core/change.ts:219` |
| change-issue-format / Questions parsing | ADDED | Pass | `src/core/change.ts` (Questions section parser) |
| change-issue-format / Unit parsing | ADDED | Pass | `src/core/change.ts:12` (`Unit`), `:219` |
| change-issue-format / Initiative body parsing | ADDED | Pass | `src/core/initiative.ts:24` |
| change-issue-format / Unit digest | ADDED | Pass | `src/core/digest.ts:11` |
| change-issue-format / Tick and untick units | ADDED | Pass | `src/core/tick.ts:42,45` |
| change-issue-format / Tick and untick changes | ADDED | Pass | `src/core/tick.ts:48,51` |
| spec-validation / Validation result | ADDED | Pass | `src/core/result.ts:1-8` |
| spec-validation / Living spec checks | ADDED | Pass | `src/core/validate-spec.ts:13` (errors: scenario missing, duplicate name, paths glob, `spec-no-requirements` at `:24`; warnings: `spec-normative`, `spec-when-then`; GIVEN parsed in `src/core/spec.ts`) |
| spec-validation / Glossary checks | ADDED | Pass | `src/core/validate-spec.ts:42` |
| spec-validation / Decision checks | ADDED | Pass | `src/core/validate-decisions.ts:38,49` |
| spec-validation / Unit format check | ADDED | Pass | `src/core/validate-units.ts:69` |
| spec-validation / Done-maps-scenarios check | ADDED | Pass | `src/core/validate-units.ts:88` |
| spec-validation / Capabilities match diff | ADDED | Pass | `src/core/capabilities-diff.ts:34` |
| spec-validation / Validate command and tool | ADDED | Pass | `src/commands/validate.ts:98,114,118,144`; `src/tools/spec-validate.ts:5-10` |
| openspec-migration / Migrate OpenSpec specs | ADDED | Pass | `src/commands/migrate.ts:105` (`runMigrate`, `git mv`, only `openspec/specs/<cap>/spec.md`) |
| openspec-migration / Refuse on conflict | ADDED | Pass | `src/commands/migrate.ts` (preflight before any `mkdir` or `git mv`) |
| openspec-migration / Migrated specs validate | ADDED | Pass | test `migrate then validate`; step 6.3 run on 22 pi-superspec `spec.md` files (`/tmp/spec-core-6.3-output.txt`: `MOVED 22 CONFLICTS 0`, `[]`, `No validation results.`) |

---

## 4. Scenario Coverage

- [x] Every scenario maps to a test
- [x] The project test command was run fresh in this step

**Test command**: `bun run test` (vitest run), run in the worktree at `6cd1bf5`
**Result**: exit 0, 21 test files passed, 211 tests passed, 0 failed. `bun run typecheck` (`tsc --noEmit`): exit 0.

A script that compares each `#### Scenario:` name in the five delta specs with the `it(...)` names under `tests/` found 79 scenarios and 0 without a test. Spot checks:

| Scenario | Test |
|---|---|
| Missing field (spec-validation) | `tests/core/validate-units.test.ts:24` `missing field` (the script's first match was a parser test, so I checked this one by hand) |
| Specs moved, Only spec files are moved, Directories without spec files, Target exists, Migrate then validate | `tests/commands/migrate.test.ts` (same names) |
| Nothing to migrate | `tests/extension.test.ts` `migrate-openspec with nothing to migrate does not notify`, plus the `nothing to migrate` test in `migrate.test.ts` |
| Clean repository, Missing specs folder | `tests/extension.test.ts` `validate on a clean repository does not notify`, `validate reports missing specs folder` |
| Digest stable under reserialization | `tests/core/digest.test.ts` `stable under reserialization` |
| Command prints the version, Command has no side effects, Unknown subcommand | `tests/extension.test.ts` `prints the package version`, `bare command has no side effects`, `unknown subcommand prints usage and changes nothing` |
| All other scenarios | a test of the same name, per the plan's "Scenario → test" list, in `tests/core/*.test.ts` and `tests/commands/*.test.ts` |

---

## 5. Design and Contract Coherence (warning only)

- [x] Decisions in design.md match the code, with the drift listed below
- [x] Contracts in plan.md, with the Contract deviations recorded in apply.md, match the code

**Drift warnings** (non-blocking):

- **design.md "Diff input" says the command layer runs `git diff <Base>..HEAD -- specs/`.** `runValidate` does not call `capabilitiesMatchDiff`, `validateDecisionDiff`, `validateUnits` or `checkDoneMapsScenarios`. `Base` and the change body come from the forge (LS-03). The functions exist as pure core code with tests, but `/livespec validate` does not use them yet. The "Decision checks" scenario for a deleted decision is covered only at the function level.
- **design.md says `matchGlob` supports `[...]`.** `validateGlob("[[:alpha:]]")` returns null while `matchGlob` guesses a meaning. This conflicts with the design's "unsupported syntax is rejected, not guessed" (`src/core/glob.ts`, reported in the whole-branch review).
- **Contract `Decision`** now has `file` and `statusRaw`, which matches the recorded deviation in `apply.md` and the plan row.
- **Contract `Unit`** also has `statusText` (extra export, noted in `apply.md`).
- **Contract `runValidate`** is as planned (`src/commands/validate.ts:98`). `runValidateCommand` (`:144`) is an addition not in the plan, noted in `apply.md`.
- **Contract `spec_validate`**: `parameters` is `{ type: "object", properties: {} } as never` (`src/tools/spec-validate.ts:10`), as designed, with an explanatory comment.
- **Not verified**: the Contracts rows `Line / Doc`, `Frontmatter`, `Glossary`, `BareWork` and `Initiative` were checked by signature only (`src/core/lines.ts:2-20`, `frontmatter.ts:9`, `glossary.ts:8`, `bare-work.ts:14`, `initiative.ts:24`). I did not compare their field names one by one.

---

## 6. Clean Tree and Commit Range

- [x] Working tree is clean (`git status --porcelain` printed nothing)

**Commit range**: `e44ed8e..6cd1bf5`

---

## Iteration 2 note

This re-run follows the user-approved alignment of spec check severities with OpenSpec (`1d2250f`). The earlier warning about the strictness of SHALL/MUST and WHEN/THEN no longer applies. Migrate then validate on the 22 pi-superspec `spec.md` files: 0 errors, 0 warnings (re-run in iteration 2). The other warnings and suggestions below stand.

---

## Overall Decision

- [ ] PASS
- [x] PASS_WITH_WARNINGS: no CRITICAL issue, fresh tests green. The warnings are the design drift above and one check recorded as not verified (field-by-field comparison of five Contracts rows).
- [ ] FAIL

### Issues

**CRITICAL**: none.

**WARNING**
1. `/livespec validate` does not run the diff-based or change-body checks (`src/commands/validate.ts:98-112`). Recommendation: state in `design.md` that wiring belongs to LS-03 and LS-04, or add `git diff HEAD -- specs/decisions/` to `runValidate` so uncommitted decision deletions are caught now.
2. POSIX classes in globs are guessed, not rejected (`src/core/glob.ts:79-88`). Recommendation: make `validateGlob` return an error when `[:` appears inside a class.

**SUGGESTION**
1. Line numbering is mixed: 1-based in `Requirement.line`, `Scenario.line`, `GlossaryEntry.line` and `BareWorkEntry.line`; 0-based in `Question.line`, `InitiativeChange.line` and `Unit.startLine/statusLine/endLine`. Recommendation: rename the 0-based fields to `lineIndex` or document the base in the types before LS-04 uses them.
2. Scalar `paths:` in front matter and a malformed `Capabilities:` line are ignored silently (`src/core/spec.ts:42`, `src/core/change.ts:97-98`). Recommendation: report them in the validators.
3. `capabilitiesMatchDiff` counts some in-capability renames and added files as "created" (`src/core/capabilities-diff.ts:24`).
4. `parseSpec` is about 60 lines with four state variables (`src/core/spec.ts:40-102`). Recommendation: split it into helper functions.
5. A spec with no requirements passes validation silently.

**Next step**: run `/opsx-continue` with the worktree as working directory to create the finalize artifact, then `/opsx-archive`.
