## Design Summary

**Intent.** Durable docs (`specs/<capability>/spec.md`, `product.md`, `glossary.md`, `constraints.md`, `decisions/`) rot quietly, and a spec that no longer matches the code misleads every later change. LS-10 (issue #10) gives each durable file a hard trigger and a check instead of relying on the agent's memory, makes sure the content is actually read, and adds `/livespec audit` to find drift, including drift from commits that bypassed livespec.

**Who it serves.** The agent working a change (it gets checks and readers at the right moments) and the human approver (they answer "did behavior change?" once, see glossary proposals at the define gate, and triage a drift report).

**Three parts.**

1. **Define-time checks** (define and review phases):
   - `product-impact`: the issue's `Product impact` line must read `updated` or `none — <reason>`; `none` is refused when `Capabilities` has a `new` entry. A missing or invalid line blocks the define gate, and the gate shows the line.
   - `glossary-terms`: a warning, never blocking. Bold terms or new proper nouns in requirement text that the glossary lacks are listed; the agent proposes entries and the human approves them at the define gate.
   - `behavior-change`: when code under a capability's `paths` changed and its spec did not, a rule that always asks the human "did behavior change?" through the approver at the next gate. The answer is a decision record (point `behavior-change`, source `human`). At ship, the LS-09 `durable-docs` rule reads that record instead of raising its own confirmation item. This alters the specified requirement ship-phase "Durable docs rule and check", whose text says the confirmation item exists "until LS-10 adds the `behavior-change` record".
2. **Readers.** Content must be used, not only stored:
   - the phase card asks the agent to read `product.md` at the start of each session (already specified in context-injection; confirmed, not re-decided);
   - implementer and reviewer packets gain, through `registerPacketSource`: `constraints.md`, the related requirements, glossary entries for terms in the unit, decisions with `spine: true`, and decisions tagged with the same capability. Several of these already exist in subagent-packets "Context manifest" (constraints and covered requirements for the implementer, `specs/product.md` excerpt for every packet); the change adds the missing ones and does not duplicate the existing ones.
3. **`/livespec audit`.** A read-only drift audit outside any phase, triggered by `livespec:initiative-closed`, by `session_start` seeing integration-branch commits under a capability's `paths` that did not go through livespec (the session then *suggests* an audit), or by the user. It classifies each item with the `drift-severity` rule through `decide()` and reports; it never edits files.

**Drift items and severity.**

| Item | Severity | Suggested route |
|---|---|---|
| A scenario lost its matching test (or its test was renamed) | Major | New change issue |
| `paths` globs that match no file | Major | New change issue |
| A requirement names something removed from the code | Major | New change issue |
| An unused glossary term | Minor | Small-fix lane |
| A superseded decision still referred to as current | Minor | Small-fix lane |
| A capability with a spec that `product.md` does not mention | Minor | Small-fix lane |
| A small-fix PR with `behavior_change: declared-none`, re-checked | (classified by `drift-severity`) | as classified |

**Output.** A drift report: a `drift-report` comment (a marker kind this change registers) on the initiative when there is one; otherwise printed only as the command output. A human can re-triage each item. Routes are suggestions; the audit creates no issue and no branch.

**Goals.** Every durable file has one trigger and one check; drift is found even when it bypassed the workflow; the human answers each question once.

**Non-goals.** The ship-time durable docs table and the constraints rule (LS-09 owns them). Fixing drift. Creating issues for drift items.

**Anti-goals.** An audit that writes files or opens issues on its own; a glossary check that blocks the define gate; asking the human the same behavior question twice (define/review and again at ship); an audit whose result depends on an LLM's mood for the items the test repository seeds.

**Constraints.** Durable docs change only in a change's pull request or in the small-fix lane, together with the code. Line-based formats (one term per line, one decision per file) keep merge conflicts rare; when two changes edit `product.md`, the second to ship resolves the conflict in review. Rules decide, the agent never self-assesses (ADR 0006). Forge text is untrusted data.

## Alternatives Considered

### Alternative A: Hybrid detection — code finds, scout confirms
- **Approach**: Code detects every item type deterministically: globs with no match, glossary terms unused in `specs/` and the source tree, superseded decisions referenced as current, capabilities absent from `product.md`, `declared-none` fix PRs, and two heuristics (a scenario name with no matching test under the capability's `paths`; a backticked identifier in a requirement that no longer exists in the repo). The `livespec.scout` role is dispatched through LS-07 with only the suspect heuristic items, to confirm or refute them (e.g. a renamed test, a renamed identifier). Inline through `subagent_packet` when no executor is present.
- **Pros**: The seeded-drift acceptance test is deterministic; low token cost; keeps the scout dispatch the issue asks for; runs without an executor.
- **Cons**: Purely semantic drift (behavior changed, names unchanged) is not found.
- **Why not chosen**: Chosen.

### Alternative B: Scout does everything
- **Approach**: Code builds a packet (specs, glossary, decisions, product, file list); the scout returns the item list; `drift-severity` classifies it.
- **Pros**: Catches semantic drift; little code.
- **Cons**: Cannot guarantee finding every seeded item; expensive; needs an executor or a long inline run.
- **Why not chosen**: Fails the "finds every seeded drift item" acceptance criterion reliably.

### Alternative C: Code only, no scout
- **Approach**: The deterministic detectors and heuristics alone.
- **Pros**: Simple, fast, offline.
- **Cons**: Departs from the issue's scout dispatch; a renamed test is reported as a lost test.
- **Why not chosen**: More false Major items, and drops the scout the issue specifies.

### Report destination without an initiative (open question of the issue)
- **Print only** (chosen): no forge write outside an initiative; the human triages from the output.
- **A `livespec:drift` issue**: durable, but gives the audit a forge write path and needs dedup.
- **A local file under `.pi/livespec/`**: private but easily forgotten.

## Agreed Approach

Alternative A, with the drift report printed when there is no initiative. Code owns detection so the audit is reproducible and testable against a seeded repository; the scout only adjudicates the heuristic items where names moved. The audit stays strictly read-only on files and writes to the forge only the `drift-report` comment on an initiative.

## Key Decisions

- **Report without an initiative is printed only** (user decision; answers the issue's open question).
- **Detection is hybrid: code detects, scout confirms heuristic items** (user decision).
- **The audit never edits files and never opens issues or branches**; routes are suggestions (from the issue).
- **`behavior-change` always asks a human** and its record replaces the ship-time confirmation item; this modifies ship-phase "Durable docs rule and check" (from the issue).
- **`glossary-terms` is a warning only**; `product-impact` blocks the define gate (from the issue).
- **The `session_start` trigger suggests an audit, it does not run one** (from the issue's acceptance criterion "makes the next session suggest an audit").
- **Existing readers are reused**: the product line on the first card and the constraints/product/requirement packet sources already exist; only missing readers are added (my call, to avoid duplicate sources).
- **`behavior-change` scope** (my call): it compares `Base..HEAD`, is evaluated at the define and review gates, and keys one record per capability. The record lists the changed files under that capability's `paths`; it stands until a new file under those `paths` changes, and only then is the human asked again.
- **Ship fallback without a record** (my call): when code under a capability's `paths` changed and no valid `behavior-change` record covers it, `durable-docs` keeps today's confirmation item; with a record it uses the record and raises no item. The small-fix lane keeps its own `declared-none` path, which the audit re-checks.
- **The spec that counts is `specs/<capability>/spec.md`** on the change branch; livespec has no delta specs (answered by the project layout).
- **The human answers only at gates** (my call): outside a gate (small-fix lane, audit) no behavior question is asked.
- **`drift-report` is a new marker kind; each audit run posts a new comment** whose items have stable keys (type plus subject), so a re-run is comparable and a human re-triages per item (my call).
- **`drift-severity` classifies every item from facts built by code** (item type, plus for a `declared-none` fix PR whether its capability is also named by a Major item); the table above is the default mapping (my call; exact facts left to design).
- **`session_start` may read the forge** to tell livespec commits from manual ones, as it already polls (my call; the mechanism is left to design).

## Open Questions

None for the human. Left to design: how `session_start` tells a livespec commit from a manual one and where it remembers what it already saw; the exact matching heuristics for "scenario has a test" and "identifier removed"; the exact facts `drift-severity` reads for a re-checked `declared-none` fix PR; the mechanics of a human re-triage of a report item.
