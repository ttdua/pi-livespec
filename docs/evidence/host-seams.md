# Host seams: evidence

Results of the ten probes in LS-01 (issue #1). Later specs cite these sections.

**Environment for all probes:** pi 1.5.2 on macOS (Darwin 24.6.0), run with `PI_CODING_AGENT_DIR` pointing at a scratch directory so the real `~/.pi` was only read, never written. Print and JSON modes were used (`--mode json -p`). Models ran through a local 9router: `cx/gpt-5.6-luna` and `cmc/claude-haiku-5-5`. Probe code was throwaway and was deleted; the snippets below show what mattered.

**Project trust.** In print and JSON modes pi has no trust prompt. With the default `defaultProjectTrust: "ask"` the project `.pi/settings.json` is skipped ([security.md](https://github.com/earendil-works/pi) "Project trust without an interactive prompt"). Every probe that depends on project settings set `"defaultProjectTrust": "always"` in the scratch home.

---

## (a) Disable Superpowers per project

### Question
Does a project-level pi settings override with `"skills": []` and `"extensions": []` for the Superpowers package fully disable Superpowers in that project, including its bootstrap, which comes from an extension?

### Method
Superpowers 7.0.2 installed as a user package in the scratch home. An observer extension logged, per run, the skill names in `before_agent_start` (`systemPromptOptions.skills`) and whether the bootstrap marker `superpowers:using-superpowers bootstrap for pi` was in the messages of `context_with_system`. Runs: baseline; project `.pi/settings.json` with `{"packages":[{"source":"<superpowers path>","skills":[],"extensions":[]}]}`; the same plus top-level `"skills":[],"extensions":[]`. Each run was done with trust `ask` and trust `always`.

### Result
- Baseline: 60 skills, 4 of 4 sample Superpowers skills present (`brainstorming`, `using-superpowers`, `test-driven-development`, `writing-plans`), bootstrap present (3 messages).
- Override with trust `always` (both object forms): 45 skills, 0 of the 4 sample skills, bootstrap absent (2 messages). Superpowers is fully disabled.
- Override with trust `ask`: 60 skills, bootstrap present. The override was ignored because the project was not trusted.

### Consequence
Disabling Superpowers per project works, but only in a trusted project. LS-04 (agent-skills loading) can rely on the package-object form with empty `skills` and `extensions`. The doctor must check that the project is trusted and tell the user when it is not; an untrusted project keeps Superpowers running next to agent-skills.

### Fallback
Not needed. If the project is untrusted the doctor reports it and asks the user to run `/trust`.

---

## (b) Expose a subset of skills with `resources_discover`

### Question
Can `resources_discover` return individual skill directories, so that only a chosen subset of a cloned skills repository is exposed?

### Method
A fake clone with four skill directories (`alpha`, `beta`, `gamma`, `delta`, each with a `SKILL.md`). An extension returned `{ skillPaths: [<alpha dir>, <gamma dir>] }` from `resources_discover`; skill names were read in `before_agent_start`.

### Result
`resources_discover` fired once with `reason: "startup"`. Only `alpha` and `gamma` were loaded; `beta` and `delta` did not appear.

### Consequence
LS-04 can expose exactly the skills a flow pack names, without copying files or editing the clone.

### Fallback
Not needed.

---

## (c) Prompt cache with a message appended at the end by `context`

### Question
If the `context` hook appends a message at the **end** of the message list and replaces it each turn, do the earlier messages still hit the prompt cache? Measure cache-read tokens over at least 5 turns.

### Method
An extension appended `<livespec-phase-card turn=N>…</livespec-phase-card>` as the last user message in the `context` hook, with N changing every turn (the message is replaced, not accumulated). A control run used the same extension with the hook disabled. The prompt asked for six `ls` bash calls one at a time, giving 7 turns per run. Per-turn `usage` came from `turn_end`. Two models through 9router.

### Result
Per turn `input / cacheRead` (tokens; `input` is the uncached part):

| Turn | haiku control | haiku append | luna control | luna append |
|---|---|---|---|---|
| 1 | 13505 / 0 | 37 / 13501 | 2241 / 7680 | 2270 / 7680 |
| 2 | 300 / 13501 | 39 / 13799 | 2311 / 7808 | 2340 / 7808 |
| 3 | 318 / 13799 | 372 / 13799 | 2378 / 7936 | 2535 / 7808 |
| 4 | 266 / 14115 | 303 / 14132 | 2295 / 8192 | 2324 / 8192 |
| 5 | 164 / 14379 | 201 / 14396 | 10602 / 0 | 2951 / 7680 |
| 6 | 265 / 14541 | 318 / 14558 | 2320 / 8448 | 2349 / 8448 |
| 7 | 243 / 14804 | 280 / 14837 | 2319 / 8576 | 2604 / 8320 |

In every run cache reads grow with the conversation. With the appended card, `cacheRead` is within one cache block of the control run at each turn (differences of 0 to 33 tokens on haiku and 0 to 256 on luna; luna caches in steps of 128 tokens). The uncached `input` of the append runs is within about 300 tokens of the control runs, the size of one card plus the last message. The first haiku append turn started warm because the control run had just cached the same prefix. One control turn (luna, turn 5) missed the cache entirely, so an occasional full miss happens without the hook too; no append run had one.

### Consequence
Appending a replaced phase card at the end of the message list keeps the earlier messages in the cache. The phase card (LS-04/LS-05) can be injected this way, with a per-turn cost of one card.

### Fallback
Not needed. Limit: measured on two models through one router; the card was short (about 20 tokens).

---

## (d) `agent_before_settle`

### Question
What exactly does `agent_before_settle` allow: can it request exactly one continuation with a message, and what happens after that?

### Method
An extension returned `{ entries: [...event.entries, { type: "custom_message", … }], continue: true }`. Mode "once" did this on the first call only; mode "always" did it every call, with a safety cap of 6 in the probe. Events were logged.

### Result
- The event carries `type, outcome, entries, continue, context`.
- One request with `continue: true` makes pi run exactly one more agent run containing the message. After that run, `agent_before_settle` fires again (call 2) with `continue: false`; returning nothing lets the agent settle, and `agent_settled` fires once (`aborted: false`).
- With "always" the loop was not limited by pi: it ran 7 times until the probe's own cap stopped it.

### Consequence
A settle continuation is one extra run per request, but each run raises a new `agent_before_settle`. The extension must count continuations itself and stop at its cap (LS-05 and LS-06 loop counters), never rely on pi to end a chain.

### Fallback
Not needed.

---

## (e) Child sessions and extensions, per executor

### Question
For each subagent executor, does a child session load the parent's extensions? Can an extension tell that it is running in a child?

### Method
A marker extension, installed as a user package so that it is "ambient", logged `session_start` with pid, session file, `parentSession` from the session header and a filter of the environment. Each executor was loaded with `-e` and one subagent was spawned (prompt "say hi in one word").

Versions: `@tintinweb/pi-subagents` 0.25.0; `pi-subagents` 0.88.1 (nicobailon); `@gotgenes/pi-subagents` 25.0.5; the pi-jev-pilot executor `@ttdua/pi-subagents` 25.0.5 from `packages/pi-subagents` of pi-jev-pilot v0.3.1.

### Result

| Executor | Child runs | Marker loaded in child | How the child can be told apart |
|---|---|---|---|
| `@tintinweb/pi-subagents` | in-process, same pid | yes (second `session_start`, same pid) | child has a session file; the header has `parentSession: null`, so no explicit marker |
| `@gotgenes/pi-subagents` | in-process, same pid | yes | child session file lives under `…/pi-subagents-<uid>/<project>/tasks/` and `parentSession` is the parent's session id |
| pi-jev-pilot executor (fork) | in-process, same pid | yes | same as gotgenes |
| `pi-subagents` (nicobailon) | separate pi process | **no** (one `session_start` only; the child returned "Hi") | the child process has `PI_SUBAGENT_CHILD=1` in its environment |

For nicobailon's executor the docs state that foreground children never load ambient parent extensions; only extensions named in the agent's `extensions` (or `subagentOnlyExtensions`) load. Background children load them unless `extensions` is empty.

### Consequence
- Guards, `forge_read` and the `tool_call` guard cannot assume they are loaded in a child. Under in-process executors they are loaded and must recognize a child through `ctx.sessionManager.getHeader()?.parentSession` (gotgenes and the fork) or by the session file path. For `@tintinweb` there is no marker.
- Under the nicobailon executor guards are not present in foreground children unless the agent definition lists them; LS-07 must put the livespec extension in `extensions` of its role agents, and the packet cannot rely on guards in the child.

### Fallback
Parent-owned evidence (ADR 0003) already keeps the parent as the only writer, so a child without guards cannot post to the forge through livespec tools. Dispatch must still declare the child's tool allowlist, and the parent re-checks the diff.

---

## (f) `ctx.getContextUsage()` accuracy

### Question
How accurate is `ctx.getContextUsage()` compared with the actual token count?

### Method
After each `turn_end`, `ctx.getContextUsage().tokens` was compared with the provider's `usage.totalTokens` for that turn (`cx/gpt-5.6-luna`, 4 turns with tool calls).

### Result

| Turn | reported total | `getContextUsage().tokens` | difference |
|---|---|---|---|
| 1 | 9925 | 9949 | +24 |
| 2 | 9976 | 9990 | +14 |
| 3 | 10040 | 10171 | +131 |
| 4 | 10240 | 10240 | 0 |

At `turn_start` the value equals the previous `turn_end` value (0 on the very first turn). The error was at most 1.3% of the reported tokens; it comes from the estimate for trailing messages.

### Consequence
`context>=N%` conditions (LS-07) can use `getContextUsage().percent`. Before the first model response it is 0, so a condition must not fire on turn 1. Use a margin of about 2 percentage points on the threshold.

### Fallback
Not needed.

---

## (g) Gitea REST API

### Question
Can the Gitea REST API (`/api/v1`) edit an issue body with a concurrency check, create, edit and list comments, manage labels, create and update pull requests, list and create pull request review comments, and read commit status or CI checks?

### Method
Gitea 28.3.0 (`gitea/gitea:latest`) in a local Docker container with a scratch volume, an admin user and a token. The swagger document `/swagger.v1.json` (342 paths) was checked for each endpoint and each operation was called.

### Result

| Operation | Endpoint | Result |
|---|---|---|
| Create issue | `POST /repos/{o}/{r}/issues` | 201 |
| Edit issue body | `PATCH /repos/{o}/{r}/issues/{n}` | 201 |
| Concurrency check on issue edit | `content_version` field of `EditIssueOption` | stale value gives 409 `the issue is already changed`; the right value is accepted and increments the version |
| `If-Match` / `If-Unmodified-Since` | headers | **ignored**: the PATCH succeeded with a bogus ETag. The server sends no ETag on the issue |
| Edit without `content_version` | | accepted (no check) |
| Comments | `POST`, `PATCH /issues/comments/{id}`, `GET /issues/{n}/comments` | 201, 200, 200; `EditIssueCommentOption` has only `body` (no version) |
| Labels | `POST /labels`, `POST/PUT/DELETE /issues/{n}/labels` | 201, 200, 200, 204 |
| Pull requests | `POST /pulls`, `PATCH /pulls/{n}`, `GET /pulls` | 201, 201, 200; `EditPullRequestOption` has `content_version` too |
| Reviews and inline comments | `POST /pulls/{n}/reviews` with `comments`, `GET /pulls/{n}/reviews`, `GET /pulls/{n}/reviews/{id}/comments` | 200 each |
| Commit status | `POST /statuses/{sha}`, `GET /commits/{ref}/status`, `GET /commits/{ref}/statuses` | 201, 200, 200 |
| CI runs | `GET /repos/{o}/{r}/actions/runs` | 200 (empty list; no runner in the probe) |

### Consequence
Every operation LS-03 needs exists. The concurrency check for issue and pull request bodies is `content_version` (read the issue, send its version on edit, retry on 409). There is no ETag and no version for comments, so comment edits are last-write-wins; the adapter must read the comment and only edit comments carrying its own marker. The cache with ETag in the architecture does not work for Gitea issues: it needs `updated_at` or `content_version` polling instead.

### Fallback
Conditional GET with `ETag` is not available on Gitea; use `content_version` and `updated_at`. CI results through Actions were not exercised (no runner in the probe), only commit statuses.

---

## (h) Adapter registration over `pi.events`

### Question
Can another installed package register an adapter with this extension over `pi.events` with a request/response pattern?

### Method
Two extensions. A registers a listener `pi.events.on("livespec:approve", req => req.respond(...))`. B emits the event with a request carrying a `respond` callback and waits (500 ms timeout) for the answer; it also emits an event nobody listens for. Both load orders were run.

### Result
With the adapter loaded, B received `{ ok: true, by: "adapter-a" }` in both load orders. With no adapter there is no error and no reply: only the timeout fires.

### Consequence
Third-party approval adapters (LS-05) can register by listening on a documented event name and answering through a callback in the request. The sender must apply a timeout and must treat no reply as "no adapter". Only the first `respond` call counts; the request has no built-in reply correlation, so the payload needs a request id.

### Fallback
Not needed.

---

## (i) Blocking a shell command with `tool_call`

### Question
Can the `tool_call` hook block a bash command before it runs and return a reason the agent sees? Does it see the full command string, including `sh -c`, `env` prefixes and `git -C <dir>`?

### Method
A hook that returned `{ block: true, reason: "livespec-probe: push is blocked by guard" }` for commands containing `BLOCKME` or matching `git … push`. The agent was asked to run four commands: a plain echo, `sh -c '…'`, `env FOO=1 …` and `git -C ./sub push origin main`.

### Result
The hook received the exact command string for all four, including the wrapper forms. All four were blocked and the agent quoted the reason to the user.

### Consequence
The guard (ADR 0004) can inspect the full command. It still has to parse wrapper forms (`sh -c`, `env`, `git -C`) itself: pi gives the raw string only. A blocked call never executes.

### Fallback
Not needed.

---

## (j) Prompt the human from an extension

### Question
Can an extension tool or command show the human a prompt (select, confirm or text input) and receive the answer directly from the UI, without the agent relaying it? Does `ask_user_question` from `rpiv-ask-user-question`, when installed, return only what the human chose?

### Method
A throwaway command `/probe-j` called `ctx.ui.select("…", ["A","B","C"])`, `ctx.ui.confirm(…)` and `ctx.ui.input(…)` and logged each return value. The person ran it in an interactive pi (TUI, scratch home) and chose B, Yes and typed `pear`. The log was read from the file, not from the chat.

`@juicesharp/rpiv-ask-user-question` 2.15.0 was checked from its source and docs (`answer-channel.ts`, `docs/tool-schema.md`); the tool itself was not run with the human.

### Result
- The log held `select: "B"`, `confirm: true`, `input: "pear"` with `hasUI: true`. All three returned exactly what the human did, as values the extension code received; no model turn was involved.
- `ask_user_question` mounts its dialog with `ctx.ui.custom`. Its source also accepts `rpiv:ask-user:answer` on `pi.events`: any extension can answer or cancel an open questionnaire by `toolCallId`, and the first answer wins. So its result is not guaranteed to come from the human. This part is from the source and not run.

### Consequence
A livespec command or tool can ask for an approval with `ctx.ui.select`, `confirm` or `input` and get the human's answer directly (LS-05 in-session approver). `hasUI` is true only in an interactive session, so print and JSON modes have no in-session approver and must use another adapter.
`ask_user_question` must not be the approval channel: another extension on the same event bus can settle it.

### Fallback
Use `ctx.ui.*` for approvals. When `hasUI` is false, report that no in-session approver exists and use a registered adapter (probe h) or the Inbox.
