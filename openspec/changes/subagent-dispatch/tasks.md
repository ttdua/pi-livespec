## 1. Executor adapter and child sessions

Blocked by: none

- [x] 1.1 `src/subagents/executor.ts`: find the service on `globalThis[Symbol.for("@ttdua/pi-subagents:service")]`, falling back to the legacy `Symbol.for("@gotgenes/pi-subagents:service")`, report the missing capabilities (`spawn`, `wait`, `resume`, `abort`, `childSession`, `getAgentType`), and read effective launch facts from `subagents:child:session-created` by agent id (tests with a fake service)
- [x] 1.2 `src/subagents/child.ts`: `isChildSession(ctx)` from `childSession()`, falling back to the header's `parentSession`; a check that throws counts as child. Add the `CHILD_NOTE` constant
- [x] 1.3 `src/hooks/context.ts`: in a child, `before_agent_start` sets `CHILD_NOTE`, `context` adds no card, `resources_discover` returns no skills; `src/hooks/session.ts`: no resume card in a child (specs `child-sessions`, `context-injection`)
- [x] 1.4 Tests: child-note scenarios, no card, no skills, guard still blocks `git push` in a child

## 2. Config keys and isolation list

Blocked by: none

- [x] 2.1 `src/config.ts`: user config keys `lanes` (default 3), `packetBudgetTokens` (default 24000) and `isolation.excludePackages`, with warnings for invalid values (spec `init-and-doctor` Config files)
- [x] 2.2 `src/subagents/isolation.ts`: built-in patterns for known other flows (Superpowers, pi-superspec), matched against the packages configured in pi's user and project settings, merged with `isolation.excludePackages` without duplicates
- [x] 2.3 Tests for every new config scenario and the isolation list

## 3. Roles, result schemas and the subagents policy

Blocked by: none

- [x] 3.1 `src/subagents/roles.ts`: role → agent name, reviewer subjects, per-role result schema in the executor's JSON Schema subset, and the finding schema (spec `review-findings` Finding schema)
- [x] 3.2 `src/subagents/policy.ts`: the `subagents` sub-schema validator registered with `registerPackSchema("subagents", …)` (personas reported), and pure `when` evaluation (`units>=`, `difficulty>=`, `tags:`, `unfamiliar-code` for shape/define/plan/build, `context>=N%` with a 2-point margin, never before the first turn)
- [x] 3.3 `src/packs/agent-skills.yaml` and `tests/fixtures/agent-skills.pack.json`: the default `subagents` entries (spec `subagent-policy` Default pack entries)
- [x] 3.4 Tests: schema errors with line/column, every `when` scenario, the default pack validates

## 4. Records: dispatch and finding-summary

Blocked by: 3

- [x] 4.1 `src/subagents/records.ts`: register the `dispatch` marker kind; write and read `dispatch` comments (role, unit, attempt, packet hash, agent source, requested/effective thinking and model, status, commits, notes, discoveries, sources_used)
- [x] 4.2 Write and read `finding-summary` comments: status, advisory, reviewed HEAD, sources_used, required ids, computed `completed`, findings; rebuttal records with `rebuts`
- [x] 4.3 `lane` marker records and `unitRoot`; pending child question from `dispatch` records (`QUESTION`, closed by `ANSWERED` or a later record with the same agent id); `ChangeState.subagents` filled at refresh
- [x] 4.4 Unresolved-blocking-finding and completed-review queries per unit, including advisory exclusion, `needs-decision` answered and `out-of-scope` shown at a gate, and the lane-head-as-second-parent rule
- [x] 4.5 Tests for each `review-findings` scenario and the dispatch record scenarios

## 5. Packets

Blocked by: 2, 3, 4

- [x] 5.1 `src/subagents/protocol.ts`: the flow-neutral protocol text with `PROTOCOL_VERSION`; test that no default-pack skill name appears in it
- [x] 5.2 `src/subagents/sources.ts`: source ids and versions, a provider per manifest entry (role and subject), `registerPacketSource`, and diff files for reviewer subjects
- [x] 5.3 `src/subagents/packet.ts`: layer order, flow block, role skill paths from the pack (a missing skill refuses), untrusted wrapping, budget (chars/4) with spill files under `<git common dir>/livespec/packets/<change>/<hash>/`, refusal when the inline part cannot fit, hash with `<spill>/` placeholders
- [x] 5.4 Freshness: re-read source versions and re-enumerate comments and answers since dispatch; own `question` comments with human answers count
- [x] 5.5 Tests for every `subagent-packets` scenario (stable prefix, flow switch, manifest inclusion, spill, budget refusal, hash stability, freshness)

## 6. Dispatch, answer, packet and record tools

Blocked by: 1, 2, 4, 5, 7, 9

- [ ] 6.1 `src/subagents/launch.ts`, `result.ts` and `dispatch.ts`: build the spawn options (fresh, contextFiles false, skills, exclusions, cwd, metadata, resultSchema, thinking from `Difficulty` raised per failed attempt; never `model`), spawn, run the post-launch check (abort on mismatch, inline fallback, lane cwd → sequential), and wait
- [ ] 6.2 Result handling: missing structured result → retry once with the identical packet; missing required source → resume once naming it; `NEEDS_CONTEXT` ≤ 2 then `spec_stuck`; `BLOCKED missing-prerequisite` → `spec_stuck`; unreachable commits do not count; post the `dispatch` or `finding-summary` record
- [ ] 6.3 `src/tools/subagent-dispatch.ts`, `subagent-answer.ts`, `subagent-packet.ts`, `subagent-record.ts` (and registration of `finding_rebut` and `forge_read`): parameters, refusals (unknown role or subject, missing unit, child session), user-only questions routed to `spec_question`, role override warning once per session; register them in `src/tools/change-tools.ts`
- [ ] 6.4 Tests with a fake executor service for every `subagent-dispatch` scenario

## 7. Findings tool and unit evidence changes

Blocked by: 4, 5

- [ ] 7.1 `src/tools/finding-rebut.ts`: rebut one finding with reason and evidence; refuse empty fields and `missed-context`
- [ ] 7.2 `src/tools/unit-finish.ts`: before every tick path, refuse on an unresolved blocking finding or a missing completed review the non-advisory policy entry requires (context conditions left out), and run the freshness check for dispatched units
- [ ] 7.3 `src/tools/unit-start.ts` and `src/tools/unit-tool.ts`: checks run in the unit's lane worktree when a lane is open; one started unit per worktree
- [ ] 7.4 Tests: new `unit-evidence` scenarios; every existing unit-start and unit-finish test still passes

## 8. Parallel lanes

Blocked by: 6, 7

- [ ] 8.1 `src/subagents/lanes.ts`: eligibility (no `Depends` path, disjoint `Files`, no shared spec file, at most `lanes`), create `.worktrees/<change>--<unit>` on `livespec/<change>--lane-<unit>` through the engine's git exec, remove after the tick
- [ ] 8.2 Merge one at a time with `git merge --no-ff`; sequential re-run on a files violation (post a `files-violation` finding), a merge conflict (abort the merge), red after merge (undo and count a failed attempt) or a moved cwd
- [ ] 8.3 Tests in temporary git repositories for every `parallel-lanes` scenario

## 9. Phase card, build loop and forge_read

Blocked by: 3, 4

- [ ] 9.1 `src/engine/next-step.ts` and a card section: policy suggestions as next steps (`subagent_dispatch …`, or `subagent_packet`/`subagent_record` inline when no executor), the build-loop order (start, implementer, unit review, finish), fix rounds, `spec_stuck` after `unit_rebuilds`, pending child questions; nothing in the small-fix lane
- [ ] 9.2 Gate payload: advisory findings and rebuttals listed at the next human gate
- [ ] 9.3 `src/tools/forge-read.ts`: read-only targets over `Forge`, untrusted wrapping, refusal in a child
- [ ] 9.4 Tests for every `subagent-policy` (suggestions, advisory, build loop) and `forge-read` scenario

## 10. Doctor, docs and end-to-end

Blocked by: 1, 2, 6, 8, 9

- [ ] 10.1 `src/subagents/doctor.ts`: executor and missing capabilities, role overrides (information), known workspace-provider packages (warning), the effective exclusion list (spec `init-and-doctor` Doctor checks)
- [ ] 10.2 `docs/architecture.md` (subagents section) and `README.md` (executor setup, role guidance, model and effort with or without Jev)
- [ ] 10.3 End-to-end test with a fake executor: a change with 5 units completes build with dispatches and parallel lanes; past the context threshold the next unit is dispatched; the same change completes inline with no executor
- [ ] 10.4 Full `bun run typecheck`, `bun run test` and `openspec validate subagent-dispatch`
