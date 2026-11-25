## Why

Durable docs rot quietly: a living spec that no longer matches the code misleads every later change, and today only the ship-time `durable-docs` table guards them. Behavior questions are asked late (at ship), `product.md` and the glossary have no define-time trigger, and drift from commits made outside livespec is never found. LS-10 (issue #10) gives each durable file a hard trigger and a check, feeds the content to the agents that need it, and adds a read-only drift audit.

## What Changes

- New define-time checks: `product-impact` (blocks the define gate on a missing or invalid `Product impact` line, and on `none` with a `new` capability), `glossary-terms` (a warning listing new bold terms and proper nouns in requirement text), and `behavior-change` (asks the human once, per capability, whether behavior changed when code under its `paths` changed and its spec did not; the answer is a `source: human` decision record).
- **Ship `durable-docs` confirmation**
  - From: code under a capability's `paths` with no `updated` spec row always raises a confirmation item at the ship gate.
  - To: when the capability's latest human `behavior-change` record is `unchanged` and its files cover the changed files, no item; otherwise the item stays.
  - Reason: the human answers the behavior question once, at define or review.
  - Impact: non-breaking; fewer ship-gate confirmations.
- Packet readers: implementer and reviewer packets gain glossary entries for terms that appear in the unit or units, decisions with `spine: true`, and decisions tagged with a capability of the change; reviewer packets gain `specs/constraints.md`.
- `/livespec audit`: a read-only command that audits the fetched integration branch and finds drift (untested scenarios, removed references, dead `paths` globs, unused glossary terms, superseded decisions cited as current, capabilities missing from `product.md`, re-checked `declared-none` fix pull requests), lets a scout confirm the heuristic items, classifies every item with the new `drift-severity` rule, and posts a `drift-report` comment on the initiative or prints the report.
- Audit suggestions: the card suggests `/livespec audit` after an initiative closes and when the integration branch has commits under a capability's `paths` that did not come through a livespec or fix pull request.
- The default flow pack gains the new checks in `define` and `review` and the `behavior-change` and `drift-severity` decision points.

## Capabilities

### New Capabilities
- `durable-doc-checks`: the `product-impact`, `glossary-terms` and `behavior-change` checks, the `behavior-change` rule and its human question at the define and review gates, and the define gate payload additions.
- `drift-audit`: `/livespec audit`, its detectors, the scout confirmation, the `drift-severity` rule, the `drift-report` marker kind and output, and the audit suggestions on the card.

### Modified Capabilities
- `ship-phase`: "Durable docs rule and check" reads the `behavior-change` record instead of always raising a capability confirmation item.
- `subagent-packets`: "Context manifest" adds glossary, spine-decision and capability-decision sources, and constraints for reviewers.
- `subagent-dispatch`: "Return contract" lets a scout return `verdicts`; "Effort and model", "Launch options", "Inline fallback" and "Dispatch record" define the audit scout's exceptions (thinking `low`, a worktree of the audited commit as `cwd`, no inline run, no `dispatch` comment).
- `phase-gates`: "Gate tool" allows the behavior question's writes before a refusal caused only by `behavior-change`.
- `decision-seam`: "Decision records" keeps a `behavior-change` record's `files` when its facts are hashed.
- `flow-pack`: "Default flow pack" lists the new checks and decision points.
- `init-and-doctor`: "Subcommand routing" adds `audit`.

## Impact

- Code: new `src/docs/` (define checks, behavior-change rule, packet readers) and `src/audit/` (detectors, scout run, severity rule, report, suggestions); edits in `src/ship/durable-docs.ts`, `src/subagents/sources*.ts`, `src/subagents/roles.ts`, `src/tools/spec-gate.ts`, `src/engine/gate-payload.ts`, `src/extension.ts`, `src/commands/`, `src/hooks/session.ts`, `src/packs/agent-skills.yaml` and the pack fixture.
- Forge: one new own-marker kind `drift-report`, written only on an initiative issue; read-only use of merged pull requests at session start and in the audit.
- Local state: `<git common dir>/livespec/audit.json` holds the commit cursor, the fix cursor, the last audited commit and the pending suggestions.
- Docs: `docs/architecture.md` (durable docs and audit), `docs/glossary.md` (drift report).
- No new dependency, no forge schema change.
