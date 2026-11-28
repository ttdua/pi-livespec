## Context

Today a behavior item is resolved only by a human answer to a `decide:behavior-change.<capability>` rule ask, sent by `askBehaviorChanges` (`src/docs/behavior-ask.ts`) from `behaviorStep` in `src/tools/spec-gate.ts`. Three readers consume the human records:
- the `behavior-change` check (`behaviorResults` via `behaviorAnswer` → `reusableAnswer`, which accepts only `source: human`);
- the ship durable-docs facts (`latestBehaviorRecords` in `src/docs/behavior-change.ts`, used by `src/ship/context.ts`, again `source: human` only);
- the asker's reuse (`src/tools/decide-ask.ts`).

The `review` phase gate is `self` in the default pack; `define` is `human`. Unit overrides are the existing pattern for a human adjusting a system-derived value at a gate: `Override` on `Answered` (`src/interaction/approver.ts`), the forge `set U<n> …` command (`commands.ts`, `forge-match.ts`), the dialog's opt-in units tab (`dialog/model.ts`, `state.ts`), and `applyOverrides` (`complete-overrides.ts`), run from `complete-gate.ts`.

## Goals / Non-Goals

**Goals:**
- One conclusion resolver shared by the check, the gate payload and ship.
- Overrides reuse the unit-override plumbing instead of a parallel path.
- Old records (`source: human`, outcome `unchanged`/`changed`) keep working.

**Non-Goals:**
- Verifying the rationale's truth in code. That is the reviewer's job.
- Behaviour conclusions on the fix lane (`small-fix-lane` "Declared no behavior change" stays as is).

## Decisions

**D1. One resolver: `effectiveConclusion(marked, item)`.** It is pure, in `src/docs/behavior-change.ts`. It reads the valid `behavior-change` decision records for `item.capability` (sources `agent`, `reviewer` or `human`, outcome `unchanged` or `changed`). The candidates are those whose digest equals `behaviorDigest(item.files)` and whose facts equal the item, plus every human or reviewer `changed` record whose `files` intersect the item's. Without the second set, touching one more file would change the digest and silently drop a human's `changed`. It returns the winner by precedence: the latest record, except that an agent record does not displace an earlier reviewer or human `changed`, and a reviewer record does not displace an earlier human `changed`. Rejected alternative: keep `reusableAnswer` and add source filters at each caller. That would duplicate precedence in three places.
- Ship needs "covers the files" (a superset across diffs), not digest equality. So D1 exports a second function, `latestConclusions(marked)`: per capability, it returns the winning record by the same precedence over all digests. It replaces `latestBehaviorRecords`. The ship rule keeps its superset test.

**D2. Rank is an ordering, not a lock.** Rank: human `changed` = 3, reviewer `changed` = 2, otherwise 1. A newer record wins unless the current winner has a higher rank. Two consequences follow:
- A human `unchanged`, from an older record, can be replaced by a newer agent `changed`. Only `changed` is protected.
- New files change the digest, so a fresh agent conclusion is needed for them. A protected `changed` survives through the file-intersection candidates of D1.
- An old human dismissal (outcome `null`) is not a candidate, so it no longer hides an older `unchanged` at ship. This only affects data written before this change, and is accepted.
- A pending pre-change `decide:behavior-change` request answered late is a human record: a late `changed` ranks 3; a late `unchanged` replaces an agent record of rank 1, like any newer rank-1 record. Accepted: it is still a human authority answer.

**D3. `behavior` parameter on `spec_gate`.** Shape: `behavior?: { capability: string; outcome: "unchanged" | "changed"; rationale: string }[]`. The rationale is one line of at most 300 code points, has no blank line, and is neutralised as untrusted agent text (request-briefing "Agent text is untrusted"). It is validated in two steps:
- Shape, together with `briefingStep`, before any check runs.
- Coverage, after the refusals without `behavior-change`, only when the target phase lists the `behavior-change` check. Every current item MUST be listed and no other capability MAY be. The list is required whenever there is an item, so the agent restates its conclusion each time. An equal conclusion is not re-posted: same digest, outcome and rationale as the latest agent record. Rejected alternative: require it only for items without an effective conclusion. The agent would then have to compute which items those are, which is a derivable fact.

Self gate `review` accepts the parameter too. For any other target its shape is still validated, which differs from a self gate's `briefing`: a malformed `behavior` is a caller bug and is cheap to reject, while it is otherwise ignored. Rejected alternative: a separate `behavior_conclude` tool. That adds a step the agent can forget, while the gate is where coverage is enforced anyway.

**D4. Write ordering keeps "refuse, writing nothing".** `behaviorStep` keeps its shape. It runs the gate checks, computes refusals with `behavior-change` left out, refuses if any apply, and validates coverage (refusing names the missing or extra capability). Then it posts one `decision` comment per conclusion that differs from the latest agent record for that digest, refreshes the state when anything was posted, and lets the caller re-run the full checks. A `changed` conclusion then fails `behavior-change` exactly as before. `behavior-ask.ts` is deleted, and `behaviorChangeRule` returns `{ outcome: null, reason }` for a direct `decide` call. The rule stays registered so `decisions.behavior-change: { mode: rule }` in existing packs still validates. Rejected alternative: unregister the point. That would break existing pack files.

**D5. Record shape.** `{ point: behavior-change, subject: <capability>, source: agent|reviewer|human, outcome, reason: <rationale>, facts: <item>, digest, files }`. `DecisionRecord.source` widens to `"rule" | "human" | "agent" | "reviewer"`. `validDecisions` accepts `agent` and `reviewer` only for point `behavior-change`; any other point with those sources is invalid, so other rules cannot be forged by agents. `reusableAnswer` keeps requiring `human`, so the decision seam reuse is unchanged.

**D6. Reviewer conclusions.** The reviewer result schema gains an optional `behavior` array with the same item shape as D3. The packet of the `change` subject gets a required source `records:behavior-conclusions`, listing the items and their effective conclusions, so the reviewer sees what to confirm. The same data rides on `Packet.behavior`, because the packet is the only state that reaches result interpretation and recording on every path (dispatch, answer and inline). Right after `recordResult` (in `dispatch.ts` `finish` and in `subagent_record`), a separate module posts, only for a completed non-advisory `change`-subject run, one `decision` record with `source: reviewer` per listed conclusion that differs from the effective one. A reviewer `changed` over an `unchanged` blocks through the `behavior-change` check (the effective outcome is now `changed`, with no spec edit). It also MUST come with a blocking finding, enforced in result validation: a reviewer `behavior` item with outcome `changed` that disagrees with the effective conclusion requires at least one `WARNING` or `CRITICAL` finding whose location is one of the item's files; otherwise the result is returned to the child. Rejected alternative: infer a dispute from findings text. That cannot be parsed reliably.

**D7. Human override = `BehaviorOverride` on `Answered`.** `Answered.behaviorOverrides?: { capability: string; outcome: "changed" }[]`. It is valid only with `changes_requested`, which is the reverse of unit overrides, accepted only with approval. The stored `GateSnapshot.behavior` holds the items (capability, files, current outcome), set only for `gate:define`. The forge reader and completion read only stored request data, which is why the items live there. The adapters get `overridableBehavior` derived from it.
- Forge: `/livespec set behavior <capability> changed` collects like `set U<n>`; an unknown capability gets a card warning. Collected overrides attach to a later `/livespec changes …`. With approve they are discarded, and the card warns.
- Dialog: a `b` key on the Decision tab opens a Behavior tab, mirroring `u`. The Review tab shows the overrides, and shows them as discarded when the pick is not request changes.
- Completion: `complete-gate.ts` runs `applyBehaviorOverrides(run, answer)` when the outcome is `changes_requested` and the record is not superseded, beside `writeStale` and before the `gate` comment. It is idempotent by `overridden_by: { by, at }` (the record also holds `from`, the previous effective outcome), and posts `source: human`, outcome `changed`, the current item's facts, digest and files, and reason `set by <by> at the gate`. The `stale` comment follows as today.

Rejected alternative: allow the override with approve. Approve then contradicts a refusing check, and the human would approve something the gate cannot pass.

**D8. Gate payload section.** `registerGatePayload("define", …)` in `src/docs/register.ts` adds a section `Behavior conclusions (please check):`. Each item gets one line, `- <capability>: <outcome> (<source>) — <rationale>; files: <n>`. The rationale is neutralised. Livespec builds this section, so it sits in the facts, before the agent briefing. The ship durable-docs section loses the per-capability confirmation item whenever an `unchanged` conclusion covers the files.

**D9. Agent guidance.** pi-livespec is the runtime for the agent-skills workflow and does not change agent-skills content. The `spec_gate` parameter description and its refusal text guide the agent: the refusal names every missing capability and the expected shape.

## Risks / Trade-offs

- [The agent writes `unchanged` by reflex, the same failure moved from human to agent] → The rationale is required and shown to the human. The `change` reviewer gets the conclusions as a required source and can flip them with a blocking finding. That is a second, evidence-backed opinion, which the old flow never had.
- [Breaking `spec_gate` for in-flight changes] → The refusal says exactly what to pass. Old human records still resolve items, so changes already answered need nothing new unless their files changed.
- [Widening `source` could let agents forge other decisions] → D5 restricts `agent` and `reviewer` to point `behavior-change`.
- [Reviewer-to-finding link validated by location only] → Accepted. The parent can still rebut the finding, but rebutting it does not delete the reviewer record; only a spec edit clears a reviewer `changed` (scenario "Rebuttal does not clear a dispute").
- [A wrong reviewer `changed` forces a spec edit, and the human cannot override it back to `unchanged`] → Accepted for this change: the agreed override only flips to `changed`. A spec edit that only clarifies is cheap. Revisit if it hurts in practice.

## Migration Plan

No data migration. Stored `decide:behavior-change.*` requests that are still pending complete as before: their answer posts a human record, which D1 reads. Rollback is reverting the commit. Records with `agent`/`reviewer` sources are then ignored as invalid decisions, which re-opens the items as unanswered.

## Open Questions

None.
