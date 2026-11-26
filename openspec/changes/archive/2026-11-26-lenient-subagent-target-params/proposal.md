## Why

AI agents calling `subagent_dispatch`, `subagent_packet` and `subagent_record` often fill every optional parameter with `""` or with a value the chosen role does not use. Both are refused today, so a valid `scout` call launches nothing and the agent must learn by trial to omit fields. Accepting these calls, with a warning where a value is dropped, makes the first reasonable call succeed while still telling an agent that picked the wrong role.

## What Changes

**Empty target parameters**
- From: `unit`, `subject` or `finding` equal to `""` is refused as an unknown subject, a missing unit, or a finding given to another role.
- To: an empty string is treated as an omitted parameter.
- Reason: models emit `""` for optional fields.
- Impact: non-breaking; calls that were refused now run.

**Parameters the role does not take**
- From: a `subject` for a role other than `reviewer`, or a `finding` for a role other than `verifier`, is refused.
- To: the parameter is ignored, the call proceeds, and the tool result starts with a warning naming each ignored parameter and the role that takes it.
- Reason: the value is irrelevant to the run; refusing blocks the agent for no safety gain.
- Impact: non-breaking; records are the same as for a call that omitted the parameter.

**Tool guidance**
- Parameter and tool descriptions name which role takes which parameter and say to omit the others.

Unchanged: refusal of an unknown role, a reviewer without a subject or with an unknown subject, a missing unit for `implementer` or reviewer subject `unit`, a unit that does not exist, a verifier without a valid finding reference, and calls in a child session.

## Capabilities

### New Capabilities

### Modified Capabilities
- `subagent-dispatch`: the "Dispatch tool" requirement no longer refuses empty or role-inapplicable `subject`/`finding` values; it ignores them and warns.

## Impact

- `src/tools/subagent-target.ts` (`checkTarget`, `TARGET_PROPERTIES`), and the three tools that call it: `src/tools/subagent-dispatch.ts`, `src/tools/subagent-packet.ts`, `src/tools/subagent-record.ts` (descriptions and warning text in results).
- Tests: `tests/tools/subagent-dispatch.test.ts`, `tests/tools/subagent-record.test.ts`.
- Docs: `docs/architecture.md` dispatch section, `CHANGELOG.md`.
- No dependency, schema or forge record change.
