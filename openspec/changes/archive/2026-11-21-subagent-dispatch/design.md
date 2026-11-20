## Context

- **What exists.** livespec already has the pieces this change builds on:
  - the unit loop with parent-owned receipts (`unit_start`, `unit_finish`, LS-06);
  - the decision seam with `Difficulty` and `Tags` (LS-05);
  - the engine, pack registry and phase card (LS-04);
  - the forge interface (LS-03).
- **What is reserved but empty.** The pack's per-phase `subagents` key is reserved: `src/engine/registry.ts` accepts a `subagents` sub-schema, and until one is registered a non-empty value is an error (`flow-pack` "Registration hooks").
- **What does not exist yet.** No code dispatches subagents.
- **The executor.** pi-jev-pilot 0.5.0 vendors `@ttdua/pi-subagents`. It publishes a `SubagentsService` on `globalThis[Symbol.for("@gotgenes/pi-subagents:service")]` today; the executor is moving to the key `@ttdua/pi-subagents:service`. livespec reads the new key first and falls back to the legacy key (D4). The parts this change uses:
  - `spawn(type, prompt, options)` with `context`, `thinkingLevel`, `metadata`, `skills`, `excludeExtensionPackages`, `cwd`, `contextFiles` and `resultSchema`;
  - `wait(id)`, `resume(id, prompt)`, `abort(id)`, `childSession(sessionId)` and `getAgentType(name)`;
  - the events `subagents:child:session-created` (effective `context`, `cwd`, `inheritSkills`, `skillPaths`, `excludedExtensionPackages`, `contextFiles`, `effectiveModel`, `effectiveThinking`) and `subagents:asked`.
- **Built-in role agents.** The executor ships `general`, `implementer`, `explore`, `scout`, `reviewer` and `verifier`. Their bodies are flow-neutral and they set no model. User files override them by name.
- **The executor is moving.** It will leave pi-jev-pilot for its own repository.
- **Who routes models.** When pi-jev-pilot is active, its launch policy routes the model and thinking of any service launch that does not name a model.
- **Children load livespec too.** In-process children load every extension that is not excluded (host-seam probe (e)). livespec's hooks therefore run inside children: today a child would get the parent's routing note and phase card.

## Goals / Non-Goals

**Goals:**
- Dispatch role work with a brief in which Role, Protocol, Flow and Task each come from one source, and no other flow's process reaches the child.
- Keep the parent the only owner of state, evidence, forge writes and gates (ADR 0003).
- Work with any executor that has the needed service capabilities, and inline without one.
- Never choose a model, and stay compatible with Jev routing.
- Run independent units in parallel lanes, and merge them one at a time.

**Non-Goals:**
- Review-phase orchestration, personas and finding routing to the forge (LS-08). This change defines the finding schema and the `reviewer` subjects LS-08 uses.
- The dependency gate for `missing-prerequisite` (LS-09). Until then, it goes to `spec_stuck`.
- Executors without the service API (tintinweb, nicobailon). They run inline.
- Shipping agent files, or registering a workspace provider.

## Decisions

### D1. Module layout: `src/subagents/`, one responsibility per file

| File | Responsibility |
|---|---|
| `executor.ts` | Find the service and check its capabilities; read the effective launch facts from `session-created`. Pure adapter, no livespec state. |
| `protocol.ts` | The livespec protocol text (layer 2) and `PROTOCOL_VERSION`. A module constant, like `ROUTING_NOTE`. |
| `roles.ts` | Role → agent name, subject list, manifest per role/subject, result schema per role. Data only. |
| `packet.ts` | Build a packet from the change state: layers, source collection, budget and spill, untrusted wrapping, hash. |
| `sources.ts` | Source ids and versions; the providers per manifest entry; `registerPacketSource`. |
| `result.ts` | Validate and interpret the structured result: required sources, claims without receipts, status handling. |
| `launch.ts` | Spawn options, the launch-facts watcher (subscribed before `spawn`) and the post-launch check. |
| `dispatch.ts` | Orchestration only: packet → watch → spawn → check → wait → interpret → record. Counters are read from `dispatch` records. |
| `records.ts` | The `dispatch`, `finding-summary` and `lane` marker records and their queries. |
| `state.ts` | `ChangeState.subagents` (executor facts, context usage, open lanes, pending child question) and `unitRoot`. |
| `freshness.ts` | Re-check packet sources before `unit_finish`. |
| `policy.ts` | The `subagents` sub-schema and the evaluation of `mode`/`when`, as pure functions over the snapshot. |
| `lanes.ts` | Lane eligibility, worktree create/remove, merge one at a time, file-violation detection. |
| `isolation.ts` | The default list of other-flow packages, matched against configured packages; merged with `isolation.excludePackages`. |
| `child.ts` | Child-session detection and the child note. |

The tools live in `src/tools/` as today: `subagent-dispatch.ts`, `subagent-answer.ts`, `subagent-packet.ts`, `subagent-record.ts`, `finding-rebut.ts` and `forge-read.ts`. `src/subagents/records.ts` owns the `dispatch` marker kind and the reading of `dispatch` and `finding-summary` records. Doctor checks live in `src/subagents/doctor.ts`.

### D2. Dispatch is a livespec tool, not the model calling `subagent`

- `subagent_dispatch <role> [U<n>] [subject]` runs the whole launch inside the tool.
  - Why not the model calling `subagent`: the model would copy a long packet (cost, truncation), the `subagent` tool takes no per-launch skills, cwd or context files, and its results are free text.
  - The tool calls `spawn` with `context: "fresh"`, `contextFiles: false`, `skills: { inherit: false, paths }`, `excludeExtensionPackages`, `cwd`, `metadata` and `resultSchema`. It sets `thinkingLevel` and never `model`.
- `subagent_packet <role> [U<n>] [subject]` returns the packet without launching. The inline path uses it: the parent reads the same brief and does the work itself.
- `subagent_answer <id> <answer>` resumes a child that asked a question and waits again. The answer becomes source `answer:<agentId>:<n>`.
- `subagent_record <role> [U<n>] [subject]` takes the result of an inline run in the role's schema and posts it exactly as a dispatch would. Inline and dispatched runs then leave the same records.
- A question only the user can settle goes to `spec_question` first; the child is answered afterwards.

### D3. The packet layout keeps the cache prefix stable

The prompt is laid out as follows:
1. the protocol (fixed per livespec version);
2. the flow block (pack name, version and content tree sha, plus the skill names; the skills themselves arrive through `skills.paths`);
3. the task (unit or subject, sources in manifest order, spill-file list, `Verify`, `Files`, prohibitions);
4. last, a footer with the packet hash and the source versions.

Nothing time-varying appears before the task. The hash is computed with spill paths as `<spill>/<file>`, and the absolute spill directory (named by the hash) is substituted afterwards. The role layer is the agent body, which the executor puts last in the system prompt. Across units of one change, the system prompt and the protocol and flow blocks are byte-identical, so they hit the provider cache from the second dispatch on.

### D4. The post-launch check is the guard against older or different executors

- The service is read from `Symbol.for("@ttdua/pi-subagents:service")`, then from the legacy `Symbol.for("@gotgenes/pi-subagents:service")` when the new key is empty. Both keys live as constants in `executor.ts` only.
- Capability detection checks that `spawn`, `wait`, `resume`, `abort`, `childSession` and `getAgentType` are functions. It does not check the package name or version, so the repository split needs no change.
- An executor that silently ignores an unknown option would run the child in the wrong environment. So on `subagents:child:session-created` for the launch's `agentId`, livespec compares the event with the request:
  - `context` is `fresh`;
  - `cwd` matches;
  - `inheritSkills` is `false`;
  - `skillPaths` equals the requested paths;
  - `contextFiles` is `false`.
- The check also requires the effective `excludedExtensionPackages` to contain every requested package, so an executor that ignores the exclusion cannot load another flow's bootstrap.
- On a mismatch, livespec aborts the child (`service.abort`), records why, and falls back to inline for that dispatch. A mismatch that includes `cwd`, in a lane, means another workspace provider moved the child: the unit re-runs sequentially (D9), whatever else mismatched. The mismatch record is posted only after the aborted child has settled; if it does not settle within the bound, nothing is posted and the tool result says so (spec "Dispatch tool": no forge write before the child's run has settled).

### D5. Roles, subjects and result schemas are data

- `roles.ts` maps:
  - `scout` → `scout`;
  - `implementer` → `implementer`;
  - `reviewer` with `subject` `spec | plan | unit | change | persona:<name>` → `reviewer`;
  - `verifier` → `verifier`.
- Each role has a manifest (issue #7, per subject for the reviewer) and a result schema in the executor's JSON Schema subset:
  - every role: `status`, `notes`, `discoveries`, `sources_used`, `reason`, `evidence`;
  - writers add `commits`;
  - reviewer and verifier add `findings`.
- A user override of a role agent is used as is. livespec warns once per session with `getAgentType(name).source` and the file, and records `agentSource` in the result comment.

### D6. Model and effort: requested versus effective

- The requested thinking is the dispatched `Difficulty`: `low`, `medium` or `high`, raised one level per failed attempt and capped at `high`. livespec never passes `model`.
- With Jev, the launch policy may replace both model and thinking. Without Jev, the agent file and the user's settings apply.
- The result comment records `requested.thinking`, `effectiveModel` and `effectiveThinking` from `session-created`. This makes routing auditable without livespec knowing which router ran.

### D7. Child sessions: one check, three hooks

- `child.ts` answers "is this session a child?":
  - with the executor: `service.childSession(sessionId) !== undefined`;
  - without it: the session header's `parentSession` is set;
  - otherwise: not a child.
- In a child:
  - `before_agent_start` sets the `livespec` section to `CHILD_NOTE` instead of `ROUTING_NOTE`;
  - `context` appends no phase card;
  - `resources_discover` returns no skills, because the launch already chose them.
- The `tool_call` guard is unchanged, so the child cannot push or write to the forge.
- `CHILD_NOTE` is a fixed constant. It is the short form of the protocol's prohibitions, so a child launched by the main agent outside livespec still knows the rules.

### D7b. Results are recorded on the forge

- Implementer and scout runs post a `dispatch` marker comment (a new kind registered with `registerKind`): role, unit, attempt, packet hash, agent source, requested/effective thinking and model, status, commits, `notes`, `discoveries`, `sources_used`.
- Reviewer and verifier runs post a `finding-summary` (D8), which also records the run's status, whether it is advisory, and the reviewed HEAD SHA. Only completed reviews (`DONE`/`DONE_WITH_CONCERNS` with every required source) resolve findings or satisfy a required review.
- The manifest reads the dependency's latest `dispatch` comment, so `discoveries` reach the next unit as an ordinary source.

### D8. Findings and rebuttals live in `finding-summary`

- A reviewer dispatch posts one `finding-summary` comment per round, with the findings as YAML.
- The parent's rebuttal is a second `finding-summary` comment with `rebuts: <commentId>` and per-finding `{ index, reason, evidence }`. Records are append-only, as other markers are.
- `finding_rebut` posts the rebuttal; it refuses an empty reason or evidence and any `missed-context` finding.
- `unit_finish` checks findings before every tick path, including the receipted-not-ticked path. It refuses when the unit has an unresolved blocking finding as `review-findings` defines it (not resolved by a later completed review, a rebuttal, or an answered `needs-decision` question; `out-of-scope` findings never refuse the tick and are listed at the next human gate), or when the policy's non-advisory unit review is required and no completed unit review records the reviewed commit: HEAD, or for a merged lane the lane head that is the second parent of the merge commit at HEAD (D9). The summary stores `status`, `sources_used`, the required source ids and the computed `completed` flag, so the check needs nothing but the comment. Context-usage conditions are left out of that policy check, so a tick does not depend on the session's context size.
- The phase card's gate payload lists the rebuttals, so the human sees them at the next gate.

### D9. Lanes are livespec's worktrees

- **Path and branch.** `.worktrees/<change>--<unit>` on `livespec/<change>--lane-<unit>`, created from the change branch with `git worktree add`, through the engine's git exec. livespec owns both ends: it creates the lane and removes it after the merge.
- **Lane count.** User config `lanes`, default 3.
- **Eligibility.** No `Depends` between the units, no overlap in `Files`, and no shared spec file.
- **Tools.** Two parent tools drive lanes (decided during apply): `lane_open <unit>` creates the worktree and posts the `lane` record; `lane_merge <unit>` checks `Files`, merges, runs `Verify` on the change root (red → `resetHard` and a failed attempt), then closes and removes the lane. The build loop suggests both. `unit_finish` is unchanged.
- **Merge.** `git merge --no-ff` onto the change branch, then `unit_finish` there, one lane at a time. The unit review happened on the lane head; `unit_finish` accepts it when HEAD is the merge commit whose second parent is that head, and `Verify` at the merge commit is the integration check.
- **Sequential re-run.** A unit re-runs sequentially when:
  - its lane touched files outside `Files` (a `files-violation` finding is recorded);
  - the merge conflicted;
  - it was red after the merge (this counts as a failed attempt);
  - its child's effective cwd differed from the lane.
- **Started units.** `unit_start` allows one started unit per worktree instead of one per change (`unit-evidence` is modified accordingly). In a lane it checks the lane's tree and records the lane's HEAD as the pre SHA.
- **Guard root.** A lane child runs with the lane path as its cwd, so the guard and `Verify` use the lane as root through `ctx.cwd` and `unitRoot`; the launch metadata `lane` is informational.

### D10. Isolation from other flows

- `isolation.ts` holds a default list of package source patterns for known flows, today `obra/superpowers` and `ttdua/pi-superspec`.
- At dispatch, livespec matches the patterns against the configured packages (pi's settings, user and project) and passes the exact source strings it found as `excludeExtensionPackages`.
- User config `isolation.excludePackages` adds exact sources.
- Doctor reports the effective list.
- Nothing is required of the user.

### D11. Policy evaluation is pure

- `policy.ts` evaluates `when` from the snapshot (`units`, `Difficulty`, `Tags`, capability `paths`) plus a context-usage reading passed in.
- `context>=N%` uses `ctx.getContextUsage().percent`, needs at least one completed turn, and applies a 2-point margin (probe (f)).
- The result feeds the phase card's next step: "dispatch `<role>` for U3", or "run U3 inline; no executor".
- The policy never forces a dispatch. The parent may run the step inline, and the evidence is the same.

### D11b. Change tags

- A change has no tag field of its own: the decision seam tags units. For change-level roles, `tags:<tag>` holds when any unit of the change carries `<tag>` (the union of unit tags).

### D12. `forge_read` is a parent tool

- It is read-only, over the existing `Forge` interface: issue, comments, pull request, pull request files, reviews, review comments, checks and search.
- Human-authored text is wrapped with `untrusted()`.
- In a child session the tool refuses: children read the packet and its spill files instead.

## Risks / Trade-offs

- [The executor changes its option names when it moves to its own repository] → Detection is by capability, and the post-launch check catches silent drops. The adapter is one file (`executor.ts`).
- [A user override of `implementer` carries another flow's process] → The user's intent wins (decision 1.b). The warning names the file, and the result records `agentSource`.
- [Another workspace provider moves lane children] → The cwd check in D4 makes the unit re-run sequentially. Doctor warns, and the user may remove `@gotgenes/pi-subagents-worktrees`.
- [A child waits for an answer that never comes] → `subagent_dispatch` returns the question to the parent with the agent id. An unanswered child stays visible on the phase card until it is answered or aborted.
- [Fresh children pay a cold cache on their first dispatch] → D3 keeps the system prompt, protocol and flow blocks identical across units. Small changes (fewer than 3 units, `difficulty<medium`) stay inline by default.
- [Packet sources change while the child works] → Freshness is re-checked before `unit_finish`. A new human comment or answer stops the unit (`spec_stuck` until LS-08).
- [Children run livespec hooks in the same process] → Child detection runs first in every hook. A detection error is treated as "child", so the main session's card never leaks into a child.

## Migration Plan

- **For users.** Nothing to migrate. Packs without `subagents` behave as today. The default pack gains `subagents` entries, so build dispatches when an executor is present and the policy holds.
- **Rollback.** Remove the `subagents` entries from `.pi/livespec/flow.yaml`, or uninstall the executor, and everything runs inline.

## Open Questions

None blocking. Two optional follow-ups for the executor are recorded in `brainstorm.md`: Jev reading `metadata`, and a `service.features` list.
