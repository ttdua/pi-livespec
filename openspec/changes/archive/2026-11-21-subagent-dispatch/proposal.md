## Why

A long session degrades as its context fills, so each unit of a livespec change should run in a clean context. Subagents in a clean context miss what lives on the issue and pull request: answered questions, gate notes, review comments and earlier receipts. Children also pick up whatever process the session carries, so a project that switches flows can send a child the old flow's process.

pi-jev-pilot 0.5.0 now provides the executor service this needs: per-launch skills, context files, extension exclusion, cwd, metadata, wait and structured results. LS-07 (issue #7) can therefore dispatch role work in which every layer of the brief comes from one source. The parent keeps state, evidence and gates, and the flow still completes inline when no capable executor is installed.

## What Changes

- **Role dispatch through the executor service.**
  - A livespec tool builds a packet and launches one of the executor's built-in role agents (`scout`, `implementer`, `reviewer`, `verifier`).
  - The launch is fresh and gets only the active flow's skills for the role, no context files, other flows' packages excluded, and a result schema.
  - The tool waits for the result and validates it.
  - livespec ships no agent files, never sets a model, and passes `Difficulty` as the default thinking level.
- **Packets.** A self-contained brief in four layers: role (agent file), livespec protocol, flow skills, task. It carries a context manifest per role and `reviewer` subject, versioned source ids, a token budget that spills to files instead of dropping, untrusted wrapping, and a hash. Other specs can add sources with `registerPacketSource`.
- **Return contract.** `status`, `commits`, `notes`, `discoveries`, `sources_used`, `reason`/`evidence` and `findings`, submitted through the executor's `submit_result`, or through `subagent_record` when the role runs inline. Implementer and scout results are recorded in a new `dispatch` marker comment, which carries `discoveries` to dependent units. It is followed by the parent's handling of missing sources, `NEEDS_CONTEXT`, `BLOCKED`, crashes and questions the child asks.
- **Policy.** The pack's per-phase `subagents` key gets its validator: `role`, `subject`, `mode`, `when`, `advisory`. `when` covers `units>=N`, `difficulty>=`, `tags:`, `unfamiliar-code` and `context>=N%`. The phase card names the next dispatch, and the parent may still run it inline.
- **Findings.** The shared finding schema, blocking rules, the parent's rebuttal with evidence (`finding_rebut`), and the `finding-summary` comment.
- **Build loop.** For each unit: `unit_start`, then the implementer, then the unit reviewer when the policy says so, then `unit_finish`. A unit is ticked only after review passed, with at most `unit_rebuilds` fix rounds before `spec_stuck`.
- **Parallel lanes.** Independent units run in livespec-owned git worktrees passed as the child's cwd, opened with `lane_open` and merged one at a time with `lane_merge` on the change branch. A lane that leaves its `Files`, conflicts or turns red after merge re-runs sequentially.
- **Child sessions.** Every child session gets a short fixed child note instead of the routing note and phase card. Guards stay on.
- **`forge_read`.** A read-only forge tool for the parent session.
- **Freshness.** Packet source versions are re-checked before `unit_finish`. A new human comment or answer since dispatch stops the unit.
- **Config and doctor.**
  - User config gains `lanes`, `packetBudgetTokens` and `isolation.excludePackages`.
  - Doctor reports the executor's capabilities, role agents the user overrides, and workspace providers that would move lane children.

## Capabilities

### New Capabilities
- `subagent-dispatch`: executor detection by capability, the dispatch, answer, packet and record tools, the `dispatch` record, launch options, the post-launch check of what the child got, the return contract and its handling, model and effort, inline fallback.
- `subagent-packets`: packet layers and order, the context manifest per role and subject, source ids and versions, budget and spill files, untrusted wrapping, hash, `registerPacketSource`, freshness re-check.
- `subagent-policy`: the pack `subagents` sub-schema, `mode` and `when` evaluation, advisory roles, the build loop's next steps, the context threshold.
- `review-findings`: the finding schema, blocking rules, rebuttals (`finding_rebut`) and the `finding-summary` comment.
- `parallel-lanes`: when units may run in parallel, lane worktrees, one-at-a-time merge and the sequential re-run rules.
- `child-sessions`: recognising a child session and the child note that replaces the routing note and phase card.
- `forge-read`: the read-only forge tool.

### Modified Capabilities
- `context-injection`: the routing note, the phase card and the resume card apply to the main session only, not to child sessions.
- `unit-evidence`: `unit_start` checks the unit's lane worktree and allows one started unit per worktree; `unit_finish` refuses while the unit has an unresolved blocking finding or lacks a unit review the policy requires.
- `init-and-doctor`: user config accepts `lanes`, `packetBudgetTokens` and `isolation.excludePackages`. Doctor adds checks for the executor, role overrides and workspace providers.

## Impact

- **New code:** `src/subagents/` (detection, packets, protocol, dispatch, results, policy, lanes), new tools in `src/tools/`, child handling in `src/hooks/`, a doctor check, and config keys in `src/config.ts`.
- **Changed code:**
  - `src/hooks/context.ts` (child sessions);
  - `src/tools/unit-start.ts` (lane worktree, one started unit per worktree) and `src/tools/unit-finish.ts` (finding and missing-review refusals);
  - `src/engine/registry.ts` (registers the `subagents` sub-schema);
  - phase card sections.
- **Runtime dependency:** an executor that publishes the service with `spawn` options `metadata`, `skills`, `excludeExtensionPackages`, `cwd`, `contextFiles`, `resultSchema`, plus `wait` and `childSession`. Today that is pi-jev-pilot ≥ 0.5.0, later the standalone pi-subagents. It is optional: without it, everything runs inline.
- **Docs:** `docs/architecture.md` (subagents), `README.md` (role guidance and executor setup).
