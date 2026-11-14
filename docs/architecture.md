# Architecture

This is an overview. The detailed behavior of each part is defined by its spec issue (see the [roadmap](roadmap.md)) and, once built, by `openspec/specs/`.

## Modules

```text
┌──────────────────────────── pi extension (TypeScript) ────────────────────────────┐
│ core/        parsers and validators: living spec, change issue body, units,       │
│              decisions, glossary · unit digest · byte-preserving tick              │
│ engine/      flow pack loader · state machine · next step · loop counters         │
│ decide/      decision seam, rules and decision records                            │
│ forge/       Forge interface · GitHub adapter (gh) · Gitea adapter (REST)         │
│              · cache with version · comment markers · read-only mode              │
│ interaction/ Approver interface and adapters (gates, questions, stuck reports)    │
│ tools/       spec_status · spec_next · spec_validate · spec_write · spec_gate ·  │
│              spec_question · spec_stuck · plan_units · unit_amend · unit_start · │
│              unit_finish · change_new · change_start · change_split ·            │
│              change_ship · change_push · change_close · change_resume ·          │
│              initiative_propose · docs_table · fix_start · fix_ship ·            │
│              subagent_packet · forge_read                                        │
│ hooks/       context (routing note + phase card) · tool_call guard ·              │
│              agent_before_settle · session_start (doctor + resume)                │
│ subagent/    role dispatch · context packets · parallel lanes                     │
│ content/     agent-skills clone: install, upgrade, lock, pin, rollback            │
│ packs/       agent-skills.yaml (default flow pack)                                │
└───────────────────────────────────────────────────────────────────────────────────┘
      │ resources_discover → skill paths    │ issues, comments, PRs       │ read/write
      ▼                                     ▼                             ▼
 ~/.pi/agent/livespec/agent-skills/     GitHub / Gitea              specs/ + git
```

## Where data lives

**In the repository** (durable and small, reviewed in pull requests):

```text
specs/
├── product.md                 # mental model and 2–3 main flows
├── glossary.md                # shared terms, one per line
├── constraints.md             # quality bar
├── decisions/NNNN-<slug>.md   # decision records
├── bare-work.md               # debt log for work done outside any change
└── <capability>/spec.md       # living spec, edited in place
.pi/livespec/flow.yaml         # optional project override of the flow pack
.pi/livespec/config.yaml       # optional project config
```

**On the forge** (source of truth for work in progress):

| Object | On the forge | Content |
|---|---|---|
| Initiative | Tracking issue, label `livespec:initiative` | Goal, capabilities, the list of change issues with `Depends` |
| Change | Issue, labels `livespec` and `livespec:phase/<phase>` | Ownership lines, capabilities, proposal, design, questions, units, durable docs table |
| Receipt | Tool-written comment on the change issue | Verify command, pre and post SHA with exit codes, output, unit digest |
| Gate decision, amendment, counter, decision record | Tool-written comments | Who approved and when, outcome, locked digests, counter values |
| Code and spec diff | One pull request that references the issue (`Refs #<change>`); the issue is closed by a tool after merge | Unit commits and `specs/` edits |
| Review findings | Pull request review comments, plus a summary comment on the issue | Severity, location, evidence, fix, scope |

**Local, and only a cache:** `~/.pi/agent/livespec/` holds the agent-skills clone, user config and an issue cache. Deleting the cache loses nothing.

**Forge writes are checked by version.** Every issue, pull request and comment the `Forge` returns carries an opaque `version`, and a body edit passes the version the caller read. A stale edit returns a conflict and writes nothing. The mechanism differs by adapter ([ADR 0007](decisions/0007-forge-concurrency-by-adapter.md)): Gitea uses `content_version` when the server sends it, GitHub (and Gitea without that field) re-reads and compares. When the forge cannot be reached, reads come from the cache marked stale and writes are refused.

## Phase flow

```text
            ┌──────── changes requested ────────┐
define ──gate──► plan ──gate──► build ──► review ──► ship ──► close
  ▲               ▲   ▲          │  ▲       │  ▲       │
  │               │   │  attempts│  │rebuild│  │ CI/PR │
  │      re-plan ─┘   └─ new unit┘  └───────┘  └───────┘
  └──── an answer that changes a requirement
```

- `shape` comes first. It clarifies the intent and may split the work into an initiative of several changes.
- The **small-fix lane** skips the ceremony: on a `fix/<slug>` branch it edits code, tests and the living spec directly, with no issue, and ships one pull request. A post-check moves the work into a full change when the fix turns out not to be small.
- Every loop has a cap. Reaching a cap stops the work and sends a stuck report to the human.

## Principles

- **The parent owns the evidence.** The main session runs `Verify` and posts receipts. Subagents only implement and commit ([ADR 0003](decisions/0003-parent-owned-evidence.md)).
- **Only plugin tools write to the forge or push.** A `tool_call` guard blocks direct forge writes and direct pushes; livespec tools push only after checking the state ([ADR 0004](decisions/0004-guards-inside-pi.md)).
- **Decisions are made by rules.** Code builds every decision from facts and records it. The agent never self-assesses a decision point ([ADR 0006](decisions/0006-rule-based-decisions.md)).
- **Forge content is data, not instructions.** Text written by humans on issues and pull requests is wrapped as untrusted. Only comments that carry a marker and were written by the plugin's account count as state.
- **No subagent plugin, same flow.** Without subagents, every step runs inline and produces the same evidence.
