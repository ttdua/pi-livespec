## Context

The current code base has two layers. LS-02 added the parsers and validators in `src/core/` and LS-03 added the forge layer in `src/forge/`. The extension (`src/extension.ts`) registers `/livespec` (version, `validate`, `migrate-openspec`) and `spec_validate`. Nothing yet reads a change's state, loads a flow, builds a `Forge` at session start or touches pi's context.

The relevant pi seams are from `docs/evidence/host-seams.md` and the pi extension docs:

- **Skill subsets (probe (b)).** `resources_discover` can return single skill directories, so a subset of skills can be exposed.
- **Phase card cost (probe (c)).** A message appended at the end of the messages by `context` and replaced each turn keeps the earlier messages cached.
- **Superpowers override (probe (a)).** The per-project Superpowers override only takes effect in a trusted project. `ctx.isProjectTrusted()` reports trust.
- **Static system prompt sections.** `before_agent_start` can set `systemPromptOptions.sections`. pi only patches sections whose text changed, so a section whose text never changes costs nothing after its first turn.
- **Loaded skills.** `ctx.getSystemPromptOptions().skills` lists the loaded skills with their paths. When names collide, the first one wins.

The project brief limits runtime dependencies to `yaml` and requires `git`.

## Goals / Non-Goals

**Goals:**
- The state of a change is rebuilt from the issue and git at any time. Nothing durable lives in session memory.
- The decision logic (`nextStep`, card rendering, pack merge and validation, upgrade policy) is pure and table-tested without pi, a network or a forge.
- Later specs extend the flow by registration (sub-schemas, named checks, card sections, doctor checks) without editing LS-04 modules.
- The context injection never breaks the prompt cache prefix.

**Non-Goals:**
- Gates, approvals and the `spec_gate` and `plan_units` tools (LS-05).
- `Verify`, receipts, unit start and finish, and guards (LS-06).
- Subagent policy (LS-07). The engine only validates `subagents` through a registered sub-schema.
- Writing `## Units`, updating from the integration branch, and pushing. LS-04 states the merge-only rule, but no LS-04 operation merges.

## Decisions

### Module layout

```text
src/config.ts                 user + project config (yaml), typed with defaults
src/packs/agent-skills.yaml   default flow pack (ships inside src/, see below)
src/engine/
  pack-schema.ts              hand-written schema walker → PackError[] with line/col
  pack-load.ts                load default + override, merge by phase id, validate
  registry.ts                 registerPackSchema, registerCheck, registerCardSection, registerDoctorCheck
  checks.ts                   the four LS-02 named checks + runChecks
  snapshot.ts                 readChangeSnapshot (forge + git facts) → ChangeState
  comments-cache.ts           per-issue marked-comment cache keyed by issue updatedAt
  next-step.ts                nextStep(pack, state) — pure
  advance.ts                  advancePhase(forge, issue, to)
  counters.ts                 counter read/write helpers (kind `counter`)
  git.ts                      branch, HEAD, dirty, integration branch resolution
  resolve-change.ts           branch → change issue, open change listing
src/content/
  paths.ts                    ~/.pi/agent/livespec/agent-skills layout
  lock.ts                     livespec.lock read/write
  mirror.ts                   bare mirror fetch + checkout into staging (git only)
  compat.ts                   compatibility check over a checkout
  upgrade.ts                  upgrade policy (pure) + apply (switch, lock, diff)
  expose.ts                   pack → skill paths for resources_discover
src/hooks/
  routing-note.ts             static note text
  phase-card.ts               renderCard(nextStep, state) — pure
  context.ts                  before_agent_start section + context append
  session.ts                  session_start: forge, snapshot, resume card, upgrade kick-off
src/commands/  init.ts  doctor.ts  skills.ts  next.ts
src/tools/     spec-status.ts  spec-next.ts  skill-note.ts  spec-write.ts  change-new.ts  change-start.ts
src/core/sections.ts          sectionText / replaceSection / setHeaderLine (byte-preserving)
```

The split follows responsibility: pure decision code (`pack-schema`, `next-step`, `phase-card`, `upgrade` policy, `sections`) and I/O shells (`snapshot`, `mirror`, `session`, tools). A `Session` object created in `session_start` holds the forge, the loaded pack, the config and the last snapshot. Hooks and tools read it through one accessor. It is a cache of derived data, never a source of truth.

### Pack file location

The default pack ships as `src/packs/agent-skills.yaml`, not as a top-level `packs/` folder. `package.json` publishes only `src/`, and keeping the pack there avoids a manifest change. `docs/architecture.md` is updated to match.

### Pack schema and line/column errors

The pack is parsed with `yaml`'s `parseDocument` and a `LineCounter`. The schema is a small hand-written walker over the document nodes, not a JSON Schema engine. Each rule reports `{ file, line, col, path, message }` from the node's `range[0]`.

The walker checks:
- top-level keys `name`, `version` (1), `content`, `limits`, `loops`, `decisions`, `init` and `phases`, plus `extends` in an override;
- the phase keys `id`, `requires`, `per` (`unit`), `skills.required`/`optional`, `outputs`, `redirects`, `checks`, `gate` (`none` | `self` | `human`, default `none`) and `subagents`;
- that no key names a model or a lane count (`model`, `models`, `lanes`, `lane_count` are rejected, ADR 0005).

**Unknown keys are errors.** They are typos more often than extensions.

Semantic checks run after the merge:
- ids are unique;
- every `requires` names a known phase, and the `requires` graph has no cycle;
- every `checks` name is registered;
- every output is one of `issue#Capabilities`, `issue#Proposal`, `issue#Design`, `issue#Units` or `specs-diff`;
- `using-agent-skills` and `context-engineering` in a skills list are warnings, since they are never exposed.

**Registered sub-schemas.** `registerPackSchema(key, validate)` attaches a validator to `decisions` (top level) or `subagents` (per phase). The validator receives the YAML node and a reporter, so its errors carry line and column too. A key with no registered validator accepts only an empty map or an empty list. A non-empty value is an error that names the spec which registers it.

**Invalid pack.** Errors stop the flow. The phase card shows only the pack errors, the livespec tools refuse with the same list, and `resources_discover` exposes no skill.

### Override merge

`.pi/livespec/flow.yaml` must contain `extends: agent-skills`. Without `extends`, it is a complete standalone pack and is validated as one.

With `extends`:
- `phases` merge by `id`. A phase with a known id replaces only the keys it sets. A new id is appended after the default phases, and its position in the flow comes from `requires`.
- The maps `limits`, `loops`, `decisions` and `init` merge one level deep.
- `name`, `version` and `content` must not be overridden.
- A phase cannot be removed in v1. A project can set `gate: none` and empty skills instead.

Each merged value keeps its origin `{ file, range }`, so errors point at the file that supplied the value. The merge is a pure function over two parsed documents.

### Change state and next step

`readChangeSnapshot(forge, git, issueNumber)` collects facts into a plain `ChangeState`:
- **Issue facts:** number, title, labels, phase (from the single `livespec:phase/*` label), the parsed `Change` (LS-02), and section presence from `sectionText`.
- **Comment facts:** own marked comments, grouped by kind (counters, skill notes, `incomplete`).
- **Git facts:** branch, HEAD, dirty, and whether `specs/` changed between `Base` and HEAD.
- **Mode:** the read-only flag, plus stale marking and warnings.

Then `runChecks(pack, phase, ctx)` runs the phase's named checks and adds their `Result[]` to the state. It is impure: it reads `specs/` and runs `git diff`.

`nextStep(pack, state)` is pure and is only called with a valid pack. Callers check the pack first and show the pack errors instead. It returns `{ phase, required, optional, redirects, checks, blockingQuestions, counters, activeUnits, incomplete, advance?, next }`. The `next` sentence comes from the first matching rule:

1. no or several phase labels;
2. the change is not started (no `Branch`) and the phase is after `shape` → `change_start`;
3. an open blocking question → answer it;
4. a missing output → which section to write and with which tool;
5. a failing check → which check and its first result;
6. in a `per: unit` phase such as `build`:
   - the next pending unit whose `Depends` are done;
   - when no unit is ready, the blocked units and their unmet `Depends`;
   - when every unit is done, this rule does not apply, and rule 7 decides;
7. the phase's gate:
   - `human` → "ready for the <phase> gate";
   - `self` → "checks pass; the <phase> gate can pass";
   - `none` → advance to the successor. This only happens when no earlier rule applies, so a `per: unit` phase advances only once every unit is done;
   - the last phase → "no further phase".

The successor of a phase is the first phase, in pack order, whose `requires` include it. A phase without one is the last phase. That gives custom packs with branches a fixed order.

The gate tools arrive with LS-05. Until then the sentence names the gate without naming a tool.

**Automatic advance.** `nextStep` only reports `advance`, and only for a `gate: none` phase. For the default pack, a completed `build` (`gate: none`) advances to its successor, `review`. A project that overrides `build` to `gate: human` or `self` stops at that gate instead. The session shell applies it through `advancePhase` when the forge is writable, then re-reads the snapshot. The function stays pure and the move is idempotent.

**Refresh policy.** The snapshot is rebuilt:
- at `session_start`;
- at `before_agent_start` (once per user prompt);
- after every livespec tool that writes;
- on `spec_status`, `spec_next` and `/livespec next`.

It is not rebuilt per LLM call inside a run. That keeps forge reads to a few per prompt. Inside a run the card may lag the agent's own git commits until the next prompt, which is acceptable because the card does not show HEAD.

### Comments cache and counters

`CachedForge` (LS-03) caches issues only. `comments-cache.ts` stores the **raw** comments of an issue in `<cacheRoot>/<host>/<owner>/<repo>/<n>.comments.json`, with `{ updatedAt, fetchedAt, comments }`.

- **Reuse.** The entry is reused while the issue's `updatedAt` matches and `fetchedAt` is less than 5 minutes old.
- **Invalidation.** Every livespec write to that issue drops the entry.
- **Filtering.** Marked comments are parsed and filtered by the current `whoami` login on every read (forge-markers rule), so an account switch never reuses another account's state.
- **Freshness.** The 5-minute bound covers forges where a comment edit or delete does not change the issue's `updatedAt`. This is not verified for every forge and version, and the bound keeps the cache safe without depending on it.
- **Read-only mode.** The cached copy is used and marked stale.

A counter is a `counter` comment with id `<loop>` or `<loop>.<unit>` and data `{ value }`. `setCounter` edits the existing own comment (own-marker edit, LS-03) or creates one. LS-04 reads the counters and shows them against the `loops` caps. Later specs increment them.

### Skill notes and the optional-skill reminder

`skill_note { skill, reason }` checks four things:
- the skill is in the active phase's `optional` list;
- the reason is one line;
- the reason has 1 to 200 characters;
- the forge is writable.

It then posts a `skill-note` comment (kind registered by this change) with id `<phase>.<skill>`.

A `tool_call` observer notes reads of `<clone>/<sha>/skills/<name>/SKILL.md`. The phase card lists optional skills read in this session that have no note. This in-memory set only drives a reminder and is not state.

### `advancePhase`

`advancePhase(forge, issueNumber, to)`:
- allows a move forward to a phase whose `requires` includes the current phase;
- allows a move back to any earlier phase, for re-plan and rework loops (LS-05);
- refuses anything else.

It adds the new label first and then removes the old one. If the second step fails, the issue has two phase labels. The snapshot reports `phase-ambiguous`, and the next sentence says to rerun the move. The move never ends with no label at all.

Retries are idempotent:
- exactly one phase label that is not the target → normal move;
- only the target label present → success with no write;
- the target label plus exactly one other phase label → remove the other one;
- no phase label, or any other set → refuse with a repair hint.

### Integration branch

`integrationBranch` comes from the project config. Without it, the default branch is read from `git symbolic-ref refs/remotes/origin/HEAD`, which needs no change to the `Forge` interface. If that fails, the tool asks the user to set the key.

The rule "merge, never rebase" is stated in the routing note. No LS-04 operation updates from the integration branch.

### `spec_write`, `change_new`, `change_start`

**Section helpers.** `src/core/sections.ts` adds byte-preserving helpers built on `splitLines`/`joinLines`:
- `sectionText(body, name)`;
- `replaceSection(body, name, content)`, which creates the section in canonical order if it is missing;
- `setHeaderLine(body, key, value)`.

**`spec_write`.** Sections: `Capabilities` and `Product impact` (header lines), `Proposal` and `Design` (H2 sections). Validation:
- `Capabilities` must match `new [..], modified [..]` with kebab-case names;
- `Proposal` and `Design` must be non-empty and contain no H2 line;
- the whole new body must still parse with `parseChange`, and every other line must be byte-identical.

The tool writes with `updateIssueBody(n, body, expect)` using the version it just read. A conflict is reported and nothing is retried. The agent calls again and the tool re-reads.

**`change_new <name>`.**
- The name is kebab-case.
- The title is the name.
- The labels are `livespec` and `livespec:phase/shape`.
- The body is a template with `Depends: —`, `Capabilities: new [], modified []`, `Product impact: —` and empty `Proposal`, `Design`, `Questions`, `Units` and `Durable docs` sections.

It refuses when an open `livespec` issue already has that title.

**`change_start #N`.**
- It refuses on a dirty tree, an unknown or closed issue, a title that is not kebab-case, or an issue that already has `Branch` while no local `livespec/<name>` with `livespecBase` exists (that case is reconciliation, below).
- It runs `git fetch origin <integration>` and takes `origin/<integration>` HEAD as `Base`.
- It runs `git switch -c livespec/<name> <Base>` and stores the base in `git config branch.livespec/<name>.livespecBase <Base>`.
- It then writes `Branch:` and `Base:` with a version check.
- If the write fails:
  - **Definite rejection.** Only a `WriteResult` conflict counts. The tool switches back and deletes the new local branch.
  - **Unknown outcome.** Every thrown error counts, including `readonly`, which `CachedForge` raises for an in-flight transport failure, and `http`, which adapters raise when a success response cannot be parsed. The tool re-reads the issue. It succeeds only if `Branch` and `Base` equal the values it wrote. Otherwise, or if the re-read fails, it keeps the branch and says to rerun `change_start #N`.
- **Reconciliation.** A rerun with an existing local `livespec/<name>` that carries `livespecBase` reconciles:
  - the issue records the same branch and base → switch to the branch, no write;
  - the issue has no `Branch` line → write `Branch` and the stored base;
  - anything else → refuse and keep the branch.

  A local branch without the config key is refused.
- It never pushes.

LS-09 adds the `Depends`-merged check through `registerCheck`.

### Resolving the change at session start

On `livespec/<name>`, the change is the open `livespec` issue whose `Branch:` line equals the current branch. If none matches, the issue whose title equals `<name>` is used, with a warning that `Branch:` is not recorded. Several matches is an error.

On other branches, the card lists open `livespec` issues as `#N <title> (<phase>)`, capped at 10.

### Context injection

**Routing note.** In `before_agent_start`, the note is set as `systemPromptOptions.sections["livespec"]`. The text is a module constant, so it is byte-identical every turn and pi never patches it after the first turn. It holds:
- what livespec is;
- "all forge writes and pushes go through livespec tools";
- "updates from the integration branch are merges, never rebases";
- a short paraphrase of agent-skills' Core Operating Behaviors, with the line "Adapted from agent-skills by Addy Osmani, MIT License".

The note is written in our source, not read from the clone, so an upgrade never changes it.

**Phase card.** The `context` hook appends one message (role user, `customType: "livespec-phase-card"`) at the end of `event.messages`. The message is never persisted, so the hook input never holds an earlier card, and each turn's card replaces the previous one by construction. `renderCard` is pure and deterministic.

Forge text in the card is wrapped in `<untrusted>` tags: question text, issue title and check messages that quote content. On session start the card also says to read `specs/product.md`.

Registered card sections (`registerCardSection(name, render)`) are appended in registration order. LS-05 uses this for pending approvals.

**Uninitialized project.** There is no note and no per-turn card. At `session_start`, one display-only message suggests `/livespec init`. If an `openspec/` folder exists, it suggests `/livespec migrate-openspec` first (user decision). Nothing runs automatically.

### agent-skills clone, upgrades, exposure

**Layout** under `~/.pi/agent/livespec/agent-skills/`:
- `mirror.git`: a bare mirror;
- `<sha>/`: checked-out trees, immutable;
- `current`: a symlink, or a junction on Windows;
- `livespec.lock`.

The lock is YAML: `{ source, commit, pinned: sha|null, history: [sha], skipped: [sha], checkedAt }`.

Checkouts use git only:

```text
git --git-dir=mirror.git --work-tree=<staging> checkout -f <sha> -- .
```

It runs with a temporary `GIT_INDEX_FILE`, so the mirror's index is untouched and no `tar` is needed. The last 5 trees are kept for rollback. Older ones are deleted.

**Shared clone.** The clone is shared by all projects. So `agentSkills.channel` is read from the user config only. Doctor warns when a project config sets it. Pins live in the lock.

**Upgrade policy.** `decideUpgrade({ channel, lock, now, headSha, workInProgress })` is pure. It returns `skip(reason)`, `notify(sha)` or `install(sha)`. Rules:
- `pinned` (channel or lock pin) → skip;
- checked less than 24 h ago → skip, except for a manual `update`;
- `head` equals the current commit or is in `skipped` → skip;
- `workInProgress` → skip with reason;
- `notify` → notify;
- otherwise → install.

Every automatic fetch records `checkedAt`, including when the compatibility check fails. So a rejected commit is not fetched again within 24 hours. A manual `pin` or `update` that fails the check leaves the commit, the pin and the history unchanged.

**Work in progress.** It is true when any open `livespec` issue in phase `build` has a pending unit (one search call). LS-06 replaces this with the exact "started but not finished" fact through a registered predicate.

**Install.**
1. Check out into `.staging-<sha>-<rand>`.
2. Run `checkCompat(tree, pack)`:
   - every pack skill (default pack plus this project's override) has `skills/<name>/SKILL.md` whose front matter parses as a YAML map, with:
     - a string `name` equal to the directory name, which follows pi's name rules: lowercase letters, digits and single hyphens, at most 64 characters;
     - a string `description` of 1 to 1024 characters;
   - every persona named by a registered sub-schema (`personasOf`) exists in `agents/`.
3. On success, rename staging to `<sha>/`, create `current.tmp` and rename it over `current` (atomic), write the lock, and notify the skills that were added, removed or changed (by comparing the `SKILL.md` hashes of pack skills).
4. On failure, delete staging, keep `current`, and warn with the failing items.

At `session_start` this runs as a background promise that is never awaited by the hook. Failures are notified, never thrown.

**Commands.**
- `update`: an immediate fetch and install, ignoring the 24 h rule. It refuses while pinned or while work is in progress. Issue #4 says an upgrade never happens during unfinished work, so the manual path follows the same rule.
- `pin <sha>`: fetch if needed, check, switch, and set `pinned`. It refuses while work is in progress.
- `unpin`: clear the pin.
- `rollback`: switch to the previous `history` entry and add the current sha to `skipped`, so auto never reinstalls it, while a newer commit is still taken. It stays allowed during work in progress, as recovery from a bad commit.
- `status`: commit, pinned, channel, last check and kept trees.

**Exposure.** `resources_discover` returns the skill paths when:
- the project is initialized (`.pi/livespec/config.yaml` exists);
- the pack is valid;
- the clone exists.

The paths are the real paths `<sha>/skills/<name>` of every skill named in the pack (`required`, `optional` and `init.skills`), minus `using-agent-skills` and `context-engineering`. Real paths keep a running session on one tree even if an upgrade switches `current` during it. The new tree applies after `/reload` or in the next session, and the upgrade notice says so.

### Init, doctor and config

**Config.**
- Project `.pi/livespec/config.yaml` keeps the existing forge keys (`forge`, `host`, `githubHosts`, `giteaUrl`) and adds `integrationBranch`.
- User `~/.pi/agent/livespec/config.yaml` holds `agentSkills.channel` (`auto` default).
- `src/config.ts` reads both files and reports unknown keys as warnings. `detectForge` keeps its own reader, unchanged.

**`/livespec init`.**
- It writes only missing files:
  - `specs/product.md`;
  - `specs/glossary.md`, which validates with zero entries;
  - `specs/constraints.md`;
  - `specs/decisions/.gitkeep`;
  - `.pi/livespec/config.yaml`.
- It clones agent-skills if the clone is missing.
- It reports what was created, kept or failed.

A clone failure does not undo the files, and rerunning init finishes the job. `constraints.md` starts with the line `<!-- livespec:template -->`. While that line is present, the card asks the agent to draft the file with `constraint-driven-development` (from `init.skills`).

**`/livespec doctor`.** It runs a list of checks. Each returns `{ id, status: ok|warn|error, message, suggestion? }`, and the command only prints them. The checks:
- **Duplicate skills.** For each pack skill, find the loaded skill with that name in `getSystemPromptOptions().skills`. If its path is outside the clone, report it as shadowed with that path.
- **Pack skills missing from the clone.**
- **Superpowers.** Loaded skills include `using-superpowers`. Suggest the probe (a) project settings snippet, and report when the project is not trusted (`ctx.isProjectTrusted()`).
- **Clone state.** Present, commit, pinned, last check, leftover staging directories, channel set in a project config.
- **Forge.** Detection, `whoami`, read-only mode.
- **OpenSpec folder.** `openspec/` present while uninitialized → suggest `migrate-openspec`.
- **Registered checks** (`registerDoctorCheck`). LS-05 adds the approver line.

All I/O goes through an injected deps object, so tests run each check against fixtures.

### Session wiring and failure modes

`session_start`:
1. load the config and the pack;
2. if initialized, run `detectForge` wrapped in `CachedForge`;
3. resolve the change and build the snapshot;
4. show the resume card as a display message;
5. kick off the background upgrade check.

Each step catches its own errors and degrades:
- forge detection fails → the card says the forge is unavailable and the tools refuse writes;
- the pack is invalid → the card shows the pack errors.

A livespec hook never throws into pi.

### Testing

- **Pure modules.** Table tests: pack schema and merge with exact line and column, `nextStep` rules over fixture states, `renderCard` snapshots, `decideUpgrade`, `sections`.
- **Forge-facing code.** The LS-03 in-memory forge (`tests/forge/memory-forge.ts`).
- **Git-facing code.** Temporary repositories (`tests/helpers/repo.ts`), and local bare repositories as the agent-skills upstream, with no network.
- **Extension.** A fake `ExtensionAPI` (pattern of `tests/extension.test.ts`) that records handlers and drives `session_start`, `before_agent_start`, `context` and `resources_discover`.
- **Cache-prefix test.** Five simulated turns. The `livespec` section text is identical every turn, the output messages minus the last equal the input messages, and the last is the card.
- **Manual smoke.** A run of at least 5 turns through 9router, recorded in `smoke.md` in the probe (c) table format (user decision).
  - **Pass rule:** from turn 2 on, each hooked turn's cache-read is within one cache block of the control turn, or higher.
  - **Full misses:** an isolated full miss counts only if the control run shows none.
- **Default pack.** A canonical JSON fixture `tests/fixtures/agent-skills.pack.json`, transcribed from issue #4, is deep-compared with the loaded default pack.

## Risks / Trade-offs

- [The card lags git changes made inside a run] → the card shows no HEAD, and every livespec tool refreshes. The next prompt refreshes too.
- [Forge reads per prompt cost latency] → comments are cached by issue `updatedAt`, and the issue cache comes from LS-03. That is two or three calls per prompt.
- [The "work in progress" approximation blocks upgrades for a whole build phase, manual ones included] → conservative by design, following issue #4's "never". LS-06 narrows it. `rollback` stays available as recovery.
- [Symlinks on Windows] → a junction is used. v1 is tested on macOS and Linux only, as stated in doctor output on Windows.
- [The shared clone means pins are user-wide] → documented in `skills status`. A per-project pin is out of scope for v1.
- [Upstream renames a pack skill] → the compatibility check fails and the old tree stays. Doctor shows the missing skills, and the pack override can follow the rename.
- [The two-step label move can leave two labels] → it is detected and the card says how to repair. It never leaves zero labels.
- [The paraphrased Core Operating Behaviors drift from upstream] → accepted. The note is static on purpose, for caching, and is reviewed when packs change.
- [Unknown pack keys are errors] → a later spec must register its key before a pack can use it. That is intended: packs fail loudly.

## Migration Plan

This change only adds behavior. Uninitialized projects see one session-start suggestion and nothing else. To roll back, revert the PR. The clone under `~/.pi/agent/livespec/` can be deleted safely.

## Open Questions

- None blocking. The smoke run records which models were used, as probe (c) did.
