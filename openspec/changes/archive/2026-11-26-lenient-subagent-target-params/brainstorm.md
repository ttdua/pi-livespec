## Design Summary

AI agents calling `subagent_dispatch`, `subagent_packet` and `subagent_record` often fill every optional parameter, sending `""` or a value that the chosen role does not use. Today both cases are refused, so a valid `scout` call such as `role="scout" unit="" subject="" finding=""` launches nothing (`unknown subject ""`), and the agent must learn by trial to omit fields.

This change alters the specified requirement **subagent-dispatch / "Dispatch tool"**, which today says the tool MUST refuse when "the role or subject is unknown" and when "a finding reference is given for another role". The new behaviour:

1. **Empty strings are absent.** `unit`, `subject` or `finding` equal to `""` is treated exactly as if omitted, silently.
2. **Parameters the role does not take are ignored with a warning.** A non-empty `subject` for a role other than `reviewer`, or a non-empty `finding` for a role other than `verifier`, is dropped; the call proceeds and the tool result names each ignored parameter and why (e.g. `ignored subject "spec": only reviewer takes a subject`).
3. **Parameters the role needs stay strict.** Refusal is kept for: unknown role; reviewer without a subject or with an unknown subject; a missing unit for implementer or for reviewer subject `unit`; a unit that does not exist in the change; verifier without a finding reference or with a malformed or unknown one; a child session.
4. **Guidance for agents.** Parameter descriptions and tool descriptions state which role takes which parameter and say to omit the others, so a well-behaved agent does not need the leniency.

Goals: an agent's first reasonable call succeeds; an agent that picked the wrong role learns it from the warning. Non-goals: changing roles, subjects, packet contents or record formats. Anti-goal: guessing a missing required parameter.

## Alternatives Considered

### Alternative A: Only treat `""` as absent, keep refusing inapplicable values
- **Approach**: normalise empty strings; `scout subject="spec"` still refuses.
- **Pros**: smallest spec change; a wrong-role call never runs.
- **Cons**: agents still get blocked when they pass a meaningful but unneeded value; the user explicitly wants that case ignored with a warning.
- **Why not chosen**: does not meet the user's request to warn and ignore.

### Alternative B: Only improve descriptions, keep behaviour
- **Approach**: better tool and parameter descriptions.
- **Pros**: no spec change.
- **Cons**: models still emit `""` for optional fields; the failure stays.
- **Why not chosen**: guidance alone does not prevent the observed refusals.

### Alternative C: Ignore anything inapplicable, including unknown subject values for non-reviewers, and warn
- Chosen; see Agreed Approach.

## Agreed Approach

Alternative C, as approved by the user in chat: empty strings are absent; inapplicable non-empty parameters are ignored with a warning in the tool result; required parameters stay strict; descriptions spell out the role/parameter matrix. Validation of an ignored value (e.g. whether `subject` is a known subject) is skipped for roles that do not take it, since the value is discarded.

## Key Decisions

- Applies to all three tools, which share one target check.
- Warnings are part of the returned tool text so the calling agent sees them; they are not forge records.
- A run that proceeds after ignoring parameters records the target without the ignored parameters (same records as a call that omitted them).
- Accepted risk: an agent that meant `reviewer` but sent `scout subject="spec"` gets a scout run plus a warning, instead of a refusal.

## Open Questions

None.
