# Gate Briefing Implementation Plan

> Executed via `/opsx-apply`, which chooses the executor.
> Spec reference: this change's `specs/` and `design.md`.

**Goal:** Every human request carries an agent- or rule-written briefing (summary, watch points, recommended choice, rationale, option descriptions) that both adapters render after livespec's facts, with a readable forge comment.

**Architecture:** One pure module (`src/interaction/briefing.ts`) validates and neutralises briefings; producers (`spec_gate`, proposers, `unit_amend`, `spec_stuck`, `spec_question`, rule asks) attach the briefing to `ApprovalRequest`/`RequestRecord`; two pure renderers (`forge-text.ts`, the reworked `in-session.ts`) present it, using livespec-written action descriptions (`describe-actions.ts`).

**Tech Stack:** TypeScript (ESM, `.ts` imports), vitest, bun; pi `ExtensionAPI` tools with plain JSON-schema parameters.

## Global Constraints

- Length limits in Unicode code points: summary 600, rationale 600, watch item 200 (max 5 items), option description 200.
- Answers come only from the human; no tool gains an `outcome`, `choice`, `answer`, `approved`, `difficulty` or `tags` parameter (`tests/tools/no-answer-params.test.ts` must keep passing).
- Forge command grammar and `parseCommand` do not change.
- Livespec-written text is English; code comments English.
- No new dependency. Run `bun run typecheck` and `bun run test` before each commit.

## Review Focus

- A briefing with CRLF line endings or a trailing newline: "no blank line" must treat `\r\n\r\n` and `\n\n` alike, and a single trailing newline is trimmed, not refused → `briefing.test.ts` "normalises CRLF and trims".
- Emoji or CJK text at the limit: 600 code points pass even when UTF-16 length is larger → `briefing.test.ts` "counts code points".
- A recommended choice that matches a built-in action at a gate offering `waive`: `waive` is accepted only when offered → `spec-gate.test.ts` "recommend waive only when offered".
- Duplicate labels after adding descriptions (two options with the same label): menu stays unambiguous by position → `in-session.test.ts` "duplicate labels with descriptions stay distinct".
- A candidate label that `parseCommand` would read differently (`limit  per user`, `--class`) is refused before anything is written → `spec-question.test.ts` "Candidate label that cannot round-trip".

---

## Contracts

| Name | new / modified | Shape | public |
|---|---|---|---|
| `Briefing` (`src/interaction/approver.ts`) | new | `{ summary: string; watch?: string[]; recommended?: string; rationale?: string; author: "agent" \| "rule" }` | no |
| `RequestOption` | modified | `{ id: string; label: string; description?: string }` | no |
| `RequestRecord.briefing` / `ApprovalRequest.briefing` | modified | `briefing?: Briefing` (stored in the forge `request` yaml) | public (forge comment format) |
| `validateBriefing` (`src/interaction/briefing.ts`) | new | `(raw: unknown, choices: string[], o: { author: "agent" \| "rule" }) => Briefing \| { refused: string }` — `raw` must be defined (callers refuse `undefined` themselves, naming `briefing`); an `author` key in `raw` is ignored | no |
| `validateOptionTexts` | new | `(options: RequestOption[], o: { requireDescription: boolean }) => RequestOption[] \| { refused: string }` | no |
| `neutralise` | new | `(text: string) => string` — `<!--` → `<!-\u200b-`; a line starting with `/livespec` gets a leading `\u200b` | no |
| `offeredChoiceIds` (`src/interaction/describe-actions.ts`) | new | `(i: { kind: "gate" \| "amend" \| "choice"; options: RequestOption[]; failingWaivable?: string[] }) => string[]` — gate: `approve` (omitted when `failingWaivable` non-empty), `changes`, `dismiss`, then option ids (incl. `waive`); amend: `approve`, `changes`, `dismiss`; choice: option ids | no |
| `gateChoices` (`src/interaction/describe-actions.ts`) | new | `(r: ApprovalRequest) => { id: string; label: string; description: string; command: string }[]` — the entries of `offeredChoiceIds` in that order; `waive` appears once, command `/livespec choose waive [notes]` | no |
| `recommendationRefusal` (`src/tools/spec-gate.ts`) | new | `(b: Briefing \| undefined, plan: GatePlan) => string \| undefined` — refuses `approve` while `plan.failingWaivable` is non-empty (text names `waive`) and any id not in `offeredChoiceIds` | no |
| `menuEntries`, `titleWithBriefing` (`src/interaction/menu.ts`) | new | `menuEntries<T>(choices: { label: string; description?: string; value: T; id: string }[], recommended?: string) => MenuEntry<T>[]`; `titleWithBriefing(r: ApprovalRequest) => string` | no |
| `renderForgeRequest` (`src/interaction/forge-text.ts`) | new, replaces `plainText` | `(r: ApprovalRequest) => string` | public (forge comment format) |
| `spec_gate` parameters | modified | `{ target: string; briefing?: { summary: string; watch?: string[]; recommended?: string; rationale?: string } }`; required for human targets | public |
| `initiative_propose`, `new_dependency` parameters | modified | add optional `briefing` (same shape) | public |
| `unit_amend` parameters | modified | add optional `briefing` (same shape) | public |
| `spec_stuck` parameters | modified | `options: { id; label; description }[]` (description required); new required `rationale: string` | public |
| `spec_question` parameters | modified | add optional `candidates: { label: string; description: string }[]` (2-4), `recommended?: "A"\|"B"\|"C"\|"D"`, `rationale?: string` | public |
| `NamedGateInput` (`src/tools/spec-gate.ts`) | modified | add `briefing?: Briefing` | no |
| `RuleResult.ask` (`src/decide/registry.ts`) / `DecisionAsk` (`src/decide/seam.ts`) | modified | `ask: { summary: string; options: { id; label; description? }[]; recommended?: string; rationale?: string }` | no (extension seam, in-repo only) |

---

## Task 1: Briefing core — implements 1

**Covers:** 1.1, 1.2, 1.3
**Difficulty:** Normal
**Blocked by:** none

**Files:**
- Modify: `src/interaction/approver.ts`, `src/interaction/requests.ts`
- Create: `src/interaction/briefing.ts`
- Test: `tests/interaction/briefing.test.ts`, `tests/interaction/requests.test.ts`

**Interfaces:** Produces `Briefing`, `RequestOption.description`, `validateBriefing`, `validateOptionTexts`, `neutralise` (see Contracts). `PrepareInput` gains `briefing?: Briefing`; `prepareRequest` copies it onto the record when defined.

- [ ] **Step 1:** Write failing tests in `tests/interaction/briefing.test.ts`: "Summary too long" (601 code points → refused naming `summary` and `600`), "Rationale missing" (`recommended` without `rationale` → refused naming `rationale`), rationale without recommended → refused, "Recommended choice not offered" (`recommended: "C"`, choices `["A","B"]` → refused naming `recommended`, `A, B`), watch with 6 items / multi-line item → refused, "counts code points" (600 emoji pass), "normalises CRLF and trims", blank line in summary → refused, description over 200 or multi-line → refused, `requireDescription` missing description → refused naming the option id, "Fake marker neutralised" and "Fake command neutralised" on `neutralise`, validated text comes back neutralised, and `{ summary, author: "rule" }` validated with `{ author: "agent" }` yields `author: "agent"`.
- [ ] **Step 2:** Run `bunx vitest run tests/interaction/briefing.test.ts` — expect FAIL (module missing).
- [ ] **Step 3:** Add the types to `approver.ts`; implement `briefing.ts` (lengths via `[...s].length`).
- [ ] **Step 4:** Add to `tests/interaction/requests.test.ts`: `prepareRequest` with a briefing stores it; a record yaml without `briefing` still parses through `readRequests` ("Request without a briefing", read side). Implement in `requests.ts`.
- [ ] **Step 5:** Run `bunx vitest run tests/interaction` and `bun run typecheck` — PASS.
- [ ] **Step 6:** Commit `feat(interaction): briefing type, validation and neutralisation`.

---

## Task 2: Forge request text — implements 2

**Covers:** 2.1, 2.2, 2.3
**Difficulty:** Normal
**Blocked by:** Task 1

**Files:**
- Create: `src/interaction/describe-actions.ts`, `src/interaction/forge-text.ts`
- Modify: `src/interaction/forge.ts` (remove `plainText`, call `renderForgeRequest`)
- Test: `tests/interaction/forge-text.test.ts`, `tests/interaction/forge.test.ts`, `tests/interaction/complete.test.ts`

**Interfaces:** Consumes `Briefing`, `neutralise`. Produces `offeredChoiceIds`, `gateChoices(r)` (used by Tasks 3, 4) and `renderForgeRequest(r)` built from one function per section (heading, facts, checks, briefing, answers, details). Command strings per row: approve `/livespec approve [notes]`, changes `/livespec changes <notes>`, dismiss `/livespec dismiss [notes]`, waive and other options `/livespec choose <id> [notes]`, question candidate `/livespec answer Q<n> <label>`, question free text `/livespec answer Q<n> <text>`. Approve descriptions: `define` "Accept the spec; the change moves to plan.", `plan` "Lock the unit digests; the change moves to build.", `ship` "Accept the ship packet; change_ship can then run.", named gate / amendment "Accept; the gate's effects are applied." Waive: "Approve and waive the failing checks: <names>."

- [ ] **Step 1:** Failing tests in `forge-text.test.ts`: "Gate comment structure" (heading `## Decision needed:` naming subject and `#<n>`, facts, briefing, How-to-answer table with the recommended `approve` row marked and `/livespec approve`, `<details>` list, in that order), "Facts before the briefing" (checks table with `size-limits` before briefing), "Rule briefing not labelled as agent" (author `rule` → heading contains `livespec rule`, not `agent-authored`), "Question candidates as commands", free-text row always present for questions, "Plan approve described", "Waive lists the checks", `|` in a label is escaped, a briefing containing ```` ``` ````, `## How to answer` or `</details>` cannot add a section or close the details block (briefing rendered as blockquote), a stored summary containing `<!--` renders neutralised, request without briefing has no briefing section, `approve` row absent and `waive` row present once while a waivable check fails.
- [ ] **Step 2:** Failing test "Prefilled answer parses back": `parseCommand` of the rendered candidate command returns `{ verb: "answer", question: "Q2", text: "per-user limits" }`.
- [ ] **Step 3:** Run `bunx vitest run tests/interaction/forge-text.test.ts` — FAIL.
- [ ] **Step 4:** Implement `describe-actions.ts` and `forge-text.ts`; switch `createForgeApprover` to `renderForgeRequest`. Update `tests/interaction/forge.test.ts` assertions that read the old plain text; keep "request comment round-trips the prepared record" and add a briefing to it ("Briefing stored with the request"). Add to `complete.test.ts`: "answer comment keeps the briefing" (`answer.request.briefing` equals the request's) and "pre-briefing request completes" (a stored request without `briefing` completes to a `gate` comment).
- [ ] **Step 5:** `bunx vitest run tests/interaction` and `bun run typecheck` — PASS.
- [ ] **Step 6:** Commit `feat(forge): readable request comments with briefing and how-to-answer table`.

---

## Task 3: In-session presentation — implements 3

**Covers:** 3.1, 3.2, 3.3
**Difficulty:** Hard
**Blocked by:** Task 2

**Files:**
- Modify: `src/interaction/in-session.ts`
- Create: `src/interaction/menu.ts`, `tests/interaction/menu.test.ts`, `tests/helpers/menu.ts`
- Modify tests that script `select`: `tests/interaction/in-session.test.ts`, `tests/tools/spec-gate.test.ts`, `tests/tools/spec-gate-behavior.test.ts`, `tests/tools/spec-question.test.ts`, `tests/tools/spec-stuck.test.ts`, `tests/tools/decide-ask.test.ts`, `tests/tools/plan-units.test.ts`, `tests/tools/change-ship.test.ts`, `tests/tools/unit-amend.test.ts`, `tests/tools/initiative-propose.test.ts`, `tests/tools/new-dependency.test.ts`, `tests/e2e/gates-flow.test.ts`, `tests/e2e/initiative-flow.test.ts`

**Interfaces:** Consumes `gateChoices`, `Briefing`. Produces `pickByLabel(options: string[], label: string): string | undefined` in `tests/helpers/menu.ts` — returns the entry equal to `label` or starting with `label + " — "` / `label + " (Recommended)"`. Built-in gate labels stay `approve`, `request changes`, `dismiss`; option labels are `<label>`; a question without candidates keeps `answer now` / `answer later (non-blocking)`; with candidates its entries are each candidate label, `write my own answer`, `answer later (non-blocking)`.

- [ ] **Step 1:** Failing tests in `in-session.test.ts`: "Recommended entry first" (stuck A, B; B recommended → first entry `B-label — B-desc (Recommended)`, pick → choice `B`), "Briefing shown before options" (title = summary then briefing summary and rationale), no entry ends with `[id]`, "duplicate labels with descriptions stay distinct", "Question candidate picked in session" (pick `per-user limits`, then `no` → answer `per-user limits`), "Own answer instead of a candidate", cancel on a recommended stuck request → `dismissed` with no choice ("Recommendation is not an answer").
- [ ] **Step 2:** Failing tests in `tests/interaction/menu.test.ts` for `menuEntries` (recommended first, ` (Recommended)`, `<label> — <description>`, dedupe by position) and `titleWithBriefing` (facts then briefing); a gate request with `failingWaivable` and a briefing recommending `waive` shows `waive` first and no `approve`. Run `bunx vitest run tests/interaction` — FAIL.
- [ ] **Step 3:** Implement `menu.ts`, then `in-session.ts` flows on top of it: menus built from `gateChoices` / options with `<label> — <description>`, recommended moved first with ` (Recommended)`, title `summary + "\n\n" + briefing block`; question flow per Interfaces, then the existing requirement question.
- [ ] **Step 4:** Add `tests/helpers/menu.ts`; switch the listed tests' fake `select` implementations to `pickByLabel`. No assertion about outcomes changes.
- [ ] **Step 5:** `bun run test` and `bun run typecheck` — PASS.
- [ ] **Step 6:** Commit `feat(in-session): show briefing, option descriptions and recommended choice`.

---

## Task 4: spec_gate and proposer briefings — implements 4

**Covers:** 4.1, 4.2, 4.3
**Difficulty:** Hard
**Blocked by:** Task 3

**Files:**
- Modify: `src/tools/spec-gate.ts`, `src/tools/initiative-propose.ts`, `src/tools/new-dependency.ts`
- Create: `tests/helpers/briefing.ts` (`export const BRIEFING = { summary: "Fixture briefing." }`)
- Test: `tests/tools/spec-gate.test.ts`, `tests/tools/spec-gate-behavior.test.ts`, `tests/tools/spec-question.test.ts`, `tests/evidence/red-on-base.test.ts`, `tests/e2e/gates-flow.test.ts`, `tests/e2e/review-flow.test.ts`, `tests/e2e/initiative-flow.test.ts`, `tests/tools/change-ship.test.ts`, `tests/tools/spec-review.test.ts`, `tests/tools/initiative-propose.test.ts`, `tests/tools/new-dependency.test.ts`

**Interfaces:** Consumes `validateBriefing`, `offeredChoiceIds`, `NamedGateInput.briefing`; produces `recommendationRefusal`. `runSpecGate(p: SpecGateParams, ctx)` with `SpecGateParams = { target: string; briefing?: unknown }`, its new step extracted as `briefingStep(target, pack, raw)`. Order (design D2): require change → proposer refusal → resolve gate mode → `briefingStep` for human targets (shape against every id the target could offer: `approve`, `changes`, `dismiss`, `waive`, registered options) → behavior step / gate checks → refusals → `planGate` (unchanged) → `recommendationRefusal` → request. Proposer tools (`initiative_propose`, `new_dependency`) validate an optional briefing's shape before their reads and planning, against `offeredChoiceIds({ kind: "gate", options: [waive, ...offered] })`; `sendNamedGate` runs `recommendationRefusal` after its `planGate`.

- [ ] **Step 1:** Failing tests in `spec-gate.test.ts`: "Human gate without a briefing" (no check ran: assert no `verify-red-on-base` invocation and no `decide:` request), "Rationale missing", "Self gate ignores the briefing" (missing and invalid), "Approve not recommended while a check must be waived", "recommend waive only when offered", "Define approved" extended with a briefing and asserting the dialog title contains it.
- [ ] **Step 2:** Failing test "Proposer briefing" in `initiative-propose.test.ts` (with and without), and in `new-dependency.test.ts` one with a briefing plus one recommending an option the request does not offer (refused, nothing written).
- [ ] **Step 3:** Run them — FAIL.
- [ ] **Step 4:** Implement in `spec-gate.ts` (parameter schema with `briefing` object, description that it is required for human gates and advisory), pass through `gateRequest`/`sendNamedGate`; add optional `briefing` to both proposer tools.
- [ ] **Step 5:** Add `briefing: BRIEFING` to every human `spec_gate` call in the listed test files (including `spec-question.test.ts:127,184`, whose refusal assertion must still see the `spec_stuck` hint), and give the `STUCK` fixture in `tests/e2e/gates-flow.test.ts` descriptions and a rationale now so Task 5 does not need to edit that file.
- [ ] **Step 6:** `bun run test`, `bun run typecheck` — PASS (`no-answer-params` included).
- [ ] **Step 7:** Commit `feat(spec_gate): require an agent briefing for human gates`.

---

## Task 5: Stuck report descriptions and rationale — implements 5

**Covers:** 5.1, 5.2, 5.3
**Difficulty:** Normal
**Blocked by:** Task 3, Task 4

**Files:**
- Modify: `src/tools/spec-stuck.ts`, `src/subagents/finish-freshness.ts`
- Test: `tests/tools/spec-stuck.test.ts`, `tests/subagents/freshness.test.ts` (the gates-flow `STUCK` fixture was already updated in Task 4)

**Interfaces:** `SpecStuckParams` gains `rationale: string`; options are `RequestOption` with required `description` at the tool boundary. `StuckReport` gains `rationale?: string`. `stuckReport(p, { strict: boolean })`: strict for tool params; lenient for `storedReport`, skipping only description, rationale and length rules (where, tried, hypothesis, 2-3 options and a valid `recommended` still required). `stuckRequest` attaches `briefing = { summary: hypothesis, recommended, rationale, author: "agent" }` only when `rationale` is present; the summary keeps its `Recommended:` line. `stuckFor` caps the hypothesis at 600 code points by dropping whole stale entries from the end and appending `and <k> more` (a single entry longer than the budget is truncated with `…`).

- [ ] **Step 1:** Failing tests: "Option without a description", rationale missing → refused, hypothesis of 601 code points → refused, "Recommended choice not offered" (`recommended: "C"`), "Old stuck report sent again" (stored data without descriptions/rationale, open, no request → request sent, summary has `Recommended:`, no briefing), "Option description neutralised", "Recommendation is not an answer" via the tool with a cancelled UI; `freshness.test.ts`: `stuckFor` with 8 stale sources and with one 2,000-character `unreadable:` entry passes strict validation.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement; neutralise `where`, `tried[].text` and `hypothesis` at validation. Update `inputSchema` of `spec_stuck`.
- [ ] **Step 4:** `bun run test`, `bun run typecheck` — PASS.
- [ ] **Step 5:** Commit `feat(spec_stuck): option descriptions and recommendation rationale`.

---

## Task 6: Question candidates — implements 6

**Covers:** 6.1, 6.2
**Difficulty:** Normal
**Blocked by:** Task 3, Task 4

**Files:**
- Modify: `src/tools/spec-question.ts`
- Test: `tests/tools/spec-question.test.ts`

**Interfaces:** `SpecQuestionParams` gains `candidates?: { label: string; description: string }[]`, `recommended?: string`, `rationale?: string`. Candidate rule: `label === label.trim()`, no `\s{2,}`, no newline, no word matching `/^--/`, unique. Options are `{ id: "A".., label, description }`. Briefing: `{ summary: <question text>, recommended, rationale, author: "agent" }` only when candidates are given. Question text is neutralised in the request summary only; the `## Questions` line keeps the raw text.

- [ ] **Step 1:** Failing tests: "Candidate answers sent", "Too many candidates" (5), one candidate → refused, "Candidate label that cannot round-trip" (`limit --class blocking`), duplicate labels refused, `reask` with new candidates sends them, "Blocking by default" still passes without candidates, a tool-level "Summary too long" (601-character rationale) is refused.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement and extend the tool schema.
- [ ] **Step 4:** `bun run test`, `bun run typecheck` — PASS.
- [ ] **Step 5:** Commit `feat(spec_question): candidate answers with a recommendation`.

---

## Task 7: Rule ask briefings — implements 7

**Covers:** 7.1, 7.2, 7.3
**Difficulty:** Easy
**Blocked by:** Task 4

**Files:**
- Modify: `src/decide/registry.ts`, `src/decide/seam.ts`, `src/tools/decide-ask.ts`, `src/docs/behavior-change.ts`
- Test: `tests/decide/seam.test.ts`, `tests/tools/decide-ask.test.ts`, `tests/docs/behavior-change.test.ts`

**Interfaces:** `RuleResult.ask` per Contracts. `decide` runs `validateOptionTexts` on the rule's options and throws `decision \`<point>\` recommends \`<id>\`, which it does not offer` when `recommended` is not an option id. `decisionRequest` sets `briefing = { summary: intent.summary, recommended, rationale, author: "rule" }` only when `recommended` is set. `BEHAVIOR_OPTIONS` descriptions: `unchanged` "A refactor: the spec stays as it is.", `changed` "Behavior changed: the gate refuses until specs/<capability>/spec.md is updated."

- [ ] **Step 1:** Failing tests: "Rule ask carries descriptions" (behavior-change request options have descriptions, no briefing), a test rule recommending `x` with rationale → request briefing author `rule`, "Rule recommends an option it does not offer" (test rule recommending `z` → `decide` throws naming `z`), a rule option description over 200 code points → `decide` throws.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `bun run test`, `bun run typecheck` — PASS.
- [ ] **Step 5:** Commit `feat(decide): rule asks carry option descriptions and recommendations`.

---

## Task 8: Amendment briefing — implements 8

**Covers:** 8.1, 8.2
**Difficulty:** Easy
**Blocked by:** Task 3

**Files:**
- Modify: `src/tools/unit-amend.ts`
- Test: `tests/tools/unit-amend.test.ts`

**Interfaces:** `UnitAmendParams` gains `briefing?: unknown`, validated with choices `approve`, `changes`, `dismiss` right after `amendForm`, before `planAmend` runs any decision. `amendRequest(state, plan, body, now, briefing?)`.

- [ ] **Step 1:** Failing tests: "Amendment with a briefing" (request carries it; in-session first entry is `approve — … (Recommended)`), invalid briefing with a `difficulty` rule that would ask → refused and no `decide:` request posted.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement and extend the tool schema.
- [ ] **Step 4:** `bun run test`, `bun run typecheck` — PASS.
- [ ] **Step 5:** Commit `feat(unit_amend): optional briefing on amendment requests`.

---

## Task 9: Documentation — implements 9

**Covers:** 9.1, 9.2
**Difficulty:** Easy
**Blocked by:** Task 4, Task 5, Task 6, Task 7, Task 8

**Files:**
- Modify: `README.md`, `README.vi.md`, `docs/architecture.md`, `CHANGELOG.md`

- [ ] **Step 1:** README "Human gates": describe the briefing (facts first, advisory label, recommended choice), the new forge comment layout with an example, question candidates, and the menu labels in session; same content in `README.vi.md` (Vietnamese).
- [ ] **Step 2:** `docs/architecture.md` approver section: `Briefing`, `briefing.ts`, `forge-text.ts`, `describe-actions.ts`.
- [ ] **Step 3:** CHANGELOG "Unreleased": breaking `spec_gate` (briefing required for human gates) and `spec_stuck` (descriptions, rationale); added candidates, rule briefings, amendment briefing.
- [ ] **Step 4:** `bun run test` — PASS (docs only; guards against accidental edits).
- [ ] **Step 5:** Commit `docs: request briefings and the new gate presentation`.

---

## Scenario → test

**request-briefing**
- Recommended choice not offered → `tests/tools/spec-stuck.test.ts` "Recommended choice not offered" (+ unit in `briefing.test.ts`)
- Rationale missing → `tests/tools/spec-gate.test.ts` "Rationale missing"
- Summary too long → `tests/interaction/briefing.test.ts` "Summary too long" + `tests/tools/spec-question.test.ts` tool-level case
- Briefing stored with the request → `tests/interaction/forge.test.ts` "request comment round-trips the prepared record" (with briefing) + `tests/interaction/complete.test.ts` "answer comment keeps the briefing" (Task 2)
- Request without a briefing → `tests/interaction/forge-text.test.ts` "Request without a briefing" + `tests/interaction/complete.test.ts` "pre-briefing request completes" (Task 2)
- Fake marker neutralised → `tests/interaction/briefing.test.ts` + `forge-text.test.ts` "Fake marker neutralised"
- Fake command neutralised → `tests/interaction/forge-text.test.ts` "Fake command neutralised"
- Option description neutralised → `tests/tools/spec-stuck.test.ts` "Option description neutralised"
- Facts before the briefing → `tests/interaction/forge-text.test.ts`
- Rule briefing not labelled as agent → `tests/interaction/forge-text.test.ts` + `tests/tools/decide-ask.test.ts`
- Plan approve described → `tests/interaction/forge-text.test.ts`
- Waive lists the checks → `tests/interaction/forge-text.test.ts`
- Gate comment structure → `tests/interaction/forge-text.test.ts`
- Question candidates as commands → `tests/interaction/forge-text.test.ts`
- Prefilled answer parses back → `tests/interaction/forge-text.test.ts`
- Recommended entry first → `tests/interaction/in-session.test.ts`
- Briefing shown before options → `tests/interaction/in-session.test.ts` + `tests/tools/spec-gate.test.ts` "Define approved"

**approver-adapters**
- Tool has no answer parameter → `tests/tools/no-answer-params.test.ts` (unchanged)
- Relayed approval refused → `tests/tools/spec-gate.test.ts` (with fixture briefing)
- Amendment request kind → `tests/tools/unit-amend.test.ts` (unchanged)
- Decide request kind → `tests/tools/decide-ask.test.ts` (unchanged)
- Recommendation is not an answer → `tests/interaction/in-session.test.ts` + `tests/tools/spec-stuck.test.ts`
- Approve in the TUI → `tests/tools/spec-gate.test.ts` "Define approved"
- Unavailable without UI → `tests/tools/spec-gate.test.ts`
- Answer later in session → `tests/tools/spec-question.test.ts` (unchanged)
- Question candidate picked in session → `tests/interaction/in-session.test.ts`
- Own answer instead of a candidate → `tests/interaction/in-session.test.ts`
- Pending gate request → `tests/interaction/forge.test.ts`
- Duplicate request refused → `tests/interaction/forge.test.ts`

**phase-gates "Gate tool"** — existing scenarios keep their tests in `tests/tools/spec-gate.test.ts`, `spec-gate-behavior.test.ts`, `tests/evidence/red-on-base.test.ts`, `tests/tools/initiative-propose.test.ts`, `tests/tools/new-dependency.test.ts` (with fixture briefing); new:
- Human gate without a briefing → `tests/tools/spec-gate.test.ts`
- Self gate ignores the briefing → `tests/tools/spec-gate.test.ts`
- Approve not recommended while a check must be waived → `tests/tools/spec-gate.test.ts`
- Proposer briefing → `tests/tools/initiative-propose.test.ts`

**questions-and-stuck**
- Blocking by default, Non-blocking proposal → `tests/tools/spec-question.test.ts` (unchanged)
- Candidate answers sent, Too many candidates, Candidate label that cannot round-trip → `tests/tools/spec-question.test.ts`
- Stuck report waits for a choice, Option count enforced, Choice recorded → `tests/tools/spec-stuck.test.ts` (params gain descriptions and rationale)
- Option without a description, Old stuck report sent again → `tests/tools/spec-stuck.test.ts`

**decision-seam "Decision seam"** — existing scenarios unchanged in `tests/decide/seam.test.ts` and `tests/tools/decide-ask.test.ts`; new:
- Rule ask carries descriptions → `tests/docs/behavior-change.test.ts`
- Rule recommends an option it does not offer → `tests/decide/seam.test.ts`

**unit-planning "Unit amendments"** — existing scenarios unchanged in `tests/tools/unit-amend.test.ts`; new:
- Amendment with a briefing → `tests/tools/unit-amend.test.ts`
