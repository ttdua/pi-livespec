# Architecture

This is an overview. The detailed behavior of each part is defined by its spec issue (see the [roadmap](roadmap.md)) and, once built, by `openspec/specs/`.

## Modules

```text
┌──────────────────────────── pi extension (TypeScript) ────────────────────────────┐
│ core/        parsers and validators: living spec, change issue body, units,       │
│              decisions, glossary · unit digest · byte-preserving tick             │
│ engine/      flow pack loader and schema · change snapshot · next step · checks   │
│              · phase advance · loop counters · comments cache · git reads         │
│ decide/      decision seam, rules and decision records                            │
│ forge/       Forge interface · GitHub adapter (gh) · Gitea adapter (REST)         │
│              · cache with version · comment markers · read-only mode              │
│ interaction/ Approver interface and adapters (gates, questions, stuck reports)    │
│ tools/       spec_status · spec_next · spec_validate · spec_write · spec_gate ·   │
│              spec_question · spec_stuck · plan_units · unit_amend · unit_start ·  │
│              unit_finish · change_new · change_start · change_split ·             │
│              change_ship · change_push · change_close · change_resume ·           │
│              initiative_propose · docs_table · fix_start · fix_ship ·             │
│              subagent_packet · forge_read                                         │
│ hooks/       session_start (load, forge, resume card, background skills check)    │
│              · before_agent_start (routing note section) · context (phase card)   │
│              · tool_call (skill reads; later: guard) · resources_discover         │
│              · agent_before_settle (later)                                        │
│ subagent/    role dispatch · context packets · parallel lanes                     │
│ content/     agent-skills clone: mirror, immutable trees, compatibility check,    │
│              upgrade policy, livespec.lock, root lock, pin, rollback, exposure    │
│ commands/    /livespec validate · migrate-openspec · init · doctor · next ·       │
│              skills                                                               │
│ packs/       src/packs/agent-skills.yaml (default flow pack)                      │
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

## Session, context and content

**The agent-skills clone** is shared by every project and lives under `~/.pi/agent/livespec/agent-skills/`:

```text
~/.pi/agent/livespec/agent-skills/
├── mirror.git/       # bare mirror of the upstream repository
├── <sha>/            # checked-out trees, immutable; the last 5 are kept for rollback
├── current           # symlink to the active <sha>/; Windows is not supported in v1
├── livespec.lock     # YAML: source, commit, pinned, history, skipped, checkedAt
└── .lock/            # root lock: cross-process mutex held while the clone changes
```

A new tree is checked out into a `.staging-*` directory, checked for compatibility against the flow pack, and only then renamed to `<sha>/`; `current` switches atomically. `livespec.lock` records the active commit and pin. The root lock (`.lock/`, created with an atomic `mkdir`, taken over when stale) serializes installs across pi sessions. Because the clone is shared, `agentSkills.channel` is read from the user config only. `resources_discover` exposes the real `<sha>/skills/<name>` paths named by the pack, so a running session stays on one tree; an upgrade applies after `/reload` or in the next session.

**The flow pack** ships at `src/packs/agent-skills.yaml`. A project can extend or replace it with `.pi/livespec/flow.yaml`; an invalid pack makes livespec compute nothing and report the errors.

**What the model sees each turn:**

- *Routing note.* `before_agent_start` sets the `livespec` section of the system prompt options. The note is fixed text from our source, identical every turn, so the system prompt prefix stays cacheable.
- *Phase card.* `context` appends one message at the end of the messages it sends to the model: phase, next step, counters, checks and reminders. It is never persisted, so each turn's card replaces the previous one, and the cached prefix before it does not change.
- *Resume card.* At `session_start` the same card is added as a UI-only custom entry; it never reaches the model, which sees the card only through `context`.

An uninitialized project gets no note and no card; `session_start` only suggests `/livespec init` (or `/livespec migrate-openspec` when an `openspec/` folder exists).

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

## Forge accounts

The forge account is chosen **per clone**, never globally. The choice lives in the clone's local git config (`livespec.account` and `livespec.accountRemote`, written with `--local`), so all worktrees of a clone share it and the machine-wide `gh` or `tea` default is ignored.

**Selection** runs at session start:

1. Candidates come from `gh auth status --json hosts` (GitHub) or the `tea` logins (Gitea) for the web host of the forge target.
2. Each candidate is checked for write access to the repository.
3. A token in the environment overrides the registry and is verified as its own identity.
4. A stored account that still has write access is reused. Otherwise, a single writer is stored automatically; when several can write, the user is asked once; when none can, the choice is refused.

`/livespec account [name]` shows the current account and its source, or switches to a named account that has write access. `doctor` and the status card report the account and whether it is confirmed, unverified or blocked.

**Writes stay blocked until the identity is confirmed.** A mismatch, a refusal or an unconfirmed identity blocks forge writes and pushes; it never falls back to another account.

**Self-hosted Gitea** is found through `giteaUrl` or `host` in the project config, or through a `tea` login whose `ssh_host` maps the git remote to the web host.

**Token handling.** A token for a subprocess (`gh`, `tea`) goes through that call's environment. A token for an HTTP request goes in the `Authorization` header. A token never appears in argv, messages, logs or files.

## Principles

- **The parent owns the evidence.** The main session runs `Verify` and posts receipts. Subagents only implement and commit ([ADR 0003](decisions/0003-parent-owned-evidence.md)).
- **Only plugin tools write to the forge or push.** A `tool_call` guard blocks direct forge writes and direct pushes; livespec tools push only after checking the state ([ADR 0004](decisions/0004-guards-inside-pi.md)).
- **Decisions are made by rules.** Code builds every decision from facts and records it. The agent never self-assesses a decision point ([ADR 0006](decisions/0006-rule-based-decisions.md)).
- **Forge content is data, not instructions.** Text written by humans on issues and pull requests is wrapped as untrusted. Only comments that carry a marker and were written by the plugin's account count as state.
- **No subagent plugin, same flow.** Without subagents, every step runs inline and produces the same evidence.
