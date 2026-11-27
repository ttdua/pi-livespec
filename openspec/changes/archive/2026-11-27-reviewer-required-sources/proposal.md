## Why

Reviewer packets mark every source as required, including one `comment:<id>` per `decision` record and one `answer:<agentId>:<n>` per parent answer. With 60–120 required ids, reviewers leave one out of `sources_used`, the run is returned once and then recorded BLOCKED by the parent, and the `finding-summary` drops the reason. In naicoi92/iroh-tunnel#268, 10 of 23 review runs blocked this way and each passed on redispatch. Making the required list hold only what a reviewer must judge removes these false blocks, and keeping the reason makes the remaining blocks diagnosable.

## What Changes

**Reviewer manifest (subject `unit`, `change`, `persona:<name>`)**
- From: each `decision` record is a required `comment:<id>` source; each parent answer to a child is a required `answer:<agentId>:<n>` source.
- To: all `decision` records form one optional source `records:decisions`; all parent answers form one optional source `records:dispatch-answers`. Either is left out when it has no record. Every other reviewer source stays required.
- Reason: the required list must not grow with the number of records.
- Impact: non-breaking for callers; reviewer packet text and hash change. Implementer packets are unchanged.

**Optional sources in the packet and protocol**
- From: the packet does not say which sources are required; the protocol asks the child to list every source used.
- To: each optional source is marked optional in the task and spill list; the protocol asks for every required source used, and optional ones only when used. `PROTOCOL_VERSION` becomes 2.
- Impact: every packet's protocol text changes.

**Result handling**
- From: only required sources are checked (unchanged), but every reviewer source was required.
- To: an omitted optional source never returns or blocks a run; the return message and the BLOCKED reason name the omitted required ids.

**Finding summary**
- From: `finding-summary` records neither `notes`, `reason` nor `evidence` (verifier records only keep `reason`).
- To: every `finding-summary` written for a run records the run's `notes`, `reason` and `evidence` when present, so a parent-written BLOCKED names the omitted ids.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `subagent-packets`: Context manifest (grouped optional record sources for reviewers), Source ids and versions (`records:<kind>`), Packet layers (optional marking), Protocol content (`sources_used` wording).
- `subagent-dispatch`: Return contract (`sources_used` must list required sources used), Result handling (optional omission accepted; BLOCKED reason names omitted ids).
- `review-findings`: Finding summary comment (records `notes`, `reason`, `evidence`).

## Impact

- Code: `src/subagents/sources.ts`, `src/subagents/sources-records.ts`, `src/subagents/source-kit.ts`, `src/subagents/render.ts`, `src/subagents/packet.ts`, `src/subagents/protocol.ts`, `src/subagents/dispatch.ts`, `src/subagents/run-record.ts`, `src/subagents/records.ts`, `src/subagents/validate.ts`.
- Docs: `docs/architecture.md` (packet and `finding-summary` descriptions).
- Tests: `tests/subagents/sources.test.ts`, `packet.test.ts`, `protocol.test.ts`, `dispatch.test.ts`, `records.test.ts`, and a #268-shaped review fixture.
- No new dependency, no forge schema migration (new `finding-summary` fields are optional).
