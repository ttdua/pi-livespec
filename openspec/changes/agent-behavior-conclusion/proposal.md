## Why

The `behavior-change` rule asks the human, once per capability and in a blocking dialog at `spec_gate define` and `spec_gate review`, whether code under a capability's `paths` changed behaviour while its spec did not. To answer correctly the human must read the diff, which the agent already has. In practice humans answer `unchanged` without checking. That breaks approver-adapters "Interaction contract" item 1, and the ship gate asks the same thing again as a durable-docs confirmation item. Issue #64 is a v0.1.0 defect. The fix stays inside the current gate model, so LS-12 (#58: ledger, prose gates, issue as what & why) proceeds unchanged.

## What Changes

**Who concludes on a behavior item**
- From: the `behavior-change` rule always asks a human, through the approver chain, with options `unchanged` and `changed`.
- To: the agent passes a conclusion for each behavior item in a new `behavior` parameter of `spec_gate define|review`. A conclusion is `unchanged` or `changed` plus a one-line evidence rationale. It is recorded as a `decision` ledger entry with `source: agent`. The rule never asks.
- Reason: the system has the diff, so the human must not be asked for a fact it can derive.
- Impact: breaking for callers of `spec_gate define|review` on a change with behavior items, who must now pass `behavior`. `decide:behavior-change.*` requests are no longer created. Stored human answers still count, and a request still open makes the gate refuse until it is answered or dismissed.

**Gate flow**
- From: `spec_gate` asks about unanswered items before the gate request. This is the one exception to "refuse, writing nothing".
- To: `spec_gate` validates `behavior` before any side effect and evaluates every other refusal. Only then does it append the agent's conclusions and run the checks again. A `changed` conclusion with no spec edit still refuses, naming `specs/<capability>/spec.md`.
- Impact: no dialog per capability.

**What the human sees and does**
- From: one dialog per capability, then the gate.
- To: the define gate shows a livespec prose section, "Behavior conclusions (please check)", with one line per item: capability, outcome, source and rationale. To disagree, the human requests changes at the gate with notes naming the capability. The agent then concludes again, and a `changed` conclusion requires the spec edit. `spec_gate` refuses to restate the same `unchanged` rationale for a capability the notes name, so the dispute cannot be ignored. No new answer channel, command, dialog tab or stored override is added, so LS-12c (#61) can change how gates are answered without carrying anything from this fix.
- Impact: approving stays one pick; disputing is the existing request-changes answer.

**Reviewer**
- The `change` reviewer packet gets the required source `records:behavior-conclusions`, which lists every conclusion. The rubric says a disputed conclusion is reported as a `WARNING` finding at one of the item's files. The existing blocking-finding rules then block review until the finding is fixed or rebutted, and rebuttals reach the next human gate.

**Ship durable docs**
- From: only a human `unchanged` record suppresses the capability's confirmation item.
- To: the latest conclusion counts whatever its source.

## Capabilities

### New Capabilities

### Modified Capabilities
- `durable-doc-checks`: the rule, the question at the gate and the check are replaced by agent conclusions at the gate, precedence, the check over conclusions, the reviewer packet source, and disputing at the gate.
- `phase-gates`: "Gate tool" gains the `behavior` parameter and drops the ask-before-refusal exception; "Gate review payload" gains the behavior conclusions section.
- `ship-phase`: "Durable docs rule and check" counts the latest conclusion of any source.
- `decision-seam`: "Decision records" allows source `agent` for point `behavior-change` only.
- `subagent-packets`: "Context manifest" adds `records:behavior-conclusions` to the `change` reviewer packet.

## Impact

- Code:
  - `src/docs/behavior-change.ts`, `behavior-check.ts`, `behavior-param.ts`, `behavior-record.ts`, `behavior-source.ts`, `register.ts`
  - `src/docs/behavior-ask.ts` (removed)
  - `src/tools/spec-gate.ts`, `src/tools/decide-ask.ts`
  - `src/decide/records.ts`, `src/decide/points.ts`
  - `src/ship/context.ts`
  - `src/subagents/rubrics.ts`, `src/subagents/sources.ts`, `src/subagents/packet.ts` (packet source)
- Records are ledger entries (ledger-store, ADR 0008). The forge gains only prose in the define gate request.
- Public API: the `spec_gate` tool parameters. The forge command grammar and the subagent result contract are unchanged.
- No new dependency and no data migration.
