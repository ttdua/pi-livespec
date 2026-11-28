## Why

The `behavior-change` rule asks the human, once per capability and in a blocking dialog at `spec_gate define` and `spec_gate review`, whether code under a capability's `paths` changed behaviour while its spec did not. Answering correctly means reading the diff, which the agent already has and which the reviewer reads at review. Humans answer `unchanged` without checking. That breaks approver-adapters "Interaction contract" item 1, and the ship gate asks the same thing again as a durable-docs confirmation item. Issue #64.

## What Changes

**Who concludes on a behavior item**
- From: the `behavior-change` rule always asks a human, through the approver chain, with options `unchanged` and `changed`.
- To: the agent passes a conclusion (`unchanged` or `changed`, plus a one-line evidence rationale) for each behavior item in a new `behavior` parameter of `spec_gate define|review`. The conclusion is recorded as a `decision` with `source: agent`. A completed reviewer run MAY record its own conclusion (`source: reviewer`). The rule never asks.
- Reason: the system has the diff, so the human must not be asked for a fact it can derive.
- Impact: breaking for callers of `spec_gate define|review` on a change with behavior items: they must pass `behavior`. `decide:behavior-change.*` requests are no longer created; stored ones are still read.

**Gate flow**
- From: `spec_gate` asks unanswered items before the gate request; this is the one exception to "refuse, writing nothing".
- To: `spec_gate` validates `behavior` before running checks, evaluates every other refusal, then writes the agent's conclusion records and runs the checks again. A `changed` conclusion with no spec edit still refuses, naming `specs/<capability>/spec.md`.
- Impact: no dialog per capability.

**What the human sees and can do**
- From: one dialog per capability, then the gate.
- To: the define gate payload lists, under a livespec section "Behavior conclusions (please check)", one line per item: the capability, the outcome, the source and the rationale. To disagree, the human requests changes with a behavior override: the dialog's Behavior tab, or the forge command `/livespec set behavior <capability> changed`. The override records `changed` with `source: human`.
- Impact: approving stays one pick; flipping is optional.

**Precedence**
- The latest record for the item wins, except that an agent record never replaces a reviewer or human `changed`, and a reviewer record never replaces a human `changed`.

**Ship durable docs**
- From: only a human `unchanged` record suppresses the capability's confirmation item.
- To: the effective conclusion counts whatever its source.

## Capabilities

### New Capabilities

### Modified Capabilities
- `durable-doc-checks`: the Behavior change rule, the question at the gate (replaced by the agent conclusion at the gate), the check, plus new requirements for precedence, reviewer conclusions and the human override.
- `phase-gates`: "Gate tool" gains the `behavior` parameter and drops the ask-before-refusal exception; "Gate review payload" gains the behavior conclusions section.
- `ship-phase`: "Durable docs rule and check" counts the effective conclusion of any source.
- `decision-seam`: "Decision records" allows sources `agent` and `reviewer` for point `behavior-change`.
- `approver-adapters`: "Forge command comments" gains `set behavior`; "In-session dialog" gains the Behavior tab; a new requirement covers behavior overrides.
- `subagent-dispatch`: "Return contract" lets `reviewer` results carry `behavior` conclusions.
- `subagent-packets`: "Context manifest" adds `records:behavior-conclusions` to the `change` reviewer packet.
- `request-briefing`: "Forge request text" lists `set behavior` among the accepted commands of a define gate with behavior items.

## Impact

- Code: `src/docs/behavior-change.ts`, `src/docs/behavior-ask.ts` (removed), `src/docs/behavior-check.ts`, `src/docs/register.ts`, `src/tools/spec-gate.ts`, `src/tools/decide-ask.ts`, `src/decide/records.ts`, `src/ship/context.ts` and the durable-docs rule, `src/subagents/roles.ts` and `run-record.ts`, `src/interaction/commands.ts`, `forge-match.ts`, `forge-text.ts`, `approver.ts`, `complete-gate.ts`, `dialog/*`.
- Public API: the `spec_gate` tool parameters, the forge command grammar (additive), and the reviewer result schema (additive, optional field).
- No new dependency and no data migration: old human records stay valid.
