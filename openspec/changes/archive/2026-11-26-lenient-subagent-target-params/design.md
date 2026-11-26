## Context

`checkTarget` in `src/tools/subagent-target.ts` validates `role`, `unit`, `subject` and `finding` for `subagent_dispatch`, `subagent_packet` and `subagent_record`, returning a `Target` or a refusal string. It treats a parameter as absent only when it is `undefined`, so `""` fails the subject, unit-existence and finding checks. The three tools return the refusal via `refusal(TOOL, message)`.

## Goals / Non-Goals

**Goals:**
- Normalise empty strings to absent before any check.
- Drop `subject` for non-reviewers and `finding` for non-verifiers, returning warnings alongside the target.
- Surface those warnings at the top of each tool's result text, success or later refusal alike.
- Spell out the role/parameter matrix in `TARGET_PROPERTIES` and tool descriptions.

**Non-Goals:**
- Changing roles, subjects, packets, records or the executor launch.
- Leniency for required parameters or for `unit` (a non-empty unit that does not exist still refuses, for every role).

## Decisions

- **Separate pre-pass.** A pure `ignoreInapplicable(p)` returns `{ params, warnings }`: it maps `""` to `undefined` for `unit`, `subject`, `finding`, and, when the role is known, drops `subject` for non-reviewers and `finding` for non-verifiers with one warning each. Each tool runs it first and wraps its whole result (success or any later refusal) with `withWarnings`, so no path loses a warning. `checkTarget` keeps its `Target | string` shape and runs on the cleaned params, which keeps the "required" refusals exactly as specified. Alternatives: returning warnings from `checkTarget` — rejected because refusals after `checkTarget` (finding lookup, packet build) would drop them; putting warnings on `Target` — rejected because `Target` flows into records and `argsOf`.
- **Unknown role.** With an unknown role nothing is dropped; `checkTarget` refuses on the role first.
- **Ignored values are not validated.** For a role that does not take `subject`/`finding`, the value is dropped before the subject-name or finding-format checks, so `scout subject="vibes"` warns rather than refusing.
- **Warning text.** One line per ignored parameter: `Warning: ignored subject "spec": only reviewer takes a subject.` / `Warning: ignored finding "c1:0": only verifier takes a finding reference.` A small `withWarnings(warnings, result)` prepends them to a `ToolResult`'s text, used by the three tools.
- **`unit` stays strict.** A non-empty `unit` is kept for every role, since `scout` and change-level reviewers accept an optional unit; only `""` is normalised.

## Risks / Trade-offs

- [An agent meant `reviewer` but sent `scout subject="spec"` and gets a scout run] → the warning names the role that takes `subject`, so the agent can re-dispatch; accepted in brainstorm.
- [Warnings get lost behind long packet text] → they are prepended, not appended.
