## Context

LS-05 left the seams that LS-06 fills:
- `ChangeState.lock.frozen` is exposed "for LS-06's `unit_start` and `unit_finish`".
- `receipt`, `counter` and `incomplete` are already core marker kinds.
- `registerWorkInProgress` waits for the started-unit signal.
- `registerCheck`, `registerRule` and `registerCardSection` take more entries.
- `src/hooks/context.ts` already owns a `tool_call` handler, which only records skill reads.

Host facts:
- **Probe (i).** `tool_call` sees the raw command string, including wrapper forms, and a blocked call never runs.
- **Probe (d).** A settle continuation raises a new `agent_before_settle` each time, so the extension must cap the chain itself.
- **pi docs.** An aborted run skips `agent_before_settle`.

Checks run on every `Session.refresh` (`src/hooks/card-input.ts`) and again when a gate answer is validated (`src/interaction/complete-validate.ts`).

The agreed approach, the user decisions and the non-goals are in `brainstorm.md` and are not repeated here.

## Goals / Non-Goals

**Goals:**
- the module layout;
- the evidence records and how state is derived from them;
- how `Verify` runs and what counts as red;
- the guard's parser and its rules;
- gate-only checks;
- the settle state machine;
- how each piece plugs into the engine, the card, the pack and the config.

**Non-Goals:**
- the non-goals in `brainstorm.md`;
- any change to the forge adapters, the marker format or the body format.

## Decisions

### D1. Module layout

Pure decisions are kept apart from I/O, as in LS-05 (`gates.ts`, `locks.ts`, `spec-stuck.ts`). Tools and hooks only load, call the pure function and write.

- `src/evidence/` (pure unless noted):
  - `records.ts`: the `unit-start` and `receipt` comment bodies and parsers. It registers the `unit-start` kind.
  - `unit-state.ts`: `deriveUnitEvidence(change, marked, loops)`, which gives started, receipted, attempts and blocked units.
  - `refusals.ts`: `unitStartRefusal` and `unitFinishRefusal`.
  - `red-green.ts`: classifies a `Verify` run as red, green or invalid, and decides pre and post for normal and refactor units.
  - `signature.ts`: extracts failing test names and the normalized error hash.
  - `progress-rule.ts`: the `progress` rule and its schema.
  - `pending.ts`: the verifier-pending test and the check of the test-only commit.
  - `runner.ts` (I/O): runs one command with a timeout and an output tail.
  - `worktree.ts` (I/O): a temporary worktree at a commit, prepared with `verify.setup` or with dependency symlinks, and always removed.
  - `red-on-base.ts`: the `verify-red-on-base` check and its per-session memo.
  - `wip.ts` (I/O): the work-in-progress predicate registered with `registerWorkInProgress`.
- `src/guard/` (pure, except `push.ts`):
  - `shell.ts`: a tokenizer and simple-command splitter for POSIX shell text.
  - `classify.ts`: `classifyCommand(command, ctx)`, which returns allow or a block with a reason.
  - `paths.ts`: the `.pi/livespec/` path test for `write`, `edit` and bash write targets.
  - `push.ts` (I/O): `guardedPush`, the only code that runs `git push`.
- `src/hooks/guard.ts`: the `tool_call` handler that calls `classifyCommand` and the path test.
- `src/hooks/settle.ts`: the `agent_before_settle` and `agent_start` handlers.
- `src/tools/unit-start.ts` and `src/tools/unit-finish.ts`.

### D2. Evidence records

Two kinds of own marked comment hold the evidence. Both are append-only: a receipt is never edited.

**`unit-start`**
- Id: `U<n>.<base36 ms>`.
- Data:

  ```
  { unit, digest, verify, pre: { sha, exit, verdict, output }, pending?: true, refactor?: true }
  ```

  - `verdict` is `red`, or `green` for a refactor unit.
  - `output` is the tail of the run's output.
  - A unit that is verifier pending has no `pre.exit`. Its `pre.sha` is the HEAD at start, and the pre is fixed at finish (D5).

**`receipt`**
- Id: `U<n>.<base36 ms>`.
- Data:

  ```
  { unit, digest, verify, pre: { sha, exit }, post: { sha, exit }, output, start: <unit-start id>, pending_commit?: <sha> }
  ```

  - `output` is the tail of the post run.
  - `pre` is copied from the matching `unit-start`, or from the test-only commit for a pending unit.

**Failed attempts** are not receipts. Each one is a `decision` record `progress.U<n>`:

```
{ point: progress, subject: U<n>, digest, source: rule, outcome: retry|stop, reason, facts: { start, attempt, signature: { tests, hash }, exit, post_sha, output_tail } }
```

`output_tail` is at most 2 KB, so the facts stay under the 2,000-character yaml limit. Above that limit `decisionComment` already replaces the facts with `facts_hash`, so `signature` and `attempt` are also copied into `reason`, and the rule reads the previous signature from its own field. To keep that field, `DecisionRecord` gains an optional `signature` field that `compactFacts` keeps.

**Why attempts are derived** (revised during spec review; recorded in `brainstorm.md`). A stored `counter` would count twice when a retried `unit_finish` writes it again. It also could not be ordered against a stuck answer, because an edited counter comment keeps its old position. `change_iterations` (LS-05) is derived for the same reasons.

**Derived facts** (pure, `deriveUnitEvidence`). Comments are read in comment order.

- **started(U).** The latest `unit-start` for U is newer than the latest `receipt` for U, and the unit is not done. A tick by a human on the web, or an untick by a cascade, never leaves a stale "started" unit behind: a done unit is never started, and an unticked unit gets a new `unit-start`.
- **attempts(U).**
  - The count is the number of `progress.U` records newer than the latest of three events: the start, the latest receipt, and the latest lifting stuck answer (D6).
  - It is derived and never stored, so a retried tool cannot count twice.
  - It is exposed as `counters["unit_attempts.U<n>"]`, so the existing `countersWithCaps` shows it against `loops.unit_attempts`.
  - A `counter` comment for `unit_attempts.*` is ignored, like `change_iterations`.
- **blocked(U).** U is blocked in either case, and no lifting stuck answer is newer than the event:
  - the attempt count reached `loops.unit_attempts`;
  - the latest `progress.U` record has outcome `stop`.

The `ChangeState` additions are:

```
evidence: { started: Record<string, StartRecord>; receipts: Record<string, ReceiptRecord[]>; attempts: Record<string, number>; blocked: Record<string, "attempts" | "progress">; untickedReceipts: string[] }
```

`untickedReceipts` holds the pending units whose latest `receipt` is newer than their latest `unit-start` and matches their current digest.

`NextStep` gains `startedUnits` and `blockedUnits` with reasons. The existing `blockedUnits` field, meaning "waiting on `Depends`", is renamed `waitingUnits`. It has only internal consumers: the card and `format-step`.

### D3. Running `Verify` and what counts as red

The runner runs the `Verify` text without the surrounding backticks the parser already strips:
- It uses `/bin/sh -c`, with the worktree as cwd, and stdin closed.
- The timeout is `verify.timeout` seconds (default 600). On timeout the whole process group gets SIGTERM, then SIGKILL after 5 s.
- Combined stdout and stderr is collected.
- Only the last 8 KB is kept (`RECEIPT_OUTPUT_BYTES`), cut on a UTF-8 boundary, and prefixed with `…[truncated N bytes]`.
- Known tokens are redacted with `redactTokens` before anything is posted.

Classification (pure, `red-green.ts`):

| Run | Class |
|---|---|
| exit 0 | `green` |
| exit 126 or 127, a spawn error or a timeout | `invalid`: never a valid red, and a failed attempt at post |
| any other non-zero exit | `red` |

Before any run, the `Verify` command goes through `classifyCommand` (D7). That covers pre, the pending test-only commit, `Base` and post. The runner itself enforces this, so no caller can skip it: a blocked `Verify` is never spawned. The tools refuse and point to `unit_amend`, and `verify-red-on-base` reports an error. Redaction also happens in the runner, so every consumer of the output (comments, decision records, tool results) gets redacted text.

**At pre** (`unit_start`):
- A normal unit requires `red`.
- A refactor unit requires `green`.
- A wrong class refuses and writes nothing. The refusal text names the class and the amendment options: regression pin or drop, or fix `Verify`.

**At post** (`unit_finish`):
- Both kinds require `green`.
- `red` or `invalid` is a failed attempt.

### D4. Temporary worktrees

`worktree.ts` creates `git worktree add --detach <tmp> <sha>` under `os.tmpdir()/livespec-verify-<rand>`.

**Preparation:**
- When `verify.setup` is set, it runs there first with the same runner and timeout. A failed setup makes the run `invalid`, with the reason "setup failed".
- Otherwise, each of `node_modules`, `.venv` and `vendor` is symlinked from the main worktree when two things hold: the folder exists there, and it is ignored there (`git check-ignore`).

The worktree is always removed in `finally` (`git worktree remove --force`, then `git worktree prune`). The main tree is never touched.

**Users:**
- `verify-red-on-base`, at `Base`;
- the pending-commit check of `unit_finish` (D5), at the test-only commit.

`unit_start` and the post run of `unit_finish` run in the main worktree, at HEAD, after the clean-tree check.

### D5. Verifier pending

`pending.ts` (pure, over facts that git reads in I/O):
- A unit is **pending** when at least one entry of its `Files` matches a test-file pattern and does not exist at the pre commit (`git cat-file -e <sha>:<path>`).
- The test-file patterns are `**/*.test.*`, `**/*.spec.*`, `**/*_test.*`, `**/test_*.*`, `**/tests/**` and `**/test/**`, matched with `matchGlob`.
- The decision is made by code. No tool parameter can ask for it.

For a pending unit, `unit_start` does not run `Verify`. It records `pending: true` with the HEAD.

`unit_finish` on a pending unit, before the post run:
1. Take the first commit after the start: `git rev-list --reverse <pre>..HEAD`, first entry. If there is none, refuse.
2. Its changed paths (`git diff --name-only <c>^ <c>`) must all be test files listed in `Files`. Otherwise refuse, naming the extra paths.
3. Run `Verify` at that commit in a temporary worktree. It must be `red`; a refactor unit cannot be pending.
4. That commit becomes the recorded pre: `pre: { sha: <c>, exit }`, and `pending_commit: <c>`.

### D6. Blocked units and how they are lifted

A unit becomes `BLOCKED` on the failed attempt that reaches the cap, or on a `progress` outcome `stop`.

When `unit_finish` makes a unit blocked:
- The tool result says to send a stuck report with `spec_stuck`.
- It lists the links to the unit's receipts and failed-attempt records (the comment URLs when the forge gives them).
- `spec_stuck` itself is unchanged.

**Lifting.** A stuck answer that chose an option and is newer than the blocking event lifts that block. This reuses `liftsCap` from `iterations.ts`, which is exported. Every unit blocked at that time is lifted, and its attempt budget restarts from that answer (D2). A dismissed answer lifts nothing.

**While blocked:**
- `unit_start` and `unit_finish` refuse the unit.
- `nextStep` asks for `spec_stuck` naming the unit. While the stuck report is open, the existing open-stuck rule (precedence 3) already says to wait.

### D7. The guard's parser and rules

**Parser** (`shell.ts`, pure). It is a tokenizer for POSIX shell text, with no dependency, and handles:
- single and double quotes, backslash escapes and comments;
- `;`, `&&`, `||`, `|`, `&` and newlines;
- subshells `( … )` and groups `{ …; }`;
- redirections, with the target paths kept.

Each simple command is reduced to `{ words, assignments, redirects }`. Unbalanced quotes or parentheses make the input **unreadable**.

**Unwrapping.** Before the rules run, wrappers are removed recursively, up to depth 8:
- leading `NAME=value` assignments;
- `env [-i] [-u N] [NAME=value]…`;
- `command`, `exec`, `nice [-n N]`, `nohup`, `time`, `timeout [opts] N`, `sudo [opts]`, `xargs [opts]`;
- `sh|bash|zsh|dash -c <script>`, where the script is parsed again;
- `git -C <dir>`, `git -c k=v`, `--git-dir=…` and `--work-tree=…`, which are dropped before the subcommand.

`$(…)` and backtick substitutions are also parsed as scripts and checked.

**Rules**, applied in order to each command; the first block wins:

| Command | Decision |
|---|---|
| `git push` (any options) | block: pushes go through livespec tools (LS-09) |
| a `git` subcommand whose alias (read from `git config --get-regexp ^alias\.`, passed in by the hook) expands to `push`, or to a `!` shell alias containing `push` | block, same reason |
| `gh issue create\|edit\|comment\|close\|reopen\|delete\|transfer\|lock\|unlock\|pin\|unpin` | block: name `spec_write`, `spec_question`, `spec_gate` or `unit_finish` by subcommand |
| `gh pr create\|edit\|merge\|comment\|review\|close\|reopen\|ready` | block: pull requests are LS-09's tools |
| `gh api` with `-X`/`--method` other than GET, or with `-f`/`-F`/`--field`/`--raw-field`/`--input` and no explicit GET | block |
| `gh label\|release\|repo\|secret\|variable` write subcommands | block (forge writes) |
| `tea` with a write subcommand (`issues create\|edit\|close\|reopen`, `comment`, `pulls create\|merge\|close\|reopen\|review\|approve\|reject`, `labels create\|update\|delete`, `releases …`) | block |
| `tea pr …` / `tea pulls …` other than `list` | block |
| `curl` with `-X`/`--request` other than GET or HEAD, or with `-d`/`--data*`/`-F`/`--form`/`-T`/`--upload-file`/`--json`, when any URL argument's host is the forge host | block |
| `wget` with `--method` other than GET or HEAD, `--post-data`, `--post-file` or `--body-*` against the forge host | block |
| a redirect target, or the target of `tee`, `cp`, `mv`, `rm`, `ln`, `touch`, `sed -i`, `perl -i` or `install`, under `.pi/livespec/` | block: the project flow and config are changed by a human |

**Obscured forms.** The command is blocked when it contains a dangerous token and any of these holds:
- the command word is `eval` or `source`/`.` of a non-file argument;
- the command word is a parameter expansion (`$X`, `${X}`);
- the command word comes from a substitution;
- the word that decides the operation is an expansion or a substitution: the subcommand of `git`, `gh` or `tea`, or the method or URL of `curl`/`wget`;
- the input is unreadable.

An expansion in any other argument (a message, a path) does not block by itself.

The dangerous tokens are `push`, `gh`, `tea`, the forge host, and `curl`/`wget` together with the forge host. They are matched as whole words, case-insensitive, after quotes are removed. A script file run as `bash ./x.sh` is allowed (accepted limit).

**Working directory inside one command.** The parser keeps commands in source order. The path rule tracks a set of candidate directories:
- It starts with `ctx.cwd`.
- Each literal `cd`/`pushd` argument adds a candidate, resolved from every existing candidate.
- A `cd` with an expansion, `-` or no argument marks the directory as unknown.

A write target is protected when it resolves under `.pi/livespec/` from any candidate, or when the directory is unknown, the target is relative and its path contains `livespec`. Over-approximating subshell scope can only block more, never less.

**Tools other than bash.**
- `write` and `edit` on a path under `<cwd>/.pi/livespec/` are blocked. The path is resolved against `ctx.cwd`, with `..` and symlinks of existing parents resolved.
- Every other tool is allowed.

**Context.**
- The forge endpoints are:
  - the target's `host` and `authority`;
  - for a GitHub target, `api.<host>` and `uploads.<host>`;
  - every host in config `githubHosts` and `giteaUrl`.
- Without a target, the endpoints are `github.com`, `api.github.com` and those config hosts.
- A host matches its endpoint case-insensitively, ignoring a default port.
- Without an initialized livespec project, the guard does nothing.

**Fail closed.**
- If `classifyCommand` throws, the call is blocked with "livespec guard failed: <error>; the command was not run".
- If the alias lookup fails, every unknown git subcommand is treated as a possible push only when its text contains `push`.

**Reasons.** Every block reason starts with `livespec guard:`, names the matched rule, and names the livespec tool to use, or says that only a human may do it.

### D8. The push escape hatch

`guardedPush(remote, refspec, opts)` in `src/guard/push.ts` runs `git push` through `GitExec` directly. It is not a `tool_call`, so the guard never sees it.

Its only gate is the call site: it is not exported from the package entry, and no tool in LS-06 calls it. The guard has no flag, environment variable or parameter that lets a command through, so the agent has no way to open it. LS-09 adds the callers, which check the state first. A test asserts that no file under `src/tools/` imports `push.ts` until LS-09.

### D9. Gate-only checks

`registerCheck(name, fn, { waivable?, at?: "gate", key? })` gains `at` and `key`. A check registered with `at: "gate"` has these properties:
- `runChecks(pack, state, ctx, { gate: true })` runs it, then stores `{ key: key(ctx), results }` in the registry's module-level memo.
- Without that option, `runChecks` returns the stored results when `key(ctx)` still equals the stored key, and nothing otherwise. `complete-validate.ts` needs no change.
- The memo lives for one session. `key` includes `ctx.root`, and `Session` clears the memo at `session_start` and `session_shutdown` with `clearGateMemo()`, so a new session always runs the check again.
- Its result is still tagged with its name, so `gateRefusal`, `failingWaivable` and `nextStep` need no change.
- A check that is listed in a pack but not registered stays an error, as today. A test or a project that registers its own gate-only check works the same way.

`verify-red-on-base`:
- **Waivable.** A human can approve a plan whose units cannot be verified on `Base` yet, for example a missing CI toolchain. The waiver is recorded as for `size-limits`.
- **Memo.**
  - The check's registry `key` is the root, `Base` and the sorted `<unit>:<digest>` list.
  - Inside the check, a per-unit cache keyed `${root}:${base}:${unit}:${digest}` makes a gate run after one changed unit rerun only that unit.
  - `clearGateMemo()` clears both, so they live for one session: the registry calls the callbacks registered with `onGateMemoClear`, and `red-on-base.ts` registers one that clears its unit cache.
- **No environment.** When the check is run at a gate without a verify environment, it reports an error, never a warning. Like any failing waivable check, the gate then needs an explicit waiver.
- **Per unit:**
  - a pending unit gives a `warning` result `verifier pending` (not an error), unless it is a refactor unit, which gives an error because a refactor needs an existing test;
  - `invalid` gives an `error` naming the reason;
  - a wrong class gives an `error` naming the unit and its exit.

Call sites:
- `spec_gate` calls `runChecks(…, { gate: true })` for the target's gate before `gateRefusal`, and rebuilds `state.checks` with the result.
- Answer validation (`complete-validate.ts`) keeps calling `runChecks` without `gate`. It gets the stored results, or nothing in a new session. The request's HEAD and gate digest checks already pin `Base` and every unit, so the result the human saw stays valid.

### D10. `unit_start` and `unit_finish` flows

**`unit_start { unit }`**
1. Run `prepareWrite`, then `requireChange`.
2. Refuse, in this order, when:
   - the phase is not a `per: unit` phase;
   - no lock exists;
   - the unit is unknown or done;
   - the unit is frozen or stale;
   - a `Depends` entry is not done;
   - the unit is blocked;
   - the unit is already started, unless its `unit-start` digest differs from the current digest, which means an approved amendment changed it;
   - the tree is dirty;
   - another unit is started (inline means one unit at a time, until LS-07 adds lanes);
   - `Verify` is blocked by the guard.
3. Decide pending (D5). If not pending, run `Verify` at HEAD and classify (D3). A wrong class refuses, writing nothing.
4. Post `unit-start`.
5. Run `afterForgeWrite`.

**`unit_finish { unit }`**
1. Run `prepareWrite`, then `requireChange`.
2. **Reconcile.** When the unit is receipted but not ticked (D2 `untickedReceipts`), the tree is clean and the unit is neither frozen nor stale: tick it, run `afterForgeWrite`, and stop. No `Verify` runs and no receipt is posted.
3. Otherwise refuse when:
   - the unit is not started;
   - it is frozen or stale, or its digest differs from the `unit-start` digest;
   - it is blocked;
   - the tree is dirty;
   - `Verify` is blocked by the guard.
4. For a pending unit, run the D5 checks. A failure refuses and is not an attempt, because no post run happened.
5. Run `Verify` at HEAD and classify it.
   - **green:**
     1. post the `receipt`;
     2. read the issue, apply `tickUnit` and write the body with its version;
     3. on a version conflict, re-read and retry once, then report.
     The receipt is written first. A crash between the two writes leaves a receipted, unticked unit. That unit is no longer started. `nextStep` reports "U<n> has a receipt but is not ticked: run unit_finish again", and step 2 reconciles it.
   - **red or invalid:** compute the signature, run `decide("progress", facts)`, and post the decision record. The result reports the attempt count, the signature and either "retry with debugging-and-error-recovery" or the blocked text (D6).
6. Run `afterForgeWrite`.

Neither tool takes a parameter other than `unit`.

**Serialization.** Both tools run their whole body, from refresh to write, inside one per-session evidence lock. Two parallel calls therefore never decide from the same stale state.

**Cancellation.** The runner takes an `AbortSignal`, either the tool call's signal or the session's shutdown signal, which `session_shutdown` aborts. On abort, the runner kills the process group, the temporary worktree is removed, and the tool returns a refusal and writes nothing: an aborted post run is not an attempt. A hard kill of pi itself cannot run this cleanup. The next `withTempWorktree` call runs `git worktree prune` first, and stale `livespec-verify-*` directories are left to the OS temp cleaner.

### D11. The `progress` rule

**Facts:**

```
{ attempt: number; cap: number; signature: { tests: string[]; hash: string }; previous?: { tests: string[]; hash: string } }
```

`previous` is the signature of the latest `progress.U` record within the current budget.

**Outcome:**
- `stop` when `previous` exists and is equal to the current signature (same sorted test names and same hash);
- `stop` when `attempt >= cap`;
- `retry` otherwise.

The reason names which case applied. The rule never asks; config `decisions.progress: { mode: rule }`.

**Signature** (`signature.ts`, pure):
- **Test names** are extracted by line patterns:
  - vitest and jest: `FAIL <file> > <name>`, `✗`/`×` lines;
  - `go test`: `--- FAIL: <Name>`;
  - pytest: `FAILED <nodeid>`;
  - generic: `not ok N - <name>` (TAP).

  They are deduplicated and sorted.
- **The hash** is sha256 over the output with these normalizations:
  - ANSI codes stripped;
  - hex runs of 7 or more characters → `<hex>`;
  - absolute paths → `<path>`;
  - ISO timestamps and clock times → `<time>`;
  - durations (`12ms`, `1.2s`) → `<dur>`;
  - other digit runs → `<n>`;
  - whitespace collapsed.
- Output with no recognizable test name relies on the hash alone.

### D12. Next step and card

`nextStep` precedence. The new rules are inserted in `build` between rule 9 (failing check) and rule 10 (next unit):

- **9a.** A blocked unit → "U<n> is BLOCKED (<reason>): send a stuck report with spec_stuck." This shows when no stuck report is open; otherwise rule 3 waits.
- **9b.** A started unit → "Finish U<n> with unit_finish once Verify passes."
- **9c.** A receipted, unticked unit → "Run unit_finish U<n> again to tick it."

The `activeUnits` field keeps listing ready units. Started units come first in the list.

The card section `evidence` (registered with `registerCardSection`) shows:
- started units with their pre SHA;
- blocked units with their reason;
- verifier-pending units.

`ChangeState.incomplete` changes from the ids of own `incomplete` comments to the items of the latest one, which is empty after a clear (D13). The existing `Incomplete:` card line therefore shows what was left unfinished, rather than a comment id.

### D13. Settle

`src/hooks/settle.ts` keeps one flag per session, `asked`.
- `agent_settled` resets it. A continuation does not settle in between, so the whole chain started by one user prompt shares one flag.
- Only this flag lives in memory. Facts are read fresh from `session.refresh()`.

**Conditions**, computed purely from the refreshed card. They apply only when a change is resolved and either the phase is `per: unit` or some unit is started.
- a started unit;
- a dirty tree;
- any condition registered with `registerSettleCondition(name, (state) => string | undefined)`, the seam for LS-07's "review pending". None is registered in LS-06.

**Behaviour.** When the run's outcome is `completed`:
- **Conditions hold and `asked` is false:** set `asked = true`, and return `{ entries: [...event.entries, { type: "custom_message", customType: "livespec-settle", content: <list>, display: true }], continue: true }`.
- **Conditions hold and `asked` is true:** write the `incomplete` comment, then return nothing, so pi settles.
- **No condition holds:** clear any `incomplete` items still shown.

Clearing is checked on every `completed` settle with a resolved change, whatever the phase. The last `unit_finish` may advance the change out of `build` before the next settle, and the comment must still be cleared then.

**The `incomplete` comment:**
- Id `<change number>`, data `{ items: string[], at, head_sha }`.
- Edited in place when one exists, with `setCounter`-style own-marker editing.
- "Clear" edits it to `{ items: [] }`, so the card hides it.
- When the forge is read-only or has no writable account, nothing is written and a warning is recorded.

The hook never throws into pi. Errors go to `session.record`. An `aborted` or `error` outcome is left alone.

### D14. Work in progress

`src/evidence/wip.ts` registers a predicate: for each open `livespec` issue in phase `build`, read own marked comments and report busy when any unit is started (D2). It reuses `readMarkedComments` and `deriveUnitEvidence`, so the WIP signal and the card cannot disagree. It costs one search plus one comments call per build-phase issue.

### D15. Config and pack

**Project config:**
- `verify.setup` is a string.
- `verify.timeout` is a positive integer number of seconds, default 600.
- Invalid values are warnings that fall back to the defaults.

**Pack:**
- `plan.checks` gains `verify-red-on-base`, after `unit-classification`.
- `decisions.progress: { mode: rule }`.
- The fixture `tests/fixtures/agent-skills.pack.json` changes accordingly.

### D16. Wiring

`src/extension.ts`:
- registers `unit_start` and `unit_finish` through `registerChangeTools`;
- registers the guard and settle hooks;
- imports `src/evidence/wip.ts` and the `progress` rule bootstrap for their side effect.

The guard handler is registered **before** the context hook, so a blocked call is not recorded as a skill read.

## Risks / Trade-offs

- [The shell parser misses a form, and a push or forge write slips through] → The obscured-form rule blocks any unreadable command that contains a dangerous token, and the rules table is covered by a table test with every variant from the issue plus `eval`, aliases, substitutions and `xargs`. Script files are an accepted, documented limit.
- [False positives block ordinary work] → Read commands (`gh issue view`, `gh api` GET, `git log`) are allowed. The dangerous-token test applies only to obscured forms, and `curl`/`wget` are blocked only against the forge host. The reason always names the tool to use.
- [A symlinked `node_modules` differs from what `Base` needs, giving a wrong red or green on `Base`] → `verify.setup` fixes it per project, and the check is waivable at the plan gate.
- [`verify-red-on-base` makes `spec_gate plan` slow] → It runs only there, the memo avoids reruns, and the timeout applies to each unit.
- [A crash between the receipt and the tick] → The receipted, unticked state is reported, and `unit_finish` reconciles it (D10).
- [A `progress` decision with a large output] → `output_tail` is capped at 2 KB, and the signature is also kept outside `facts` (D2).
- [The settle hook loops] → The per-run flag allows one continuation; the second settle writes `incomplete` and returns nothing.
- [A `git` alias defined after the session read the aliases] → Aliases are read on every bash `tool_call` that runs git. That is one `git config` call, only when a git command is found.
- [Agents in executors that do not load the extension] → An accepted limit (brainstorm). LS-07 restricts write roles.

## Migration Plan

- There is no data migration. Existing changes have no `unit-start` or `receipt` comments.
- A change already in `build` with units ticked by hand keeps them. Their receipts are simply missing.
- Rollback is a package downgrade. The new comments are ignored by older versions, which do not register the `unit-start` kind.

## Open Questions

- The 8 KB receipt tail is kept as the default and should be revisited during dogfooding (LS-11).
- Which test-name formats the signature should recognize beyond the four listed. Unrecognized output uses the hash alone.
