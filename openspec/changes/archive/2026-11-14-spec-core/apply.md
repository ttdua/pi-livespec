# Apply Receipt

**Change**: `spec-core`
**Iteration**: `2`
**Applied at**: `2026-11-14` (post-PR iteration 2; iteration 1 on 2026-11-14)
**Executor**: `subagent-driven-development` (implementer and code-reviewer agents, sequential; one combined spec and quality review per task plus a whole-branch review)

---

## Workspace

- **Worktree path**: `/Users/naicoi/Projects/oss/pi-livespec.spec-core`
- **Worktree branch**: `spec-core`
- **Feature branch**: `spec-core` (the worktree already existed on this branch; no separate feature branch was checked out before apply)
- **Base branch**: `main`

---

## Commits

- **Range**: `e44ed8e..1d2250f` (iteration 2 adds `1d2250f` and the artifact commit before it, on top of `990a1f5` and the finalize commits)
- **Count**: see `git log e44ed8e..1d2250f`

---

## Tasks

- **Completed**: `26 of 26` checkboxes in tasks.md flipped to `- [x]`
- **Remaining**: none

---

## Contract deviations

- `Scenario`: added `given: string[]` (iteration 2). Reason: GIVEN is accepted as a trigger to match OpenSpec. Additive.
- `Decision`: added `file: string` and `statusRaw: string` (additive, recorded in the plan.md row). Reason: the whole-branch review found invalid decision statuses coerced to `accepted` and wrong file names in results. Consumers that only read the existing fields are unaffected. The `Decision` contract is marked `public`; the change is additive.
- Other exports beyond the plan (not deviations): `Unit.statusText`, `runMigrate(root, { exec })`, `runValidateCommand`, `formatMigrate`, `MigrateError`, `parseGitDiff`, `TickError`.

---

## Lanes

| Task | Lane branch | Lane range | Review | Merge commit |
|---|---|---|---|---|
| Task 1 | sequential | `e44ed8e..8daec61` | approved after fix (glob char classes) | n/a |
| Task 2 | sequential | `8daec61..dabd016` | approved after fix (fenced blocks) | n/a |
| Task 3 | sequential | `dabd016..a9d104f` | approved after fix (strict tick, verbatim fixture) | n/a |
| Task 4 | sequential | `a9d104f..52f4df0` | approved after fix (diff parsing, renames, units grammar) | n/a |
| Task 5 | sequential | `52f4df0..9887f4d` | approved after fix (error boundaries, exit status) | n/a |
| Task 6 | sequential | `9887f4d..1041af8` | approved after fix (preflight, symlinks, partial failure) | n/a |
| Whole branch | n/a | `e44ed8e..3083426` | APPROVE (1 Important fixed in a306759, rest noted below) | n/a |

---

## Iteration 2 (post-PR, user-approved scope)

Reason: the user asked to align `spec-validation` severities with the OpenSpec validator and to avoid being stricter than OpenSpec without a reason (brief required SHALL/MUST and WHEN/THEN as errors).
- Artifacts: `specs/spec-validation/spec.md` (Living spec checks rewritten, scenarios added), `tasks.md` group 7, `plan.md` Task 7 and the `Scenario` contract.
- Code: `1d2250f` `fix(core): align spec check severities with OpenSpec`. `spec-normative` and `spec-when-then` are warnings; GIVEN accepted as trigger; `spec-no-requirements` is an error.
- Review: code-reviewer APPROVE (1 minor: extra regression tests for GIVEN with CRLF, GIVEN-only and delta-style headers, not added because the behavior was probed).
- Migrate then validate on the 22 pi-superspec `spec.md` files: 0 errors, 0 warnings.

| Task | Lane branch | Lane range | Review | Merge commit |
|---|---|---|---|---|
| Task 7 | sequential | `990a1f5..1d2250f` | APPROVE | n/a |

---

## Review notes carried to verify

- Step 6.3: only the 22 `openspec/specs/*/spec.md` files of pi-superspec were copied into a scratch git repo; migrate moved 22, 0 conflicts; validate reported no errors and no warnings (raw output: `/tmp/spec-core-6.3-output.txt`).
- `/livespec validate` does not run the diff-based checks (`capabilitiesMatchDiff`, `validateDecisionDiff`) or the change-body checks (`validateUnits`, `checkDoneMapsScenarios`): the Base and the change issue come from the forge (LS-03). They exist as pure core functions with tests. Wiring is left to later specs.
- Minor findings not fixed: line numbering is 1-based in spec, glossary and bare-work entries but 0-based in `Question.line`, `InitiativeChange.line` and `Unit.startLine/statusLine/endLine`; scalar `paths:` and malformed `Capabilities:` are ignored silently; POSIX classes in globs are not rejected; `capabilitiesMatchDiff` treats some in-capability renames and additions as "created"; `parseSpec` is about 60 lines; a spec with no requirements passes silently.
- Tests: 211 passing, `bun run typecheck` clean.

---

## Next step

Run `/opsx-verify`.
