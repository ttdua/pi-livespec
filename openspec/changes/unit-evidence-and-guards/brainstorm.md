## Design Summary

LS-06 ([issue #6](https://github.com/ttdua/pi-livespec/issues/6)) builds the evidence that the parent session owns, and the guards that keep the agent inside the workflow. It stops two failure modes from the [project brief](../../../docs/project-brief.md):

- **The agent claims work is done without proof.** Only a livespec tool runs a unit's `Verify`, posts the receipt and ticks the unit ([ADR 0003](../../../docs/decisions/0003-parent-owned-evidence.md)).
- **The agent steps around the workflow with shell commands.** A `tool_call` guard inside pi blocks direct forge writes and pushes ([ADR 0004](../../../docs/decisions/0004-guards-inside-pi.md)).

After LS-06 a change can be built inline, with receipts, gates and guards (roadmap "What works after each spec").

### Intent and goals

- **Unit loop, inline.**
  - `unit_start U<n>` refuses unless the tree is clean, the unit is not frozen and every unit in its `Depends` is done. Otherwise it records the pre SHA and runs `Verify`, which must exit non-zero. A `Kind: refactor` unit is the exception: its `Verify` must pass at pre and at post.
  - **Verifier pending.** When the test does not exist yet, `unit_start` records the unit as "verifier pending". The implementer's first commit must then contain only test files listed in the unit's `Files`. `unit_finish` checks that this commit exists, touches only those files, and that `Verify` fails at it. That commit becomes the recorded pre.
  - `unit_finish U<n>` requires a clean tree and a matching digest, and runs `Verify` at HEAD, which must exit 0. It then posts the `receipt` and ticks the unit with the byte-preserving tick (LS-02). A failed finish counts as one attempt.
  - Only `unit_finish` can tick a unit.
- **Receipt.** `unit`, `digest`, `verify`, `pre: { sha, exit }`, `post: { sha, exit }` and the output, keeping its last 8 KB.
- **When `Verify` misbehaves.**
  - **Not red at pre.** `unit_start` refuses and points to `unit_amend`. Through an amendment (LS-05), the unit becomes a regression pin or is dropped, or its `Verify` is fixed.
  - **Not green at post.** The agent retries with the `debugging-and-error-recovery` skill and the error output. Reaching `unit_attempts` (3) marks the unit `BLOCKED` and asks for a stuck report.
  - **Rule `progress`.** Each failed attempt gets a signature: the failing test names plus a hash of the normalized error text. Two identical signatures in a row stop the retries early. That outcome is a decision record, and it asks for a stuck report.
- **Plan check `verify-red-on-base`.** It is registered with the plan gate and runs only when the plan gate is requested. For each unit, it runs `Verify` on `Base` in a temporary worktree and requires a non-zero exit. A unit whose test does not exist yet is exempt and shown as "verifier pending". A refactor unit is the reverse: its `Verify` must pass on `Base`.
- **Stuck report.** Every cap in this spec ends in `spec_stuck` (LS-05), with links to the receipts.
- **Guards** (`tool_call`, fail closed).
  - **Forge writes are blocked** unless they come from livespec tools:
    - `gh issue create|edit|comment|close|reopen`;
    - `gh pr create|edit|merge|comment|review`;
    - `gh api` with any method other than GET;
    - `tea` write subcommands;
    - `curl` or `wget` with a write method against the forge host.
  - **Pushes and pull requests are always blocked**, in every listed variant: `git push`, `git -C <dir> push`, `env … git push`, `sh -c "…git push…"`, `gh pr create|merge` and `tea pr …`. Nothing pushes until LS-09's tools.
  - A blocked command returns a reason that names the livespec tool to use instead.
  - Read commands are allowed.
- **Settle.** `agent_before_settle` asks for exactly one continuation, with a list, when any of these hold:
  - a unit was started and not finished;
  - the working tree is dirty;
  - a review is pending.

  If the work is still unfinished after that continuation, the hook posts an `incomplete` comment, and the next session's phase card shows it.

### Non-goals

- Subagent dispatch and unit review (LS-07, LS-08). "A review is pending" is a seam that LS-07 fills; in LS-06 it is never true.
- Shipping, pushing and pull requests (LS-09). LS-06 only provides the guard API that lets those tools push after their own checks.
- Blocking pushes made outside pi: no git hooks, no branch protection (accepted limit, ADR 0004).
- Guards in sessions that do not load this extension. LS-07 runs write-capable roles only in executors that load the parent's extensions, or inline (host-seams probe (e)).
- Commands hidden inside a script file that the agent runs (`bash ./x.sh`). This is an accepted limit and is written down in `docs/architecture.md`.

### Anti-goals (failure even if it "works")

- A unit is ticked, or a receipt is posted, without the parent having run `Verify` itself.
- An agent inside pi gets around a gate with `sed -i`, `gh issue edit`, `git -C . push`, `eval`, and so on, without being blocked or detected (project brief).
- The guard blocks ordinary build and test commands often enough that people turn it off.
- Settle loops: more than one continuation per agent run (probe (d): pi does not cap the chain).
- Running test suites on every turn. `verify-red-on-base` runs only when the plan gate is requested.

### Existing requirements this change touches

- **change-issue-format / Tick and untick units.** Consumed unchanged. The status line stays `- [ ] pending` or `- [x] done`. `BLOCKED` is a derived state shown by the card and the next step, not a third status line, so the body format does not change.
- **change-issue-format / Unit digest, Unit parsing.** Consumed unchanged (`Verify`, `Kind: refactor`, `Files`, `Depends`).
- **unit-planning / Digest lock and frozen units.** It already says the change state exposes frozen units "for LS-06's `unit_start` and `unit_finish`". LS-06 enforces that refusal. No requirement change.
- **forge-markers / Core kinds and registration.** `receipt`, `counter` and `incomplete` are already core kinds. The "unit started" record is a new kind added through `registerKind`. No requirement change.
- **flow-engine / Loop counters.** **Modified.** `unit_attempts.U<n>` is shown against the pack's `loops.unit_attempts`. Like `change_iterations`, it is derived from other own comments instead of a `counter` comment (see Key Decisions).
- **flow-engine / Next step precedence.** **Modified.** In `build`, a unit that is started and not finished comes before "the next pending unit", and a `BLOCKED` unit asks for a stuck report. The delta states this.
- **flow-pack / Default flow pack.** **Modified.** The `plan` phase lists `verify-red-on-base` next to its current checks.
- **phase-gates / Gate tool.** Consumed. The new check only runs when the plan gate is requested; the gate refusal rules are unchanged.
- **questions-and-stuck / Stuck reports.** Consumed unchanged. Caps in this spec send `spec_stuck`.
- **decision-seam / Rule registry and pack config.** Consumed. `progress` is a new rule registered with `registerRule`, `mode: rule`.
- **agent-skills-content / No upgrade during work in progress.** **Modified.** The requirement says "until a later spec registers a finer signal", and the LS-04 design names LS-06 as that spec. Work is in progress when an open change has a unit that was started and not finished.
- **context-injection / Phase card content.** Consumed. `incomplete` markers and counters are already listed; `BLOCKED` units appear in a registered card section.
- **Known gaps in `docs/architecture.md`.** LS-06 closes the first two:
  - same-login command comments posted through bash, closed by the forge write guard;
  - agent writes to `.pi/livespec/` that lower a gate, closed by a guard on that folder.

## Alternatives Considered

### Alternative A: Pure decisions plus thin tools and hooks
- **Approach**: Every business rule is a pure function over the change state and plain facts: start and finish refusals, red/green, receipt building, started/`BLOCKED` derivation, the `progress` signature and rule, and command classification for the guard. Running `Verify` (in the cwd or a temporary worktree) is one small runner. `unit_start`, `unit_finish` and the two hooks only load state, call the pure decision and write.
- **Pros**: Each rule is a table test over fixtures, with no pi and no forge. It follows the existing split (`gates.ts`, `spec-stuck.ts`, `next-step.ts`). LS-07 can insert review before finish, and LS-09 can call the guard's push API, without reopening the tools.
- **Cons**: More files.
- **Why chosen**: See Agreed Approach.

### Alternative B: Logic inside the tools and hooks
- **Approach**: Each tool checks, runs `Verify` and writes in one function; the hook parses and decides inline.
- **Pros**: Fewer files, fast to write.
- **Cons**: God functions; tests need a fake pi and a fake forge for every rule. LS-07 would have to reopen `unit_finish` to insert review.
- **Why not chosen**: It breaks the project's layering and the coding standards, and it makes the next two specs more expensive.

### Alternative C: Allowlist guard
- **Approach**: Same evidence code as A, but bash may run only commands on an allowlist, and everything else is blocked.
- **Pros**: The strongest possible guard.
- **Cons**: It blocks ordinary build and test commands, and every project has to configure it.
- **Why not chosen**: It contradicts the guard policy agreed below and the anti-goal of blocking ordinary work.

## Agreed Approach

**Alternative A** (user-approved). Pure decision functions are tested by tables; tools and hooks stay thin. The evidence state lives on the forge as tool-written marked comments ([ADR 0002](../../../docs/decisions/0002-issue-is-source-of-truth.md)), so sessions, settle, the card and the work-in-progress predicate all read the same facts.

## Key Decisions

- **`verify-red-on-base` runs only when the plan gate is requested** (user decision, recommended option). The result is memoized per `(Base, unit digest)` within the session, and the card shows the latest result. It does not run on every refresh, because checks currently run on every turn.
- **The started state lives on the forge** (from ADR 0002 and the LS-04 design, confirmed with the user).
  - `unit_start` posts a "unit started" marked comment with the pre SHA, the pre exit, the digest and the verifier-pending flag.
  - `unit_finish` posts the `receipt` once, complete. A receipt is never edited.
  - A unit is *started* when it has a "unit started" comment newer than its latest receipt.
  - Memory-only or `.git/` storage was rejected: it breaks ADR 0002 and the forge-only work-in-progress predicate.
- **`BLOCKED` is derived, not a status line** (my call). A unit is `BLOCKED` when its attempts counter reached `unit_attempts`, or when the latest `progress` decision for it says stop.
  - The card and the next step show it and ask for `spec_stuck`.
  - `unit_start` and `unit_finish` refuse a `BLOCKED` unit until a stuck report dated after the block is answered with a chosen option. A dismissed answer does not lift the block, as with `change_iterations`.
  - The status-line format of LS-02 stays unchanged.
- **The attempts budget restarts after a chosen stuck answer** (my call). Lifting a block gives the unit a new budget of `unit_attempts`, counted from that answer. Otherwise the block would come back on the very next failure.
- **The `progress` facts come from code, not from the agent** (ADR 0006). The signature is built from the `Verify` output that the tool captured: the failing test names it can extract, plus a hash of the error text with SHAs, paths, durations, timestamps and numbers normalized. The rule outcome is posted as a decision record keyed by `progress.U<n>`.
- **Guard policy for commands it cannot read** (user decision, recommended option). Commands it can parse are decided by the listed rules, including `sh -c`, `bash -c`, `env`, `git -C`, `command`, `exec`, `xargs`, `nice`, `timeout`, pipes and `&&`/`||`/`;` chains. Obscuring forms are blocked with a reason when the command text contains a dangerous token (`push`, `gh`, `tea`, or `curl`/`wget` with the forge host): `eval`, a variable or `$(…)`/backticks in command position. Running a script file is allowed, as an accepted limit.
- **The guard also covers `.pi/livespec/`** (my call, from the LS-05 known gaps in `docs/architecture.md`). `write` and `edit` on paths under `.pi/livespec/`, and bash commands that write there (redirection, `sed -i`, `tee`, `cp`, `mv`, `rm`), are blocked. The issue text does not list this, but the architecture says LS-06 closes it.
- **Guard escape hatch for livespec tools only.** A livespec tool can run a push after its own checks through a guard API; the agent has no parameter or command that opens it. LS-09 is its first caller.
- **Verifier pending is decided by code, never by a tool parameter** (my call, ADR 0006). A unit is verifier pending when at least one test file listed in its `Files` does not exist at the pre commit. The agent cannot ask for the exemption.
- **A failed `unit_finish` posts no receipt** (my call).
  - The unit stays started.
  - The `unit_attempts.U<n>` count is the number of failed post runs. It is derived from the `progress` records, not stored in a `counter` comment (revised after the brainstorm gate, during spec review). A stored counter would count twice when a tool is retried. It also could not be ordered against a stuck answer, because an edited comment keeps its old position. LS-05 made the same choice for `change_iterations`.
  - The failure signature goes into the facts of the `progress.U<n>` decision record, and the rule compares it with the previous record for the unit.
  - A receipt exists only for a green finish.
- **A valid red** (user decision, recommended option).
  - Exit 126 or 127 (the command could not run) and a timeout never count as a valid red at pre, nor as a valid red on `Base`.
  - A temporary worktree is prepared with the `verify.setup` command from `.pi/livespec/config.yaml` (for example `bun install --frozen-lockfile`). Without it, the common gitignored dependency folders that exist in the main worktree (`node_modules`, `.venv`, `vendor`) are symlinked into the temporary one.
  - Accepted risk: a symlinked folder can differ from what `Base` needs; `verify.setup` is the fix when it matters.
- **`verify-red-on-base` is a gate-only check** (my call). The check registry gains a flag for checks that run only when a gate is requested.
  - On an ordinary refresh, the check reports its memoized result for the current `(Base, digest)` pairs, or nothing when it has not run.
  - `spec_gate plan` runs it before the refusal rules, and its results go into the gate request's snapshot.
  - Completion of a forge answer does not rerun it: answer validation already checks that HEAD and the gate digest are unchanged, which pins `Base` and every unit.
- **Which stuck answer lifts a unit block** (my call). A stuck answer with a chosen option, dated after the block, lifts the block of every unit that was `BLOCKED` at that time. This mirrors `change_iterations`, so the stuck report requirement stays unchanged.
- **`Verify` goes through the guard classifier** (my call). The runner classifies the `Verify` command before it runs it. A blocked `Verify` (for example one that contains `git push`) is refused and points to `unit_amend`. Otherwise `Verify` would be a way around the guard.
- **Settle scope** (my call). The hook acts only when a change is resolved and either it is in a `per: unit` phase or one of its units is started. Elsewhere, a dirty tree is ordinary work and is left alone. When the forge is read-only, the hook posts no `incomplete` comment and only warns.
- **Settle continuation count is per agent run, in session memory** (my call). The hook asks once per run; probe (d) shows that pi will not stop the chain itself. The `incomplete` comment uses one fixed id per change and is edited in place, so repeated settles do not pile up comments. It is cleared from the card once nothing is unfinished.
- **`Verify` has a timeout** (my call): 10 minutes by default. A timeout is never a valid red at pre and is a failed attempt at post.
- **Receipt output keeps the last 8 KB** (issue default, my call to keep it). The open question stays open for tuning after dogfooding (LS-11).
- **Work in progress narrows** (from the LS-04 design). The work-in-progress predicate becomes "an open change has a started, unfinished unit", which unblocks agent-skills upgrades between units.

## Open Questions

- Is 8 KB of output per receipt the right limit? Kept as the default, to be revisited during dogfooding (LS-11).
- Which failing-test-name formats should the `progress` signature recognize beyond vitest, jest, `go test` and pytest? Unrecognized output falls back to the normalized error hash alone, which is enough for the rule to work.
