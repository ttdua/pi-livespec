# Smoke record: gates-and-decisions (LS-05)

- **Date:** 2026-11-16
- **pi version:** 1.5.2 (`pi --version`; devDependency `@earendil-works/pi-coding-agent` `^1.5.0`)
- **Branch:** `gates-and-decisions`

## Automated checks

| Command | Result |
|---|---|
| `bun run typecheck` | pass (`tsc --noEmit`, no errors) |
| `bun run test` | pass: 112 test files, 1541 tests (after the smoke fix) |

## Manual smoke (real GitHub, 2026-11-16)

- **Repository:** `ttdua/superspecplan` (private scratch). The work was on branch `ls05-smoke`, with `integrationBranch: ls05-smoke`; `main` was not touched.
- **Account:** `ttdua` (admin). pi 1.5.2. The extension was loaded with `-e src/extension.ts` from `gates-and-decisions`.
- **Issue:** #12 `smoke-greeting`.

| Step | How | Outcome |
|---|---|---|
| `/livespec init`, then `change_new` and `change_start` | `pi -p` | pass: issue #12 was created and branch `livespec/smoke-greeting` was cut from `ls05-smoke` |
| Self gate `shape` | `pi -p`, `spec_gate shape` | pass: `gate` comment with `by: livespec`; phase `define` |
| Define gate, in session | interactive TUI (tmux), `spec_gate define`; the human picked **approve**, then **No notes** | pass: the dialog showed Capabilities, Product impact, the Proposal, the spec diff stat and the changed files. The `gate` comment has `adapter: in-session` and `by: ttdua`; phase `plan` |
| `plan_units` | `pi -p` | **failed first**, with a version conflict on every run. Cause: on GitHub, posting a comment bumps the issue's `updated_at`, which is part of the issue version, so the body write that follows the decision records always conflicted. Fixed in `125a0d8` (re-read after posting the records). The memory forge now bumps the version on a new comment (`9521505`), so tests cover this. After the fix: pass, U1 written with `Difficulty: low`, `Tags: []` and 2 decision records |
| Plan gate, through the forge | `interaction.adapter: [forge]`, `spec_gate plan`; `ttdua` commented `/livespec approve smoke test approval from ttdua`; then `pi -p "/livespec next"` | pass: the `request` comment lists the units and decisions. The `gate` comment has `adapter: forge`, `outcome: approved_with_notes`, the notes, `answer_comment` (the id and author of that comment) and `locked.U1`. The phase moved to `build` |
| Amendment, through the forge | `unit_amend U1`, then `/livespec approve`, then `/livespec next` | pass: the `amendment` comment holds the old and new digests, with `adapter: forge` |

**Not covered on the real forge:**
- A command from a non-writer. `naicoi92` cannot read this private repository, so no comment could be posted from it; unit tests in `tests/interaction/forge.test.ts` cover the case.
- The same-login gap. Every answer here came from `ttdua`, which is also the plugin's login. This is the known LS-06 gap.

## In-memory end-to-end test

`tests/e2e/gates-flow.test.ts` › `full gate flow over a memory forge` also passes: question cascade, iteration cap, stuck report and `choose`.
