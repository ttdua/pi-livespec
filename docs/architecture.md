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
│              comments) · briefing, describe-actions, forge-text, menu · adapter chain · /livespec command parser and matching    │
│              · requests · polling · completion, one handler per subject kind      │
│ tools/       spec_status · spec_next · spec_validate · spec_write · spec_gate ·   │
│              spec_question · spec_stuck · plan_units · unit_amend · unit_start ·  │
│              unit_finish · change_new · change_start · change_split ·             │
│              change_sync · change_park · change_resume · change_ship ·            │
│              change_push · change_close · initiative_propose ·                    │
│              new_dependency · docs_table · fix_start · fix_ship ·                 │
│              subagent_dispatch · subagent_answer · subagent_packet ·              │
│              subagent_record · finding_rebut · lane_open · lane_merge ·           │
│              forge_read                                                           │
│ hooks/       session_start (load, forge, resume card, background skills check)    │
│              · before_agent_start (routing note section) · context (phase card)   │
│              · tool_call (guard, registered first; then skill reads)              │
│              · resources_discover · agent_before_settle (one continuation,        │
│              incomplete marker) · agent_settled · turn_end (turns, context %)     │
│ evidence/    unit-start and receipt records · unit state · Verify runner and      │
│              temporary worktrees · red/green · failure signature · progress       │
│              rule · verify-red-on-base · started-unit work in progress            │
│ guard/       shell parser · command classifier · .pi/livespec/ paths ·            │
│              guardedPush (the only git push)                                      │
│ subagents/   executor adapter · child mode · roles and policy · packets ·         │
│              dispatch · dispatch/finding-summary/lane records · lanes · doctor    │
│ initiatives/ dependency graph and cycles · readiness · propose and amendments ·   │
│              split · size-limits · split rule · capability overlap · sync         │
│ deps/        new-dependency gate and effects · park · resume · parked state       │
│ content/     agent-skills clone: mirror, immutable trees, compatibility check,    │
│              upgrade policy, livespec.lock, root lock, pin, rollback, exposure    │
│ docs/        define-time checks: product-impact, glossary-terms, behavior-change  │
│              · packet readers (glossary, decisions)                               │
│ audit/       drift detectors · scout confirmation · drift-severity rule · report  │
│              and triage · suggestions and local audit state                       │
│ commands/    /livespec validate · migrate-openspec · init · doctor · next ·       │
│              skills · audit                                                       │
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

**Local, and only a cache:** `~/.pi/agent/livespec/` holds the agent-skills clone, user config and an issue cache. Deleting the cache loses nothing. `<git common dir>/livespec/` holds the packet spill files and `audit.json` ([Audit](#audit)); it is also safe to delete.

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

- `shape` comes first. It clarifies the intent and may split the work into an initiative of several changes (see [Initiatives](#initiatives)).
- The `plan` checks include the waivable `size-limits`: more units than `limits.max_units` (8) or more declared capabilities than `limits.max_capabilities` (3) holds the plan gate until a `change_split` or a `waive`.
- The **small-fix lane** skips the ceremony: `fix_start <slug>` creates `fix/<slug>` from the fetched integration branch, and the agent edits code, tests and the living spec directly, with no issue. The `lane` rule runs on the committed diff since the merge base and forces a full change when it exceeds `max_files: 3` or `max_lines: 100` (added plus deleted), adds or removes a requirement or scenario, creates a capability, or touches `specs/constraints.md` or `specs/decisions/`. Otherwise it is `small`; a code change under a living spec's `paths` with that spec unchanged is `small` with `behavior_change: declared-none`. `fix_ship` (no parameters) refuses unless `testCommand` in the project config exits 0, then pushes `HEAD:refs/heads/fix/<slug>` and opens or updates its one pull request. The body carries the test result and a `lane` decision block (`point: lane`). A forced fix moves into a change with `change_new <name> --from-fix`, which keeps the commits and renames the branch to `livespec/<name>`. The phase card shows the lane outcome and one next step, never a subagent.
  - **Empty (landed) fix.** A fix is empty when no commit follows the merge base, or when merging `HEAD` into `origin/<integration>` would leave that tree unchanged (a squash or rebase merge already landed it). A conflicting merge is never empty; on git < 2.38 a `HEAD` tree equal to the `origin/<integration>` tree is. The card, `fix_ship` and `change_new --from-fix` share this one definition (`src/fix/branch.ts`): `fix_ship` says there is nothing to ship and `change_new --from-fix` refuses an empty fix, saying there is nothing to move.
  - **Card freshness.** The fix card is memoized by `HEAD`, the integration branch and the local `origin/<integration>` tip, read without a fetch. After a squash merge on the forge it is therefore "as of the last fetch": it shows the fix as empty only after some fetch (`fix_ship`, `change_new --from-fix` or `git fetch`) moves that tip.
  - **`testCommand`.** The project config key `testCommand` (`.pi/livespec/config.yaml`) is the command `fix_ship` runs at the project root through the guard, with the `verify.timeout` limit; without it `fix_ship` refuses. Its output tail (at most 4,096 bytes) goes into the pull request body and, on failure, into the refusal. Only known tokens (the forge account tokens the session holds) are redacted; anything else the command prints is published as-is, so it must not print secrets.
  - **One pull request across sessions.** The evidence lock is per process, so `fix_ship` lists the open pull requests from the branch again right before it creates one, and once more after a failed create; an own pull request found then is updated instead of opening a second one. Bare work is advisory: an edit of a tracked file outside `specs/` on a branch that is neither `livespec/*` nor `fix/*` gets a `livespec guard:` warning and one line in `specs/bare-work.md`, and never blocks. Edits made through `bash` are not detected.
- Every loop has a cap. Reaching a cap stops the work and sends a stuck report to the human.

## Gates and decisions

Every human decision (a phase or named gate, a unit amendment, a question, a stuck report, a rule that asks) follows one lifecycle, and its whole state lives on the change issue as own marked comments. No tool takes an outcome, choice, answer, `Difficulty` or `Tags` parameter, so the agent can only ask, never answer.

**Request → answer → result.**

- **Request.** The forge adapter writes a `request` comment with the subject (`gate:<phase|name>`, `amend:<n>`, `question:Q<n>`, `stuck:S<n>`, `decide:<point>.<subject>`), the mode, the options, `head_sha` and a snapshot of what the human sees. Only one request per subject may be pending.
- **Answer.** An `answer` comment records the full request, the human's answer and the validation verdict (`valid` or `superseded`). A superseded `reason` is wrapped as untrusted where it is built and marked `reason_wrapped: true`; older answers without the mark are wrapped when shown. Validation runs once, before the answer is written: a gate checks that HEAD, the gate digest and the refusal conditions are unchanged; an amendment checks the affected units' digests and the resulting plan. The in-session adapter writes the `answer` comment directly, with no `request`.
- **Result.** Completion applies the effects in a fixed order, each skipped when already applied (body edit, `stale` or `decision` comments, phase move), and writes the result comment (`gate`, `amendment`, `question`, `stuck` or `decision`) last. A crash leaves the request *applying*, and the next poll or livespec tool finishes it. Completion is one handler per subject kind.
- **Derived advance.** A phase moves when its *valid gate result* (the latest own `gate` comment newer than the latest `stale` comment listing the phase, not superseded) is approved; `ship` never advances. A failed label move retries on every refresh. A gate result carries `waivers`: the waivable checks the human waived with `/livespec choose waive`, so an approved waived gate advances even though those checks still fail.

**Briefing and presentation.** A request may carry a `Briefing` (`src/interaction/approver.ts`): `summary`, optional `watch`, `recommended` (an offered choice id), `rationale` and `author` (`agent` or `rule`). It is stored in the `request` comment yaml and in the `answer` record, so a completed request keeps what the human saw; a request without one (written before this) still parses and completes. Four pure modules shape what the human reads:

- `briefing.ts` validates agent text (length limits, one line per watch item, `recommended` must be an offered id, `rationale` required with it) and neutralises `<!--` and a leading `/livespec`.
- `describe-actions.ts` is the single source of offered choice ids and livespec-written descriptions for gates, amendments, stuck and rule requests (no `approve` while a waivable check fails); briefing validation and both adapters use it, so a recommendation can never name a choice that is not offered.
- `forge-text.ts` renders the `request` comment text below the yaml: Decision needed heading, facts, failing checks, briefing blockquote, a How to answer table and a collapsed command list. The parser ignores this text.
- `menu.ts` builds the in-session entries (`<label> — <description>`, recommended first with ` (Recommended)`) and the title (facts, then briefing).

**Facts first, agent text untrusted.** livespec's own payload (summary, files, links, checks, option descriptions of built-in actions) comes before the briefing, and the briefing is labelled `agent-authored, advisory` (`Livespec rule recommendation` when `author` is `rule`). Agent text is neutralised, and escaped for markdown on the forge (no fence, heading, HTML block or `<details>` tag), so it can add neither a section nor a command. A recommendation only marks a choice; the answer still has to come from the human.

**Adapter chain.** `interaction.adapter` lists `in-session` and `forge` in order; project config wins over user config, and the default is `[in-session]`. An empty list (written, or empty after unknown names are dropped) counts as unset and falls through to the next layer. The chain skips an adapter that is unavailable (in-session without a UI; forge unconnected, read-only or blocked by the account) and refuses, naming the config key, when none is left. The in-session adapter asks through pi dialogs; a cancelled dialog is `dismissed`. `/livespec doctor` names the list, its source and the adapter that would answer now.

**Forge commands and polling.** A writer answers a forge request with a plain comment whose first line is a command: `/livespec approve [notes]`, `changes <notes>`, `dismiss [notes]`, `choose <option> [notes]`, `answer Q<n> <text> [--changes <capability>/Requirement: <name>] [--class …]`, `class Q<n> …`, or `set U<n> difficulty|tags …` (an override applied only if the pending plan or amendment gate is approved). Answers are collected by polling, not by a per-adapter `poll`: the session-level `pollApprovals` reads the issue at session start, at `/livespec next` and before every livespec tool. It is single-flight per session, so parallel tool calls share one run. It finishes applying requests first, then matches commands:

- Only authors with `write` or `admin` count; permission is read once per author per poll and fails closed.
- A command targets by **position in the thread**: only requests posted before it and still open at that point count. A command ignored once (ambiguous, too early, `approve` while waivable checks fail) therefore stays ignored, and the card shows the reason.
- `approve`, `changes` and `choose` target the single pending gate or amendment, else the single pending stuck or decide request.
- Edits after completion are ignored; the result records the answering comment's id, author and `updatedAt`.
- A `/livespec class` command is recorded once with a `class` marker, keyed by the command comment id, and applied once. A recorded command is skipped before permission checks.

**Lock and amendments.** The approved plan gate stores the digest of every unit (`locked`). Later approved amendments (edit, add, drop) update that map in comment order. A unit whose current digest differs from the lock is *frozen*, for example after a web edit; ticking a status line does not freeze. Frozen units block the plan gate and the build work (unit_start/unit_finish refusal is enforced by LS-06) until `unit_amend` gets the change approved. A drop of a unit that another unit depends on is refused.

**Cascade and `change_iterations`.** An answer that names a changed requirement runs a cascade: one body write (the answer line, plus unticking every done unit whose `Covers` holds that requirement), a `stale` comment listing `define` and every later phase and those units, then a move back to define. The `stale` comment sets `after_plan` only when the cascade actually moved the change back from past define after an approved plan gate. `change_iterations` is derived, never stored: it is the number of own `stale` comments with `after_plan: true`, so a retried completion cannot count twice. When it reaches `loops.change_iterations`, the next step asks for `spec_stuck` and every gate refuses, until a stuck answer is dated after the latest increment. A `dismissed` stuck answer does not lift the cap; only a choice does.

**Decisions.** `decide(point, facts)` runs the registered rule (`tags`, `difficulty`), which returns an outcome or asks the human. For the `ask` branch, `createDecisionAsker` (`src/tools/decide-ask.ts`) sends a blocking `decide:<point>.<subject>` request through the configured approver chain: an in-session choice is completed at once as a `source: human` record, and a forge request stays pending until `/livespec choose` completes it; an open request for the subject is reported pending instead of asking again. `plan_units` and `unit_amend` stay rule-only: they pass no asker, so a rule that asks refuses the tool before any write. Wiring the asker into them, and reusing a human answer on rerun, waits for the first built-in rule that asks. Every outcome is posted as a `decision` record keyed by point and subject with the unit digest; the `unit-classification` check compares the body with the latest record, so a tag removed from the body is caught. The agent can only add tags through `extra_tags`, which the record lists as `agent_additions`.

**Known gaps.**

- **Cross-session polling.** Polling is single-flight within one session only. Two sessions or machines polling the same issue at once are not coordinated; each completion step is idempotent against the state it reads, but concurrent writers are not serialized.

## Evidence and guards

**Receipts.** Build evidence is two kinds of own marked comment on the change issue, both append-only:

- `unit_start U<n>` checks that the unit is pending, not frozen, its dependencies are done, no other unit is started and the tree is clean. It then runs the unit's `Verify` at `HEAD` and posts a `unit-start` comment with the unit digest and the pre run. A normal unit must be red at the start, and a refactor unit must be green. A command that cannot run (not found, timeout, spawn error) is never counted as red.
- `unit_finish U<n>` runs `Verify` again at `HEAD`. When it is green, it posts a `receipt` with the pre and post SHA and exit codes, plus the tail of the output (at most 8 KB, with known tokens redacted). Then it ticks the unit, keeping every other byte of the body. A receipt without a tick, after a crash, is reconciled on the next call.
- A unit whose test file in `Files` does not exist at the pre commit is *verifier-pending*: its first commit may change only those test files, and that commit becomes the pre.

**Attempts and `BLOCKED`.** Each `unit_finish` that is not green posts a `progress` decision record with the attempt number and a failure signature (failing test names plus a normalized error hash). The `progress` rule stops early when two attempts in a row fail the same way. The unit is `BLOCKED` when the rule says stop or `loops.unit_attempts` is reached, and only a chosen stuck answer restarts its budget.

**`verify-red-on-base`.** A gate-only check of the plan gate. It runs every non-pending unit's `Verify` on `Base` in a temporary worktree and fails when a normal unit is already green there. Pending (non-refactor) units are exempt. A refactor unit must be green on `Base`, and it is an error when its test is missing. A missing toolchain is not red. Results are memoized for the session, keyed by the root, `Base` and the unit digests.

**`verify.setup`.** A temporary worktree normally symlinks `node_modules`, `.venv` and `vendor` from the main checkout. When the project config sets `verify.setup`, that command prepares the worktree instead. `verify.timeout` bounds each run, 600 seconds by default. The worktree is always removed.

**Guard.** A `tool_call` handler, registered before every other livespec handler, checks each `bash`, `write` and `edit` call of an initialized project. It blocks:

- forge writes through `gh`, `tea`, `gh api` and `curl`/`wget` to the forge host;
- `git push` in any form, including aliases (read from git config on every bash call) and pull request commands;
- writes to `.pi/livespec/`, through `write`, `edit` or a shell redirect, tracking `cd` within one command;
- obscured forms (`eval`, a variable command word, an unreadable command) that contain a dangerous token.

Every reason starts with `livespec guard:`, names the rule and names the livespec tool to use. The guard fails closed: an internal error blocks the call with "the command was not run". It has no flag, variable or parameter that lets a call through.

**`guardedPush`.** `src/guard/push.ts` is the only code that runs `git push`. It is not a tool, and no tool imports it in LS-06; LS-09 adds callers that check the state first, and `change_park` pushes wip branches through it ([Discovered dependencies](#discovered-dependencies)). The module also holds `guardedDeleteWip`, called only by `change_resume`, which deletes a wip branch under a lease on its recorded head.

**Settle.** At `agent_before_settle` with outcome `completed`, a resolved change in a `per: unit` phase or with a started unit has unfinished items: each started unit, a dirty tree, and each message of a condition registered with `registerSettleCondition`. The first time in a user prompt, the hook appends a `livespec-settle` message and requests one continuation. If items remain at the next settle, it writes the own `incomplete` comment (id `<change number>`, edited in place) and lets the agent settle. A later settle with nothing unfinished clears that comment, whatever the phase. A read-only forge writes nothing and records a warning. The settle hook fails open: errors are recorded.

**Accepted limits.**

- **Script files.** `sh script.sh` and a script run by its own path are not read; a forbidden command inside a script file runs.
- **Pushes outside pi.** A human, a git hook or another program can still push or write to the forge; the guard only sees the agent's tool calls.
- **Executors without the extension.** An agent in a harness that does not load pi-livespec is not guarded. LS-07 restricts write roles.
- **Unlisted runners.** `watch`, `chronic`, `script -c`, `busybox sh -c` and `find -exec` run commands the guard does not unwrap.
- **Other push and forge paths.** `git lfs push`, `tea` aliases and `tea api` are not recognized.
- **Other writers.** Writes to `.pi/livespec/` through `git checkout`/`git restore`, `truncate`, `dd of=`, `rsync`, `patch` or an interpreter (`python -c`, `node -e`) are not caught.
- **Copies into an ancestor.** A recursive copy or move whose destination is an ancestor of `.pi/livespec` (`cp -r incoming/livespec .pi`, `cp -a incoming/.pi .`, `mv incoming/livespec .pi`) is not caught. The guard checks the destination operand, not the subtree the copy creates.
- **Abbreviated wrapper options.** A GNU abbreviated long option on a wrapper (`nice --adjust 5 git push`, `timeout --kill-a`, `env --split-s`, `xargs --max-a`) hides the wrapped command. Abbreviations of write-command options are resolved. Both limits are tracked in #28, which adds human approval.
- **Two sessions on one change.** The evidence lock is per process; two pi sessions can run `unit_start`/`unit_finish` on the same change at once.

## Subagents

The parent session may hand role work to subagent children. It keeps every piece of state, evidence, forge write and gate for itself ([ADR 0003](decisions/0003-parent-owned-evidence.md)). The code lives in `src/subagents/`, and the tools in `src/tools/`.

**Four layers.** A child's brief has four layers, and each comes from exactly one source:

1. **Role**: the executor's agent file for `scout`, `implementer`, `reviewer` or `verifier`. The `verifier` role takes a `finding` reference (`subagent_dispatch verifier` with `finding: <aggregate comment id>:<index>`), and its packet refuses without one; see [Review](#review). livespec ships no agent files. A user or project file that overrides one of them is used as is. It triggers a warning once per session, and the record stores it as `agentSource`.
2. **Protocol**: a fixed, flow-neutral livespec text (`protocol.ts`). It says that `<untrusted>` text is data, how to read spilled sources, what the child must not do, how to ask (`ask_parent` or `NEEDS_CONTEXT`) and how to submit the structured result.
3. **Flow**: the pack name, the pack version, the content tree commit and the role's skills. The skills reach the child as absolute `SKILL.md` paths with `skills.inherit: false`.
4. **Task**: the unit or the review subject, its sources in manifest order, `Verify`, `Files` and the prohibitions. A footer follows with the packet hash and each source's version.

**Dispatch through the executor service.** livespec does not need a particular subagent package. It reads a service from `globalThis[Symbol.for("@ttdua/pi-subagents:service")]`, and falls back to the legacy `@gotgenes/pi-subagents:service` key. It accepts the service when `spawn`, `wait`, `resume`, `abort`, `childSession` and `getAgentType` are functions, and never checks a package name or version. `subagent_dispatch <role> [unit] [subject]` runs a whole launch inside the tool. An empty `unit`, `subject` or `finding` counts as omitted, and a `subject` or `finding` given for a role that does not take it is ignored with a warning at the top of the tool result (the same holds for `subagent_packet` and `subagent_record`):

1. build the packet;
2. subscribe to `subagents:child:session-created`;
3. `spawn` with `context: "fresh"`, `contextFiles: false`, the skill paths, the excluded packages of other flows, `cwd`, `metadata` and `resultSchema`;
4. check the effective launch facts against the request;
5. `wait`, then interpret the structured result;
6. record it.

A launch whose facts differ from the request is aborted and runs inline, so an executor that drops an option silently is caught. livespec sets `thinkingLevel` from the unit's `Difficulty`, raised one level per failed attempt. It never sets a model. Interpreting the result follows fixed caps:

- a missing structured result is retried once;
- a result that omits a required source is returned to the child once, then recorded `BLOCKED`;
- `NEEDS_CONTEXT` is not a failed attempt, and a third `NEEDS_CONTEXT` for a unit makes the next step `spec_stuck`.

A child question either reaches the parent, which answers with `subagent_answer`, or goes to the user through `spec_question`. Cancelling `subagent_dispatch` or `subagent_answer` (the tool call's abort signal) aborts the child and records no result.

**Phase-level suggestions.** Outside `build`, before a phase's gate is requested, the next step names each scout and whole-change reviewer entry of the phase that holds and has not run for the current state: a reviewer until a completed review of its subject records HEAD, a scout until a scout record exists since the phase began. An advisory entry never blocks the gate; the suggestion only comes first.

**Child mode.** livespec also loads inside children. A session is a child when the executor's `childSession` knows its id. Only without a capable executor does the session header's `parentSession` decide, as a fallback. A failing check counts as a child. In a child, livespec:

- sets `CHILD_NOTE` instead of the routing note;
- adds no phase card or resume card;
- discovers no skills;
- never replaces or clears the parent's session state. pi caches the extension per cwd, so an in-process child can share livespec's module with its parent: a child's `session_start` stores a session (with the forge target only) only when none exists, and its `session_shutdown` touches nothing.

Known limit: a pi `/fork` or `/clone` of a main session also writes `parentSession`, so without a capable executor such a session is treated as a child. With an executor present, only the executor's `childSession` decides.

The subagent, lane, `finding_rebut` and `forge_read` tools refuse in a child, and the guard still blocks pushes and forge writes.

**Packet and freshness.** Nothing that varies between units comes before the task, so the system prompt, protocol and flow blocks hit the provider cache from the second dispatch on. Sources over the `packetBudgetTokens` budget (default 24000, estimated as `ceil(chars / 4)`) spill to `<git common dir>/livespec/packets/<change>/<hash>/`. The packet then lists them by path. The last packet of a dispatched unit is stored beside its spill files. Before `unit_finish` ticks the unit, livespec re-reads the version of every source of that packet. A changed source, or a newer human comment or answer that the manifest would now include, stops the unit through `spec_stuck`.

**Lanes.** When two or more ready units are independent (no `Depends` between them, disjoint `Files`), the implementer entry holds and an executor is present, the next step names `lane_open` for each of them, up to `lanes` (default 3).

- `lane_open <unit>` creates `.worktrees/<change>--<unit>` on `livespec/<change>--lane-<unit>` and posts the `lane` record. The unit then starts, is implemented and is reviewed in its lane.
- `lane_merge <unit>` checks the lane's commits against `Files`, merges with `--no-ff`, runs `Verify` on the change root, then closes and removes the lane. `unit_finish` follows on the change branch, one lane at a time, and accepts the review of the lane head that is the merge commit's second parent.
- A unit re-runs sequentially in the change worktree when its lane touched a file outside `Files` (recorded as a `files-violation` finding), the merge conflicted, `Verify` was red after the merge (the merge is undone and the attempt counts as failed), or a workspace provider moved the child out of the lane.
- When an open lane's worktree was deleted, `lane_merge <unit>` closes its record with outcome `moved`, and the unit re-runs sequentially; the other unit tools name `lane_merge` as the way out.
- A unit with a receipt but no tick is ticked with `unit_finish` before any lane opens.

**Records.** Every result is an own marked comment on the change issue. Counters are derived from these comments, never from session memory.

- `dispatch`: one per settled implementer or scout run, with id `dispatch.<unit|change>.<role>.<attempt>`. It holds the role, unit, attempt, packet hash, agent source, requested thinking, effective model and thinking, status, commits, `notes`, `discoveries` and `sources_used`. The statuses `QUESTION` and `ANSWERED` keep a child's question alive across a session reload. A dependent unit's packet reads `discoveries` from this record.
- `finding-summary`: one per reviewer or verifier round, with id `finding-summary.<unit|change>.<subject>.<round>`. It holds the findings, the reviewed HEAD, the status, the required and used sources and whether the review completed. `finding_rebut` adds a rebuttal record. `unit_finish` refuses while a blocking finding is unresolved, or while a required unit review has not completed at HEAD. An `out-of-scope` finding never refuses `unit_finish`: it is listed at the next human gate until a gate has shown it, as a `files-violation` finding is.
- `lane`: one per lane, with id `lane.<unit>`. It holds the path, branch and base. A later `lane` record with `closed: true` ends the lane and names the outcome (`merged`, `violation`, `conflict`, `red` or `moved`).

**Inline fallback.** Without a capable executor, or when the policy does not suggest a dispatch, the phase card names `subagent_packet` and `subagent_record`. The parent reads the same packet, does the work in its own session and records the result in the same schema. The dispatch records, finding summaries, receipts and ticks are the same as for a dispatched run, so a change completes either way.

**Doctor** reports the executor and its missing capabilities, role agents overridden by a user or project file, a configured package that registers a workspace provider (`@gotgenes/pi-subagents-worktrees`), and the packages excluded from livespec children.

## Review

The `review` phase runs a fan-out of reviewers over the whole change, verifies and routes their findings, and returns defective units to `build`. The code lives in `src/review/`, the tool is `spec_review` (`src/tools/spec-review.ts`).

**Stages and records.** One `spec_review` call advances a round through fixed stages and returns when it is routed, blocked or a stage limit is hit; calling it again resumes. Each stage reads the state the previous one wrote, and every write is an own marked comment on the change issue:

1. `start`: refuses a dirty tree, a missing `Base`, an open blocking question or an unanswered stuck report. It runs every unit's `Verify` at `HEAD` and posts a `review-run` (round, `head`, selected subjects, tags, verify results, parent findings, `routed: false`). A `HEAD` that differs from the open round's restarts it as a new round.
2. `review`: launches the missing reviewers in parallel (`subagent_packet`/`subagent_record` inline without an executor). A reviewer's packet holds no other reviewer's output.
3. `aggregate`: merges the findings of all reviewers into one `finding-summary` aggregate, with the parent findings added.
4. `verify`: sends each finding that needs it to a `verifier` child.
5. `route`: runs `finding-scope` per finding, applies the effects and updates the `review-run` with `routed: true`.

A routed round is final: a second call posts nothing. Retried stages are idempotent because every comment has a derived id.

**Selection and personas.** `selectSubjects` takes the `reviewer` entries of the `review` phase in the pack that hold for the change facts: the whole-change reviewer always, and the personas (`security-auditor`, `test-engineer`, `web-performance-auditor`) by tag. Tags are the units' plus tags re-derived from the diff (`retag`, through the `tags` rule, e.g. an `auth/` path adds `security`); they are recorded on the `review-run` and never written to the units. A persona's agent file and skill come from the content tree.

**`constraints-not-weakened`.** `checkStandards` parses the diff and reports a CRITICAL `lowered-standard` finding for an added `skip`/`only`, a suppression (`@ts-ignore`, `eslint-disable`, `@ts-expect-error` without a reason), a deleted test file, or a test file that removes more assertion lines than it adds. It cites `specs/constraints.md` when present. These parent findings are not sent to a verifier (`verify: skipped-parent`). A unit whose `Verify` is red at review also yields a CRITICAL parent finding on its first file.

**Verifier and `DISPUTED`.** `subagent_dispatch verifier` takes a `finding` reference (`<aggregate comment id>:<index>`) and its packet carries that finding and the code it points at. The child returns `verdict: confirmed | refuted` and a `reason`, recorded as a `finding-summary`. A refuted finding is `DISPUTED`: it blocks nothing and is listed at the `ship` gate with the verifier's reason. Only findings that went to the verifier can be disputed; `missed-context` and parent findings skip it. A `finding_rebut` rebuttal is listed the same way. A finding that is neither verified nor resolved blocks.

**Routing.** `routeFinding(finding, facts)` is pure and sits behind the `finding-scope` rule (default mode, no question). In order:

- a `SUGGESTION` is `record`ed (except `missed-context`);
- `needs-decision` is a `question`: one non-blocking question, raised once, keyed by `finding:<comment id>:<index>`;
- a path in a unit's `Files` is `unit`, routed to that unit;
- a path in the diff, or `missed-context`, is `in-change`;
- anything else is `out-of-scope`: it never blocks and is listed at `ship` as a follow-up.

A deleted test file stays in the change through the diff. Reviewer-supplied scope is ignored in an aggregate; the route is always recomputed.

**Rebuild marker.** A `unit` finding posts `rebuild.<unit>.<round>` and unticks the unit in the issue body, so the change returns to `build`. `unit_start` on a unit with an open marker accepts a green `Verify` (verdict `rebuild`; a red one still starts red). `unit_finish` posts a new receipt and ticks the unit again; a receipt older than the marker does not count as a tick to reconcile. The marker is derived from comments in `src/evidence`, never from session memory.

**Cap.** `loops.review_rounds` is derived from the `review-run` records newer than the latest lifting stuck answer. It blocks when the count reached the cap, the latest round is routed and its aggregate left a blocking `unit` or `in-change` finding; the next step is then `spec_stuck`, and a chosen answer restarts the budget. A last round that ends clean before the cap never blocks.

**Gate.** The `review-clean` check of the pack passes when the latest round was run at the current `HEAD`, is routed, and has no blocking finding (`unverified`, `blocking`, or an unanswered `question`). Any new commit fails it until a new round. The gate record holds `head_sha`, so approving `review` binds to the reviewed code.

**Ship payload.** The gate payload of `ship` (`src/review/payload.ts`) lists the review result: disputed findings with the verifier's reason, rebutted findings, follow-ups (`out-of-scope`), and the subjects that ran inline, so the human sees what no child verified.

## Ship

The `ship` phase publishes the reviewed code as one pull request. The code lives in `src/ship/`; the tools are `docs_table`, `change_ship` and `change_push`.

**Reviewed SHA.** The `head_sha` of the latest valid approved `review` gate. `change_ship` and `change_push` refuse unless `HEAD` equals it. The only exception is the clean-merge exception: every first-parent commit after the reviewed SHA must be a merge of the integration branch whose tree equals a fresh `git merge-tree` of its parents (no conflicts resolved by hand, no later edit). It needs git ≥ 2.38; older git falls back to strict equality with the reviewed SHA. Any other new commit sends the change back to `review`.

**Head-bound gates.** Both gate results carry `head_sha`. An approval at an older `HEAD` is not reused, except through the clean-merge exception. A fix that touches any file under `specs/`, or that gives `durable-docs` a confirmation item the latest `ship` record does not list, needs the `ship` gate again before it is pushed (see Re-confirmation).

**`docs_table`** writes the `## Durable docs` table of the issue body. An `updated` row must name a file in the change diff, a `not needed` row needs a reason, and hard-rule rows (a new capability, a constraints change) cannot be waived. Missing or inconsistent rows block the `ship` gate.

**`change_ship`** refuses, pushing and opening nothing, unless: the change is in `ship`, the tree is clean, the current branch is the issue's `Branch` line and the issue has no `PR` line; the ship gate has an approved result not listed by a newer `stale` comment and `HEAD` is reviewed against it; no human comment on the issue changed after the gate result and the gate digest still matches; every changed file is in some unit's `Files` or under `specs/`; and no other open pull request has the branch as head. When freshness is the only reason, it writes a `stale` comment for `ship` and does nothing else. It pushes through `guardedPush` (the only `git push`, refspec taken from the issue), opens one pull request (or adopts the account's own open one with `Refs #<issue>`) and records `PR: #<n>` plus a `ship` record. The body says `Refs #<issue>`; closing keywords are never written (a phrase from the Proposal is rewritten to `Refs #<n>`), so the forge cannot close the issue on merge. A retry after a partial ship resumes from the recorded state.

**`change_push`** first polls the pull request feedback and refuses when the poll fails or ingests new feedback. It then refuses, pushing nothing, unless: the change is in `ship`, the `PR` line names an open unmerged pull request, the tree is clean, the branch is the issue's `Branch` line, the pushed head exists, `HEAD` is reviewed, every changed file is in some unit's `Files` or under `specs/`, `HEAD` descends from the pushed head, and the `durable-docs` check reports no error. When any commit since the pushed head changes a file under `specs/`, or the check has a confirmation item the latest `ship` record lacks, it also needs an approved ship gate at `HEAD` (re-confirmation). It never opens a second pull request and says so when `HEAD` equals the pushed head.

## Pull request feedback

While a change is in `ship` with an open pull request, `pollFeedback` (`src/ship/feedback-poll.ts`) runs at `session_start`, on `/livespec next` and inside `change_push`. It is single-flight per session and never throws; failures go to the session error list.

**Mapping.** Human items become findings of a `review-run` with `source: pull-request`:

- a located review comment → `WARNING` `defect`, `in-change`, at `path:line`;
- a conversation comment or a review body → `WARNING` with scope `needs-decision`, at `pr#<n>`;
- a failing CI check on the pushed head → `CRITICAL` `defect`, `in-change`, at `check:<name>`.

Own comments (the current login with a livespec marker) are skipped. Comments from authors without write permission are ignored. The forge account may be shared, so the marker, not the login, decides.

**Ingest once.** Each item has a key: `comment:<id>@<updatedAt>`, `review-comment:<id>@<updatedAt>`, `review:<id>@<updatedAt>`, `check:<pushedHead>:<name>`. GitHub keeps a review's `submitted_at` on an edit, so its adapter appends a body hash to `updatedAt`. A round records its `feedbackKeys` and later polls skip them; an edited comment is a new version and comes back. A round posts the `review-run`, a `stale` comment for `review` and `ship`, then moves the change to `review`; an interrupted round is finished by the next poll, not duplicated.

**Routing.** `spec_review` aggregates and routes a feedback round like any other round (no reviewers run) and counts it toward `loops.review_rounds`. The fix stays on the same pull request; the review gate must pass again at the new `HEAD` before `change_push`.

**Re-confirmation.** `change_push` is allowed only when the review gate is approved at `HEAD` (or the clean-merge exception holds). It also needs the `ship` gate at `HEAD` when any commit since the pushed head changes `specs/`, or when `durable-docs` has a new confirmation item the latest `ship` record does not list. While that is missing, the next step is the ship gate's own decision (ask for it, show requested changes, or ask the human after a dismissal).

## Close

A human merges the pull request; livespec never merges. A merged pull request is detected in any phase at refresh (the next step is `change_close`, also when it merged during a fix round). The next step after a merge is the advance to `close`; `advance` refuses to move without a merge. Only then is the next step `change_close`.

**`change_close`** requires a merged pull request. In order, it posts the `close-summary` record, ticks the entry in its initiative (closing the initiative with its own summary when the last entry is done), closes the issue (it stays open until then) and emits the events. Every write is idempotent, so a retry after a partial close or after the initiative closed finishes the rest. It refuses an initiative that does not list the change.

**Abandon.** A pull request closed unmerged keeps the change in its current phase, with an abandon step: `change_close` with `abandon: "<reason>"` closes the issue recording that reason, and an abandoned change has nothing left to do.

**Events.** `livespec:change-closed` (`{ change, pr }`, plus `initiative` whenever the issue has an `Initiative` line, and `abandoned: true` on the abandon path) and `livespec:initiative-closed` (`{ initiative, changes }`) are emitted in-process on the pi event bus, once per close. Nothing is written to the forge for them.

## Initiatives

An initiative groups changes that ship separately but depend on each other. It is a tracking issue labelled `livespec:initiative` with `Goal`, `Capabilities` and a `## Changes` list of entries `- [ ] #<n> <name> — Depends: <#a, #b | —>`; each change names it with an `Initiative: #T` line and lists its own `Depends`. The code lives in `src/initiatives/`, and the engine reaches it only through registered hooks (gate effects and validators, refresh facts, card sections).

**Split rule.** At `shape`, the `split` rule (`decisions.split: { mode: rule }`) compares the declared capabilities and the drafted units with the pack `limits`. Over either limit it returns `propose`, and the shape card names `initiative_propose`. It never asks.

**Propose and its gate.** `initiative_propose` drafts the initiative (name, goal, capabilities, entries with a short Proposal and `Depends` by name, the current change as one entry) and sends the named `initiative` gate. `spec_gate initiative` refuses and names the tool, because a bare request has no drafts. Nothing is created before approval. The tool refuses a cycle (`#34 → token-store → #34`, also through existing changes and at answer validation), a self dependency and a name already taken. An approval creates everything in one gate effect, in order: the tracking issue, the new change issues in `shape` (topological order), the `## Changes` list and the current change's `Initiative`, `Depends` and Proposal. Each step finds before it creates, so a crash leaves the request applying and the next poll finishes it.

**Amendments.** When the current change already has an `Initiative` line, `initiative_propose` amends that initiative through the same gate: it adds changes (also mid-way, in any phase), edits the Proposal of a change with no units or the `Depends` of a change not started, and removes an abandoned dependency or the entry of an abandoned change. After a removal, the normal `change_close` of the last remaining entry closes the initiative.

**Readiness.** A dependency is merged when its issue is closed, its `PR` line names a pull request, and the forge reports that pull request merged. Anything else waits: open, or closed without a merged pull request (shown as abandoned). The facts are read at refresh, never stored. `change_start` refuses while a dependency is not merged and names each one with its state; the not-started card says "waits for #A, #B".

**Card.** A change in an initiative shows the initiative's progress and the entries that are ready to start. The open-changes list marks each change `ready`, `waits for #n` or `parked`. Another open change with a `Branch` whose `Capabilities` share a name with this one is a warning on the card and in `spec_status`.

**`change_sync`.** Once a sibling in the initiative merged and `origin/<integration>` is not an ancestor of HEAD, the next step in `build`, `review` and `ship` is `change_sync`. On a clean tree with no started unit it fetches and merges the integration branch (a conflict aborts and refuses), writes the new `Base` and `livespecBase`, re-runs every done unit's `Verify` and posts one `regression` record. Done units whose `Verify` is red or invalid, or whose `Covers` names a requirement the sibling changed under `specs/`, are unticked and made stale (`after_plan: false`, not a counted iteration), so `unit_amend` comes before build continues; a change past `build` returns to `build`.

**`change_split`.** `change_split #N --units U5,U6 --into <name>` moves pending units (not started, not in a lane, not parked) into a new change in `shape`. It refuses while #N's `plan` gate request is pending, and when a remaining unit depends on a moved one. The new change gets `Depends: #N` only when a moved unit depends on a unit that stays, the moved units' capabilities (removed from `#N` when no remaining unit covers them), and the entry right after `#N` in its initiative; without an initiative and with that dependency, a `<name>-split` initiative is created. `#N` loses the units, gets a `stale` comment for `plan` and later phases, and returns to `plan`, so its plan gate is approved again within the limits.

**`size-limits`.** The waivable `plan` check fails when the plan has more units than `limits.max_units` (8) or more declared capabilities than `limits.max_capabilities` (3), with the messages "<n> units exceed max_units <m>" and "<n> capabilities exceed max_capabilities <m>". A `waive` or a `change_split` clears it. An in-session approve is not offered while it fails.

## Discovered dependencies

A unit may find, during build, that it needs work outside the change. The code lives in `src/deps/`.

**Gate.** An implementer that returns `BLOCKED` with reason `missing-prerequisite` (dispatched or recorded inline with `subagent_record`) makes the next step `new_dependency`. The tool drafts every option and sends the blocking named `new-dependency` gate; nothing is created before approval:

- **A** (default; an approval without a choice counts as A): create the prerequisite change in `shape`, inside the change's initiative or else in a new `<change>-deps` initiative, and add it to this change's `Depends`; cycles are refused as for initiatives. The next step is `change_park`.
- **B**: add units; the next step is `unit_amend --add`.
- **C**: a stub in this change plus a follow-up change in `shape`; the next step is `unit_amend` for the stub.
- **D**: back to `shape` (a `stale` comment listing `shape` and later phases, not a counted iteration), or drop the change, after which `change_close --abandon <reason>` is accepted without a pull request.
- **split**: offered only when some units are done and some are not; the next step is `change_split` at that boundary.

`discovered_deps` is derived: the approved `new-dependency` results with choice A, B, C or split. At `loops.discovered_deps` (2) the tool refuses and a missing-prerequisite result names `spec_stuck`; a chosen stuck answer lifts the cap. Choice D does not count.

**Park.** `change_park` runs after choice A, on the change branch, in the parent session. Each started unit with work (a lane with commits or uncommitted edits, or the change worktree) is committed to a wip branch `<Branch>--wip-<unit>` (message `wip(<unit>): parked for #<n>`) and pushed through `guardedPush`, with the refspec built from the issue's `Branch` line. A unit with no work gets no branch. Lanes are closed with outcome `parked` and their worktrees removed, the change gets the label `livespec:parked`, and a `parked` record listing the units and the dependencies it waits for is written last, so a rerun after a failed push completes the park. The parked units return to pending with a fresh attempt budget. While parked, the card says "waiting for #X to merge" and the gates refuse except `new-dependency` and `initiative`, so an abandoned prerequisite can still be removed.

**Resume.** Once every waited-for dependency merged, the next step is "a human runs `change_resume #N`". On a clean change branch it runs the `change_sync` steps (merge, new `Base`, `regression` record, regressed units unticked) and then merges each wip branch with `--no-ff` in unit order. A conflict aborts, refuses and names the branch; a rerun skips wip heads already merged. It then deletes each wip branch on `origin` through the guarded delete with a lease on the recorded head; a branch already gone counts as deleted; a moved head or a record that is not this change's wip branch is kept and named; any other failure refuses and keeps the change parked, and a rerun completes it. It posts a `parked` record with `resumed: true` and removes the label. A resumed unit's partial work is already in HEAD, so its next `unit_start` accepts a green `Verify` with verdict `resumed`.

## Durable docs

One trigger and one check per durable file, enforced by code. The code lives in `src/docs/`; the default pack lists the three checks in `define` and `review`. None is waivable.

**`product-impact`.** Reads the `Product impact` line of the change issue. The value must be `updated` or `none — <reason>` with a non-empty reason; a missing line, `—`, an empty value or anything else is an error. `none` with a `new` capability is also an error.

**`glossary-terms`.** Reads the lines `git diff <Base>..HEAD -- specs/` adds to `specs/<capability>/spec.md`, outside front matter. A candidate is a bold term (not `WHEN`, `THEN`, `AND`, `GIVEN`) or a capitalized word that is not at a sentence start, not in backticks, not all capitals and found nowhere under `specs/` at `Base`. A candidate with no glossary entry (equal ignoring case and a trailing `s`) is a `warning`, never an error. The define gate payload has a "Glossary" section with the warnings and the entries the diff adds to `specs/glossary.md`; approving the gate approves those entries.

**`behavior-change`.** A rule (`decisions.behavior-change: { mode: rule }`) that always asks, with the options `unchanged` and `changed`.

- **Facts.** Per living spec whose `paths` match a changed non-`specs/` file in `Base..HEAD` while its `spec.md` is not in the diff: `{ capability, files }`, files sorted.
- **Record.** A `decision` comment with subject `<capability>`, source `human`, the item as facts, a top-level `files` field (kept when the facts are compacted to `facts_hash`) and the SHA-256 of the files joined by newlines as digest. It is reusable only for the same digest and facts, so a new file under the capability asks again and re-editing the same files does not.
- **Check.** Per item: no reusable record is an error naming `spec_gate <phase>` (or the open `decide:behavior-change.<capability>` request); a `changed` record is an error naming `specs/<capability>/spec.md`; `unchanged` passes. An item leaves the facts once its `spec.md` is in the diff.
- **Asking.** `spec_gate define` and `spec_gate review` first run the checks and refusals without the `behavior-change` results. Any refusal returns before anything is asked or written. Otherwise each unanswered capability is asked through the approver chain, one at a time; the state is refreshed and the full check run again, so a `changed` answer refuses in the same call. A pending forge request makes `spec_gate` refuse, naming it. A flow that does not list the check asks nothing.

**Ship reuse.** The ship `durable-docs` rule stays pure and never asks. `DurableFacts.behavior` holds, per capability, the latest `behavior-change` record with source `human`. A capability needs no confirmation item when that latest record is `unchanged` and its files include every file the ship diff changes under the capability's `paths` (a superset is accepted: the ship diff starts at the merge base, the records at `Base`). Without such a record the confirmation item stays, as for the small-fix lane, which has no issue.

**Packet readers.** Every packet already carries a `specs/product.md` excerpt, and the first model card says to read it. `src/docs/readers.ts` adds two sources for `implementer` and `reviewer` packets: `glossary` (the entries whose term occurs in the unit text, or the `## Units` section for a reviewer; omitted when none match) and `decisions` (accepted decisions with `spine: true` or whose `capabilities` intersect the change's). Reviewer manifests also include `constraints`.

## Audit

`/livespec audit [#T]` finds drift between `specs/`, the code and the other durable docs. It runs outside any phase, with no change, and is read-only: it edits no file and creates no issue, branch or pull request. Its code lives in `src/audit/` and `src/commands/audit.ts`.

**Snapshot.** It fetches the integration branch and audits the tree of `origin/<integration>` (the audited commit) through `git ls-tree` and `git show`, never the working tree, so the result does not depend on the current branch. When the fetch fails and a local `origin/<integration>` exists, it audits that commit and the report says the snapshot was not refreshed. With no such ref it refuses, posts nothing and leaves the state unchanged.

**Detectors.** Pure functions over the files of the audited commit, each item keyed `<type>:<subject>`:

| Type | Item |
|---|---|
| `scenario-untested` | a scenario name that occurs in no test file |
| `removed-reference` | a backticked path that is not tracked, or an identifier found in no file outside `specs/` |
| `dead-paths` | a living spec `paths` glob that matches no file |
| `unused-term` | a glossary term used in no other file |
| `stale-decision` | a line under `specs/` that names a `superseded` decision without saying so |
| `product-missing` | a capability absent from `specs/product.md` |
| `declared-none` | a merged `fix/*` pull request whose `lane` block declares `behavior_change: declared-none` (per listed capability) |

`declared-none` reads the first-parent commits of `<fix cursor>..<audited commit>` (without a cursor, the last 30 days) whose subject names a pull request. It needs the forge; when the forge cannot be read it is skipped with a note and the other detectors still run.

**Scout confirmation.** `scenario-untested` and `removed-reference` items go to one `scout` child through the dispatch API, in a temporary worktree of the audited commit (removed afterwards), with thinking `low` and no model. The packet has the protocol layer, no flow skills, the audited SHA and the items as untrusted data. The child returns a `confirmed` or `refuted` verdict per key; refuted items are listed under "Refuted by the scout" and not classified. The audit never runs the scout inline: with no capable executor, a disabled scout agent, a launch mismatch or a missing verdict, the items are kept and marked unconfirmed. No `dispatch` comment is written.

**`drift-severity`.** A rule (`decisions.drift-severity: { mode: rule }`) that never asks. Facts: `{ type, capabilityHasMajor }`. `scenario-untested`, `dead-paths` and `removed-reference` are `major` (route `change`); `unused-term`, `stale-decision` and `product-missing` are `minor` (route `small-fix`); `declared-none` is `major` when another major-type item names the same capability, else `minor`. Routes are suggestions.

**Report.** The report lists the audited commit, the items by severity with key, evidence and route, then the refuted and ignored items and the notes. With `#T`, or else the oldest pending initiative suggestion, and a writable forge, it is posted as a new own `drift-report` comment on that initiative (items as data plus the rendered text) and printed. Otherwise it is only printed, with the reason.

**Triage.** A writer replies on the initiative with `/livespec triage <key> major|minor|ignore` (a comment, not a session command). The next audit on that initiative applies the latest command per key from authors with `write` or `admin`: `major` and `minor` set severity and route and mark the item re-triaged with the author and the rule's original severity, `ignore` moves it to "Ignored". A key that matches no item is listed as unmatched. Triage is not applied when there is no target initiative or the forge cannot be read; a read-only forge can still print a triaged report.

**Suggestions and state.** `<git common dir>/livespec/audit.json` holds `cursor`, `fixCursor`, the last audited commit and the pending suggestions. It is local, shared by the worktrees of a clone and updated under a lock; deleting it drops all pending suggestions and both cursors, and commits older than the next first scan are not suggested again.

- `livespec:initiative-closed` adds an initiative suggestion.
- At `session_start`, without a fetch, the session checks the oldest 50 first-parent commits of `<cursor>..origin/<integration>` and moves the cursor to the last one checked; a longer backlog is worked off 50 per session. A commit that touches a capability's `paths` and whose subject names no pull request with a `livespec/*` or `fix/*` head becomes a commit suggestion. With no state the first run only sets the cursor; a forge error leaves it unchanged.
- While suggestions are pending the phase and resume cards show an "Audit" section naming each reason and `/livespec audit`.
- A completed audit clears the commit suggestions contained in the audited commit and the initiative suggestion it posted on, records the audited commit, and moves `fixCursor` to it only when `declared-none` ran to the end.

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
