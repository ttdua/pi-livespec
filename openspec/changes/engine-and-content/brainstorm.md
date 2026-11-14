## Design Summary

LS-04 (issue #4) makes the livespec workflow run. After it, an agent that opens a new session in the middle of a change sees where the change stands and what to do next, without being told. That fixes the core problem in the project brief: the agent forgets where it is after compaction or in a new session.

The state is always derived from the change issue and from git, never from the agent's memory, and it is injected into the context on every turn.

What the user and the agent get:

- **Flow pack.** The phases, their skills, redirects, checks and gates are read from YAML: the default pack `packs/agent-skills.yaml`, plus an optional project override `.pi/livespec/flow.yaml` that replaces or adds phases by `id`. An invalid pack is reported with its line and column, and the flow does not run. Later specs (LS-05, LS-07) register their own sub-schemas (`decisions`, `subagents`) and named checks.
- **Where am I, what next.** For the current change, livespec reads the issue (phase label, marked comments, unit status lines, questions) and git (branch, HEAD, clean or dirty tree). From that it works out the current phase, the required skills, the outstanding checks, the open blocking questions, the loop counters and one sentence saying what to do next.
- **Context every turn.** A static routing note sits at the start of the context and never changes, so it stays cached. A phase card is appended at the end of the messages and replaced each turn. Probe (c) showed this keeps the cache.
- **Resume.** At session start, the branch `livespec/<change>` is mapped to its change issue and the phase card is shown. On any other branch, the card lists the open changes.
- **agent-skills content.** livespec manages its own clone of `addyosmani/agent-skills` under `~/.pi/agent/livespec/agent-skills/`, exposes only the skills the pack names (never `using-agent-skills` or `context-engineering`), and only in initialized projects. It upgrades automatically by default, checks compatibility first, and supports `notify`, `pinned`, `pin`, `unpin` and `rollback`.
- **Init and doctor.** `/livespec init` is idempotent and sets up `specs/` templates, the clone and the project config. `/livespec doctor` only reports and suggests.
- **First tools.** `spec_status`, `spec_next` (also `/livespec next`), `skill_note`, `spec_write`, `change_new` and `change_start`.

### Existing requirements involved

- `package-scaffold` / *Version command*: it already says subcommands are defined by their own capabilities. The new subcommands (`init`, `doctor`, `next`, `skills`) follow that rule, and the requirement is not altered.
- `package-scaffold` / *Dependency policy*: `dependencies` stays exactly `yaml`. Git operations for the clone use the `git` binary, as the project brief already requires.
- `spec-validation` (all checks): reused unchanged as the named checks `spec-format`, `units-format`, `done-maps-scenarios` and `capabilities-match-diff`.
- `change-issue-format` / *Change issue body parsing*, *Questions parsing*, *Unit parsing*: reused to build the change state. `spec_write` writes sections through the same parser/serializer, so content outside the written section stays byte-identical.
- `forge-interface` / *Fail-closed body writes*: `spec_write`, `change_start` and `advancePhase` go through `Forge` with the version they read. A conflict writes nothing.
- `forge-markers` / *Core kinds and registration*: `counter` is already a core kind. This change registers `skill-note`. *Labels*: phase labels use `livespec:phase/<phase>`.
- `forge-cache` / *Read-only mode*: when the forge is unreachable, the phase card is built from stale cached data and says so, and the write tools refuse.
- `openspec-migration`: not altered. Doctor and the session-start card only suggest it (see Key Decisions).
- `host-seam-evidence`: probes (a), (b) and (c) are consumed as recorded. Not altered.

No specified requirement is changed by this change. It adds new capabilities.

## Alternatives Considered

### Alternative A: Pure core with a thin shell (chosen)
- **Approach**: Snapshot readers gather facts (issue, marked comments, git) into a plain `changeState` value. `nextStep(pack, changeState)` and the phase card renderer are pure functions over that value. The hooks, tools and commands are thin shells: they read a snapshot, call the pure functions and write through `Forge`.
- **Pros**: The "new session shows the right next step" criterion becomes table tests over fixtures, with no pi and no forge needed. It matches the parser/validator style of LS-02 and the `Forge` seam of LS-03. Later specs (gates, receipts, subagents) add facts and checks without touching the shells.
- **Cons**: More small modules and an explicit snapshot type to keep in sync with what the readers collect.
- **Why not chosen**: It is chosen.

### Alternative B: Stateful engine object per session
- **Approach**: One engine instance holds the state in memory, updates it as tools run, and re-syncs from the forge now and then.
- **Pros**: Fewer forge reads per turn.
- **Cons**: The memory becomes a second source of truth, which is the exact failure the project exists to remove. It drifts from the issue when a human edits it or another session writes, and it is hard to test without running pi.
- **Why not chosen**: It goes against ADR 0002 (the issue is the source of truth). The forge cache from LS-03 already makes reads cheap.

### Alternative C: Each tool and hook computes its own view
- **Approach**: No shared engine. `spec_status`, `spec_next` and the context hook each read what they need and decide on their own.
- **Pros**: Least code up front.
- **Cons**: The rules for "what is next" get duplicated and drift between the card and the tools. LS-05 and LS-06 would have no single place to plug gates and receipts into.
- **Why not chosen**: The issue asks for one `nextStep` that later specs extend.

## Agreed Approach

Alternative A. A plain snapshot and pure decision functions sit in the middle. The flow pack loader, the agent-skills content manager, init/doctor and the tools are separate modules around it, and the pi hooks and commands are the only places that touch pi.

The whole of LS-04 stays **one change and one pull request**, as the roadmap says. The plan is split into ordered task groups so each group can be reviewed on its own:

1. flow pack;
2. engine state and next step;
3. agent-skills content;
4. init and doctor;
5. context injection and resume;
6. tools.

## Key Decisions

- **One change, one PR** (user answer): matches the roadmap. The plan carries the split as ordered task groups.
- **Uninitialized project with an `openspec/` folder** (user answer, closes the open question in #4): doctor and the session-start phase card suggest `/livespec migrate-openspec`. Nothing runs automatically, and init does not migrate.
- **Cache criterion evidence** (user answer): a unit test proves the routing note and every message before the card stay byte-identical across turns. One manual smoke run of at least 5 turns through 9router records cache-read tokens in the change, in the style of probe (c).
- **Upgrade block while work is in progress** (my call): `unit_start` and `unit_finish` arrive in LS-06. Until then an upgrade is blocked whenever a change of this project is in phase `build` with an unfinished unit. That is conservative and needs no new state. LS-06 replaces it with the exact "started but not finished" fact.
- **Persona compatibility check** (my call): the check is built and tested, but the v1 default pack names no persona, so it has nothing to check until LS-07 registers `subagents`.
- **Approver line in doctor** (my call): doctor gets a registration point for extra report lines. No approver line is printed until LS-05 registers one.
- **Clone and upgrade tests** (my call): they use local bare git repositories as the upstream, with no network. Real network fetches happen only in the manual smoke run.
- **Upstream baseline** (finding): agent-skills HEAD `39b723c` has every skill the default pack names, including `interview-me`, `idea-refine` and `constraint-driven-development`, and has four personas in `agents/`.
- **Duplicate skills** (finding): this machine has an older `~/.pi/agent/skills/spec-driven-development`, the duplicate-name case doctor must report.
- **Superpowers and trust** (from probe (a)): the per-project Superpowers override only takes effect in a trusted project, so doctor also reports whether the project is trusted.
- **Forge at session start** (finding): the extension does not build a `Forge` at startup today. This change does it, including the read-only path when the forge is unreachable, so the phase card can always render.

## Open Questions

- None blocking. Technical choices (module layout, snapshot shape, config file schema, how the 24-hour fetch timestamp is stored) are left to `design.md`.
