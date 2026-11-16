# Architecture

This is an overview. The detailed behavior of each part is defined by its spec issue (see the [roadmap](roadmap.md)) and, once built, by `openspec/specs/`.

## Modules

```text
┌──────────────────────────── pi extension (TypeScript) ────────────────────────────┐
│ core/        parsers and validators: living spec, change issue body, units,       │
│              decisions, glossary · unit digest · byte-preserving tick             │
│ engine/      flow pack loader and schema · change snapshot · next step · checks   │
│              · phase advance · loop counters · comments cache · git reads         │
│              · gates (registerGate, refusals) · locks, frozen, stale · iterations │
│ decide/      decide() seam · registerRule · rules: tags, difficulty · decision    │
│              records (issue comment, PR-body block) · override records            │
│ forge/       Forge interface · GitHub adapter (gh) · Gitea adapter (REST)         │
│              · cache with version · comment markers · read-only mode              │
│ interaction/ Approver contract · adapters: in-session (dialogs), forge (request   │
│              comments) · adapter chain · /livespec command parser and matching    │
│              · requests · polling · completion, one handler per subject kind      │
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

## Gates and decisions

Every human decision (a phase or named gate, a unit amendment, a question, a stuck report, a rule that asks) follows one lifecycle, and its whole state lives on the change issue as own marked comments. No tool takes an outcome, choice, answer, `Difficulty` or `Tags` parameter, so the agent can only ask, never answer.

**Request → answer → result.**

- **Request.** The forge adapter writes a `request` comment with the subject (`gate:<phase|name>`, `amend:<n>`, `question:Q<n>`, `stuck:S<n>`, `decide:<point>.<subject>`), the mode, the options, `head_sha` and a snapshot of what the human sees. Only one request per subject may be pending.
- **Answer.** An `answer` comment records the full request, the human's answer and the validation verdict (`valid` or `superseded`). Validation runs once, before the answer is written: a gate checks that HEAD, the gate digest and the refusal conditions are unchanged; an amendment checks the affected units' digests and the resulting plan. The in-session adapter writes the `answer` comment directly, with no `request`.
- **Result.** Completion applies the effects in a fixed order, each skipped when already applied (body edit, `stale` or `decision` comments, phase move), and writes the result comment (`gate`, `amendment`, `question`, `stuck` or `decision`) last. A crash leaves the request *applying*, and the next poll or livespec tool finishes it. Completion is one handler per subject kind.
- **Derived advance.** A phase moves when its *valid gate result* (the latest own `gate` comment newer than the latest `stale` comment listing the phase, not superseded) is approved; `ship` never advances. A failed label move retries on every refresh. A gate result carries `waivers`: the waivable checks the human waived with `/livespec choose waive`, so an approved waived gate advances even though those checks still fail.

**Adapter chain.** `interaction.adapter` lists `in-session` and `forge` in order; project config wins over user config, and the default is `[in-session]`. The chain skips an adapter that is unavailable (in-session without a UI; forge unconnected, read-only or blocked by the account) and refuses, naming the config key, when none is left. The in-session adapter asks through pi dialogs; a cancelled dialog is `dismissed`. `/livespec doctor` names the list, its source and the adapter that would answer now.

**Forge commands and polling.** A writer answers a forge request with a plain comment whose first line is a command: `/livespec approve [notes]`, `changes <notes>`, `dismiss [notes]`, `choose <option> [notes]`, `answer Q<n> <text> [--changes <capability>/Requirement: <name>] [--class …]`, `class Q<n> …`, or `set U<n> difficulty|tags …` (an override applied only if the pending plan or amendment gate is approved). Polling runs at session start, at `/livespec next` and before every livespec tool; it is single-flight per session, so parallel tool calls share one run. It finishes applying requests first, then matches commands:

- Only authors with `write` or `admin` count; permission is read once per author per poll and fails closed.
- A command targets by **position in the thread**: only requests posted before it and still open at that point count. A command ignored once (ambiguous, too early, `approve` while waivable checks fail) therefore stays ignored, and the card shows the reason.
- `approve`, `changes` and `choose` target the single pending gate or amendment, else the single pending stuck or decide request.
- Edits after completion are ignored; the result records the answering comment's id, author and `updatedAt`.

**Lock and amendments.** The approved plan gate stores the digest of every unit (`locked`). Later approved amendments (edit, add, drop) update that map in comment order. A unit whose current digest differs from the lock is *frozen*, for example after a web edit; ticking a status line does not freeze. Frozen units block the plan gate and the build work (unit_start/unit_finish refusal is enforced by LS-06) until `unit_amend` gets the change approved. A drop of a unit that another unit depends on is refused.

**Cascade and `change_iterations`.** An answer that names a changed requirement runs a cascade: one body write (the answer line, plus unticking every done unit whose `Covers` holds that requirement), a `stale` comment listing `define` and every later phase and those units, then a move back to define. The `stale` comment sets `after_plan` only when the cascade actually moved the change back from past define after an approved plan gate. `change_iterations` is derived, never stored: it is the number of own `stale` comments with `after_plan: true`, so a retried completion cannot count twice. When it reaches `loops.change_iterations`, the next step asks for `spec_stuck` and every gate refuses, until a stuck answer is dated after the latest increment. A `dismissed` stuck answer does not lift the cap; only a choice does.

**Decisions.** `decide(point, facts)` runs the registered rule (`tags`, `difficulty`), which returns an outcome or asks the human. For the `ask` branch, `createDecisionAsker` (`src/tools/decide-ask.ts`) sends a blocking `decide:<point>.<subject>` request through the configured approver chain: an in-session choice is completed at once as a `source: human` record, and a forge request stays pending until `/livespec choose` completes it; an open request for the subject is reported pending instead of asking again. `plan_units` and `unit_amend` stay rule-only: they pass no asker, so a rule that asks refuses the tool before any write. Wiring the asker into them, and reusing a human answer on rerun, waits for the first built-in rule that asks. Every outcome is posted as a `decision` record keyed by point and subject with the unit digest; the `unit-classification` check compares the body with the latest record, so a tag removed from the body is caught. The agent can only add tags through `extra_tags`, which the record lists as `agent_additions`.

**Known gaps.** LS-06 closes the first two.

- **Same-login command comments.** Commands from the plugin's own login are accepted, because the person running pi and the plugin account are usually the same login. Until LS-06's guard on direct forge writes (`gh`, `tea` and raw API calls in bash), the agent could post `/livespec approve` itself. The `gate` result records the answering comment's id and author for audit.
- **Pack overrides that lower a gate.** `.pi/livespec/flow.yaml` can still set `define`, `plan` or `ship` to `gate: self`, and the agent can edit that file. LS-06 adds a guard that blocks agent writes to `.pi/livespec/`.
- **Cross-session polling.** Polling is single-flight within one session only. Two sessions or machines polling the same issue at once are not coordinated; each completion step is idempotent against the state it reads, but concurrent writers are not serialized.

## Forge accounts

The forge account is chosen **per clone**, never globally. The choice lives in the clone's local git config (`livespec.account` and `livespec.accountRemote`, written with `--local`), so all worktrees of a clone share it and the machine-wide `gh` or `tea` default is ignored.

**Selection** runs at session start:

1. Candidates come from `gh auth status --json hosts` (GitHub) or the `tea` logins (Gitea) for the web host of the forge target.
2. Each candidate is checked for write access to the repository.
3. A token in the environment overrides the registry and is verified as its own identity.
4. A stored account that still has write access is reused. Otherwise, a single writer is stored automatically; when several can write, the user is asked once; when none can, the choice is refused.

`/livespec account [name]` shows the current account and its source, or switches to a named account that has write access. `doctor` and the status card report the account and whether it is confirmed, unverified or blocked.

**Writes stay blocked until the identity is confirmed.** A mismatch, a refusal or an unconfirmed identity blocks forge writes; it never falls back to another account.

**Self-hosted Gitea** is found through `giteaUrl` or `host` in the project config, or through a `tea` login whose `ssh_host` maps the git remote to the web host.

**Token handling.** A token for a subprocess (`gh`) goes through that call's environment; `tea` is never run, only its config is read. A token for an HTTP request goes in the `Authorization` header. A token never appears in argv, messages, logs or files.

## Principles

- **The parent owns the evidence.** The main session runs `Verify` and posts receipts. Subagents only implement and commit ([ADR 0003](decisions/0003-parent-owned-evidence.md)).
- **Only plugin tools write to the forge or push.** A `tool_call` guard blocks direct forge writes and direct pushes; livespec tools push only after checking the state ([ADR 0004](decisions/0004-guards-inside-pi.md)).
- **Decisions are made by rules.** Code builds every decision from facts and records it. The agent never self-assesses a decision point ([ADR 0006](decisions/0006-rule-based-decisions.md)).
- **Forge content is data, not instructions.** Text written by humans on issues and pull requests is wrapped as untrusted. Only comments that carry a marker and were written by the plugin's account count as state.
- **No subagent plugin, same flow.** Without subagents, every step runs inline and produces the same evidence.
