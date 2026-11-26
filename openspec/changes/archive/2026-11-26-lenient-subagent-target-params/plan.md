# Lenient Subagent Target Parameters Implementation Plan

> Executed via `/opsx-apply`, which chooses the executor.
> Spec reference: this change's `specs/` and `design.md`.

**Goal:** `subagent_dispatch`, `subagent_packet` and `subagent_record` accept empty and role-inapplicable `unit`/`subject`/`finding` values, warning about the ignored ones, while required parameters stay strict.

**Architecture:** A pure pre-pass `ignoreInapplicable` normalises empty strings and drops inapplicable `subject`/`finding` with warnings; each tool runs it first and wraps its whole result (success or refusal) with `withWarnings`. `checkTarget` is unchanged in shape and runs on the cleaned params. Descriptions document the role/parameter matrix.

**Tech Stack:** TypeScript, vitest (`bun run test`), `tsc --noEmit` (`bun run typecheck`).

## Global Constraints

- Refusals for unknown role, reviewer without/unknown subject, missing or nonexistent unit, verifier without a valid finding, and child sessions stay as specified (spec "Dispatch tool").
- Warning lines, exact copy: `Warning: ignored subject "<value>": only reviewer takes a subject.` and `Warning: ignored finding "<value>": only verifier takes a finding reference.`
- Records, packets and `argsOf` output for a call with ignored parameters equal those of the call without them.

## Review Focus

- Whitespace-only values (`" "`) are not empty: `subject " "` for a reviewer still refuses as unknown; for a scout it is ignored with a warning. Pin in Step 1 test table.
- `unit` for `scout` stays strict: `scout unit="U9"` refuses with "does not exist" (unit is optional but validated). Pin in Step 1.
- A warning survives a later refusal: `implementer unit="" finding="c1:0"` refuses with "a unit id is required" and the text starts with the finding warning (design: success or later refusal alike).
- An unknown role drops nothing: `{ role: "planner", subject: "spec" }` refuses "unknown role" with no warning.
- `reviewer subject="unit" unit=""` refuses with "a unit id is required".

---

## Contracts

| Name | new / modified | Shape | public |
|---|---|---|---|
| `ignoreInapplicable` | new | `<P extends TargetParams>(p: P) => { params: P; warnings: string[] }` (generic so `RecordParams.result` passes through untouched) in `src/tools/subagent-target.ts`; pure; `""` → absent for `unit`/`subject`/`finding`; for a known role drops `subject` unless role is `reviewer` and `finding` unless role is `verifier`, warnings in that order | no |
| `checkTarget` | unchanged shape | `(p: TargetParams, state: ChangeState) => Target \| string`, called with `ignoreInapplicable(p).params`; its `"only a reviewer takes a subject"` check and `checkFindingRef`'s `"only a verifier"` refusal become unreachable and are removed; `checkFindingRef` keeps returning `{ ok: true }` for a non-verifier with no finding | no |
| `withWarnings` | new | `<D>(warnings: string[], result: ToolResult<D>) => ToolResult<D>` in `src/tools/subagent-target.ts`; returns `result` unchanged when `warnings` is empty, else prefixes the first text content with `warnings.join("\n") + "\n\n"` | no |
| `subagent_dispatch` / `subagent_packet` / `subagent_record` parameters | modified | same JSON schema keys; only accepted values widen (see spec); descriptions updated | yes (tool API, non-breaking) |

---

## Task 1: Lenient target parameters with warnings — implements 1

**Covers:** 1.1, 1.2, 1.3, 1.4, 1.5, 1.6
**Difficulty:** Normal
**Blocked by:** none

**Files:**
- Modify: `src/tools/subagent-target.ts`, `src/tools/subagent-dispatch.ts`, `src/tools/subagent-packet.ts`, `src/tools/subagent-record.ts`
- Test: `tests/tools/subagent-dispatch.test.ts`, `tests/tools/subagent-record.test.ts`
- Docs: `docs/architecture.md`, `CHANGELOG.md`

**Interfaces:** Produces `checkTarget` and `withWarnings` as in Contracts.

- [ ] **Step 1: Write failing tests** in `tests/tools/subagent-dispatch.test.ts`, `describe("lenient target parameters")`, using `subagentHarness({ executor: {} })`, `h.call`, `textOf`. Scout runs must use a scout-valid result: `next(h, citing(h, { commits: undefined }))` (the scout schema forbids `commits`). Define a local helper `scoutRun(params)` that, in a fresh harness, dispatches `params` and returns `{ out, prompt: h.fake.spawned[0].prompt, metadata: h.fake.spawned[0].options.metadata, record: (await h.latest("dispatch"))?.data }`; "same as omitted" means `prompt`, `metadata` and `record` (minus `agentId` and any id or timestamp that differs between runs) deep-equal those of `scoutRun({ role: "scout" })`.
  - `"empty parameters are omitted"`: `subagent_dispatch { role: "scout", unit: "", subject: "", finding: "" }` → `isError` falsy, spawned length 1, text does not contain `"Warning: ignored"`, and same as omitted (via `scoutRun`).
  - `"subject for a role that takes none"`: `{ role: "scout", subject: "spec" }` → spawned length 1, text starts with `Warning: ignored subject "spec": only reviewer takes a subject.`, and same as omitted.
  - `"finding for a role that takes none"`: `subagent_packet { role: "implementer", unit: "U1", finding: "c1:0" }` → not error, and its text equals `Warning: ignored finding "c1:0": only verifier takes a finding reference.\n\n` + the text of `subagent_packet { role: "implementer", unit: "U1" }` called in the same harness (packet identical to the omitted call).
  - `"ignored values are not validated"`: `subagent_dispatch { role: "scout", subject: "vibes", finding: "nope" }` → spawned length 1, text starts with `Warning: ignored subject "vibes": only reviewer takes a subject.\nWarning: ignored finding "nope": only verifier takes a finding reference.`, and same as omitted.
  - `"a warning survives a later refusal"`: `subagent_dispatch { role: "implementer", unit: "", finding: "c1:0" }` → `isError` true, text starts with `Warning: ignored finding "c1:0"` and contains `a unit id is required`, spawned empty.
  - Extend the existing `refuses %o` table: remove `[{ role: "implementer", unit: "U1", subject: "unit" }, "only a reviewer takes a subject"]`; add `[{ role: "reviewer", subject: "" }, "a reviewer needs a subject"]`, `[{ role: "reviewer", subject: " " }, "unknown subject"]`, `[{ role: "planner", subject: "spec" }, "unknown role"]`, `[{ role: "reviewer", subject: "unit", unit: "" }, "a unit id is required"]`, `[{ role: "scout", unit: "U9" }, "does not exist"]`, `[{ role: "implementer", unit: "", finding: "c1:0" }, "a unit id is required"]`, `[{ role: "implementer", unit: "" }, "a unit id is required"]`, `[{ role: "verifier", finding: "" }, "a finding reference"]`; each row also asserts `h.fake.spawned` is empty.
  - In `tests/tools/subagent-record.test.ts`: `"inline record ignores a finding for an implementer"` — in the `"no executor"` setup (`subagentHarness({ units: [U1] })`, `h.start("U1")`), get `packet` from `subagent_packet { role: "implementer", unit: "U1" }`, then `subagent_record { role: "implementer", unit: "U1", finding: "c1:0", result: done({ commits: [], sources_used: footerIds(textOf(packet)) }) }`; expect not error, text starts with `Warning: ignored finding "c1:0": only verifier takes a finding reference.`, and the latest `dispatch` record matches `{ role: "implementer", unit: "U1", status: "DONE", agentSource: "inline", attempt: 1 }`, has no `finding`/`verifies` key, and its `packet` hash equals the hash of the packet built without the finding (`readPacket` of that hash exists).
  - Update the existing `"Verifier without a finding, a finding for another role, an unknown key"` test: the `implementer U1 finding: key` call (capable executor not set → inline) now is not an error and its text starts with `Warning: ignored finding`; the `h.marked()` length assertion moves before that call (the inline dispatch writes nothing, but keep it scoped to the refused calls). Rename the test to `"Verifier without a finding, an ignored finding for another role, an unknown key"`.
- [ ] **Step 2: Run** `bunx vitest run tests/tools/subagent-dispatch.test.ts tests/tools/subagent-record.test.ts` → the new tests FAIL (refusals such as `unknown subject ""`).
- [ ] **Step 3: Implement `ignoreInapplicable` and `withWarnings`** per Contracts in `src/tools/subagent-target.ts`. Warning values use `JSON.stringify` of the raw value. Remove the two unreachable refusals named in the `checkTarget` contract row; keep `checkFindingRef`'s non-verifier fast path.
- [ ] **Step 4: Wire the three tools**: in `runSubagentDispatch`, `runSubagentPacket`, `runSubagentRecord`, call `ignoreInapplicable(p)` first, run the existing body on `params` (extract it to a private function per file if needed), and return `withWarnings(warnings, result)` for every result, refusals included.
- [ ] **Step 5: Descriptions.** `TARGET_PROPERTIES`: unit → `"Unit id such as U3. Required for implementer and for reviewer subject unit; optional for scout and other reviewer subjects; omit for verifier."`; subject → `"Only for role reviewer: spec, plan, unit, change or persona:<name>. Omit for other roles (ignored with a warning)."`; finding → `"Only for role verifier (required): <aggregateCommentId>:<index>. Omit for other roles (ignored with a warning)."`. Append to each of the three tool descriptions: `"Parameters by role: scout [unit]; implementer unit; reviewer subject [+ unit when subject is unit]; verifier finding. Omit the others."`
- [ ] **Step 6: Run** `bun run test` and `bun run typecheck` → all pass.
- [ ] **Step 7: Docs.** `docs/architecture.md` dispatch section: one sentence that empty `unit`/`subject`/`finding` are treated as omitted and a `subject` or `finding` for a role that does not take it is ignored with a warning in the tool result. `CHANGELOG.md`: add `## [Unreleased]` → `### Changed` entry describing the same.
- [ ] **Step 8: Commit** `git commit -m "fix(subagents): ignore empty and role-inapplicable target parameters with a warning"`

---

## Scenario → test

- Unit role without a unit → existing `"unit role without a unit refuses"`
- Called in a child → existing `"called in a child refuses: %s"`
- Verifier without a finding → existing `"Verifier without a finding, an ignored finding for another role, an unknown key"` (subagent-record.test.ts; omitted finding, nothing marked) and `refuses %o` row `{ role: "verifier", finding: "" }` (spawned empty)
- Verifier recorded → existing `"Verifier recorded"` (subagent-record.test.ts, verdict `refuted`)
- Empty parameters are omitted → `"empty parameters are omitted"`
- Subject for a role that takes none → `"subject for a role that takes none"`
- Finding for a role that takes none → `"finding for a role that takes none"`
- Ignored values are not validated → `"ignored values are not validated"`
- Inline record with an ignored finding → `"inline record ignores a finding for an implementer"` (subagent-record.test.ts)
- Required parameters given empty → `refuses %o` rows `{ role: "implementer", unit: "" }` and `{ role: "verifier", finding: "" }`
- Reviewer with an empty subject → `refuses %o` row `{ role: "reviewer", subject: "" }`
