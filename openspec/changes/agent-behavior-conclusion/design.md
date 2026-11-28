## Context

Issue #64 is a v0.1.0 defect, and the fix must not move the forge surface ahead of LS-12 (#58). The ledger (#59) is merged, and prose gates answered by reaction (#61) and the issue body as what & why (#62) come next. Anything this fix adds to forge comments, gate answers or the issue body would have to be carried or undone by those parts. So the fix adds:
- ledger entries,
- prose in the define gate request,
- one parameter on `spec_gate`,

and nothing else on the forge.

Before this change, a behavior item was resolved only by a human answer to a `decide:behavior-change.<capability>` rule ask, sent by `askBehaviorChanges` (`src/docs/behavior-ask.ts`) from `behaviorStep` in `src/tools/spec-gate.ts`. The check, ship (`latestBehaviorRecords`) and the asker's reuse each read those human records.

## Goals / Non-Goals

**Goals:**
- No question to the human that the diff answers (Interaction contract item 1).
- One conclusion resolver shared by the check, the gate payload, the reviewer packet and ship.
- Human answers to old `decide:behavior-change` requests keep working.

**Non-Goals:**
- A structured human override. The human disputes through the existing request-changes answer, and how gates are answered is #61's job.
- A structured reviewer verdict. The reviewer disputes through the existing blocking findings.
- Verifying the rationale's truth in code.
- Behaviour conclusions on the fix lane.

## Decisions

**D1. One resolver.** `effectiveConclusion(marked, item)` and `latestConclusions(marked)` are pure functions in `src/docs/behavior-change.ts`. They read valid `behavior-change` decision records whose outcome is `unchanged` or `changed`, with source `agent` or `human` (legacy answers). Human records only count when `isBacked`, as on main.
- Candidates are the records with the item's digest and facts, plus human `changed` records whose `files` intersect the item's.
- The latest candidate wins, except that an agent record never replaces a human `changed`.
- `latestConclusions` applies the same order over all digests, for ship's superset test.
- Rejected alternative: per-caller source filters. That would duplicate the precedence rule in four places.

**D2. Disputes go through the existing answers.**
- **Human.** The human requests changes at the define gate with notes naming the capability. On the next call the agent concludes again, and the latest agent record wins over its earlier one. So `changed` then requires the spec edit.
- **Reviewer.** The reviewer reports a `WARNING` finding at one of the item's files. review-findings "Blocking findings" then blocks review until the finding is fixed or rebutted, and a rebuttal is listed at the next human gate.
- Why: every human answer stays a gate answer, which #61 will reshape, and every reviewer output stays a finding. This change adds no new authority path for #61 to migrate.
- Rejected alternative: structured overrides, meaning `Answered.behaviorOverrides`, a dialog tab, a forge command and an extended `isBacked`. That would store machine state in forge YAML that #61 is removing.
- Rejected alternative: a `behavior` field on reviewer results. That would grow the subagent contract for what a finding already expresses.

**D3. `behavior` parameter on `spec_gate`.** The shape is `behavior?: { capability: string; outcome: "unchanged" | "changed"; rationale: string }[]`. The rationale is one line of at most 300 code points, and it is neutralised as agent text. Validation runs in two steps:
- Shape, before any side effect (cascade, checks, writes).
- Coverage, after the other refusals, and only when the target phase lists the check. Every current item must be listed, and no other capability. An equal conclusion is not appended again: same digest, outcome and reason as the latest agent record.

Rejected alternative: a separate tool. It adds a step the agent can forget.

**D4. Write ordering keeps "refuse, writing nothing".** `behaviorStep` works in this order:
1. Evaluate refusals without the `behavior-change` results, and the plan and recommendation refusals.
2. Refuse while a legacy `decide:behavior-change` request is open for a current item. Otherwise #80 would mask it behind a new gate.
3. Append agent entries.
4. Refresh, then re-run the checks.

`behavior-ask.ts` is deleted. The rule stays registered and returns `{ outcome: null }`, so existing packs validate.

**D5. Record shape.** A record is `{ point: behavior-change, subject, source: agent, outcome, reason, facts, digest, files }`, written as a ledger entry through `appendRecord`. `validDecisions` accepts `agent` only for point `behavior-change`, so an agent cannot forge any other decision. `BEHAVIOR_POINT` lives in the leaf module `src/decide/points.ts`.

**D6. Reviewer packet.** The `change` reviewer packet gets the required source `records:behavior-conclusions`, one line per item. The provider lives in `src/docs/behavior-source.ts` and is registered from `docs/readers.ts`, so `subagents/` does not import `docs/`. The `change` rubric (`src/subagents/rubrics.ts`) adds one sentence telling the reviewer to report a disputed conclusion as a `WARNING` finding at one of the item's files. Nothing goes on `Packet`, and the result schema does not change.

**D7. Gate payload section.** `registerGatePayload("define", …)` adds `Behavior conclusions (please check):` with one line per item: `- <capability>: <outcome> (<source>) — <rationale>; files: <n>`. It is livespec prose, placed with the facts before the briefing. The items reach the payload through the optional `ReviewFacts.behaviorItems`, which is set only for `define`.

**D8. Ship.** `durable-docs` reads `latestConclusions`, so an `unchanged` conclusion that covers the files removes the confirmation item.

**D9. Agent guidance.** pi-livespec runs the agent-skills workflow and does not change its content. The `spec_gate` parameter description and the refusal text guide the agent. The refusal names every missing capability and the expected shape.

## Risks / Trade-offs

- [The agent writes `unchanged` by reflex] → The rationale is required and shown at the gate. The `change` reviewer sees every conclusion as a required source, and its rubric asks for a blocking finding when it disagrees.
- [A dispute costs one extra round: request changes, then the agent concludes again] → Accepted. The cost is the same as any other spec correction, and it keeps the gate answer model untouched for #61.
- [A reviewer dispute can be rebutted without a spec edit] → Accepted. Rebuttals are listed at the next human gate, as for every other finding.
- [Breaking `spec_gate` for in-flight changes] → The refusal says exactly what to pass.

## Migration Plan

No data migration. Answered legacy requests resolve their items as human conclusions, and an open one makes the gate refuse until it is answered or dismissed. Main ignores comment-based human records written before the ledger (ADR 0008, no dual read). Rollback is a revert. Agent records are then invalid decisions, and the items re-open as unanswered.

## Open Questions

None.
