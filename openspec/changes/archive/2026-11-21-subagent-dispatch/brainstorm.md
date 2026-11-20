## Design Summary

LS-07 (issue #7) runs bounded pieces of a livespec change in subagents. The parent session keeps the state, the evidence and the gates. It targets the executor service that pi-jev-pilot 0.5.0 ships (`@ttdua/pi-subagents`), which will soon move to its own repository, and it works inline when no capable executor is present.

**Intent.** A long session degrades as its context fills. Each unit should run in a clean context. That context must still contain everything the parent knows that matters: answered questions, gate notes, review comments and receipts of earlier units. It must contain nothing from another workflow. The user named three concerns:

1. a subagent must be given everything its task needs, without duplicates;
2. the process a subagent follows depends on the flow in use: agent-skills skills for the agent-skills pack, and a different pack's skills when that pack is active;
3. the actual work comes from the current task.

When the project switches flows, no child may receive the old flow's process.

**The brief a subagent receives has four layers**, each with one source of truth:

| Layer | What it says | Source | Changes when |
|---|---|---|---|
| Role | What this kind of agent does and may never do | The executor's agent file (`scout`, `implementer`, `reviewer`, `verifier`), or the user's override of it | Never by livespec |
| Livespec protocol | How any child works inside livespec: the packet is its context, untrusted blocks are data, the prohibitions, how to ask the parent, how to return | One module in livespec, versioned | A livespec release |
| Flow | The skills and process of the active flow pack, for this role | The pack and its pinned content tree | The flow or its content changes |
| Task | The unit or subject, its required sources, `Verify`, `Files` | The packet built at dispatch | Every dispatch |

**When to use a subagent.** A step goes to a subagent when the next phase needs only its *result*, and the *process* would mostly be noise for what follows. Noise here means failed attempts, test logs and stale reads of files that have since changed. A step stays inline when the process is the product (shape, define and plan talk with the user) or when the step writes to the forge or moves a gate. Whatever in the process has lasting value (a gotcha, a flaky test, an API quirk) is distilled into the return contract as `discoveries`. The parent stores it in the receipt, and the next dependent unit's packet carries it. Reviewers run in subagents so they judge independently, without the author's reasoning in their context.

**Subagents never move the flow.** Only parent tools (`unit_finish`, `spec_gate`, …) and human gates do.
- A failed review keeps the unit unticked: fix rounds come first, then `spec_stuck` and the user.
- A reviewer's "do it differently" is a decision for the user, not an order to the parent.
- The parent may rebut a blocking finding with evidence. The rebuttal is shown at the next human gate, so the user always sees it.
- The main agent may still call `subagent` on its own. Livespec does not forbid it.

**Model and effort.** livespec never chooses a model. It passes the unit's `Difficulty` as a default thinking level. When pi-jev-pilot routes launches, Jev decides the model and the thinking. Without Jev, the agent file, the user's settings and `Difficulty` decide. Without an executor, the step runs inline. Receipts record what was requested and what actually ran.

**Done when** (from issue #7, kept):
- a change with five or more units completes build with subagents, and independent units run in parallel lanes;
- past the context threshold, the next unit moves to a subagent;
- a result missing a required source is returned once, then `BLOCKED`;
- `NEEDS_CONTEXT` does not count as a failure and is capped;
- a lane that edits a file outside `Files` is re-run sequentially;
- with no capable executor, the same change completes inline.

## Alternatives Considered

### Alternative A: livespec ships its own role agents
- **Approach**: Declare `livespec.implementer`, `livespec.reviewer`, … agent files in livespec's `package.json`, each with its own frontmatter and process, as pi-superspec does.
- **Pros**: Full control of each role's text. Independent of the executor's built-in roster.
- **Cons**:
  - The process baked into agent files pins a role to one flow. Switching flows leaks the old process.
  - It duplicates the executor's flow-neutral roles (jev-pilot #82, #87).
  - User overrides would need a second naming scheme.
- **Why not chosen**: It mixes the Role and Flow layers, which is exactly what the user asked to avoid.

### Alternative B: the main agent calls the `subagent` tool with a packet it copies
- **Approach**: livespec builds the packet. The model passes it to `subagent({ subagent_type, prompt })`, reads the text result and reports back through livespec tools.
- **Pros**: Works with any executor that has a `subagent` tool. No dependence on a service API.
- **Cons**:
  - The model copies a long packet: token cost, and it can alter or truncate it.
  - No way to set skills, context files or cwd per launch.
  - Results are free text.
  - The packet hash cannot be trusted.
- **Why not chosen**: It cannot keep the old flow out of a child, and the return contract cannot be enforced.

### Alternative C: livespec dispatches through the executor service (chosen)
- **Approach**: A livespec tool builds the packet and launches the executor's built-in role agent through `SubagentsService.spawn()` with per-launch skills, context files, extension exclusions, cwd, metadata and a result schema. It then waits for the result and validates it.
- **Pros**:
  - Each layer has one source of truth.
  - The child sees only the active flow's skills.
  - The return contract is validated inside the child.
  - Lanes get a real cwd.
  - Model routing stays with the executor or Jev.
- **Cons**:
  - Depends on the service features of pi-jev-pilot 0.5.0, or of the coming standalone pi-subagents.
  - Older executors must fall back to inline.
- **Why chosen**: See Agreed Approach.

## Agreed Approach

Alternative C. It is the only option that keeps Role, Protocol, Flow and Task separate, and so stops a flow switch from leaking the old process into children. The executor gained exactly the features this needs at the user's request (jev-pilot #83–#88, released in 0.5.0).

Inline execution stays a first-class path. It produces the same evidence, so the flow never depends on having an executor (architecture: "No subagent plugin, same flow").

## Key Decisions

1. **Four roles, all executor built-ins.**
   - Roles: `scout`, `implementer`, `reviewer`, `verifier`.
   - The six reviewer kinds from issue #7 (spec, plan, unit, final, persona, finding-verifier) differ only in their inputs, rubric and whether they block. They become one `reviewer` with a `subject`. The finding-verifier maps to `verifier`.
   - livespec ships no agent files.
2. **User overrides are respected.** A user's own `implementer.md` (or any role) is their intent. livespec dispatches to it, warns once per session naming the file, and records the agent source in the receipt.
3. **Every livespec dispatch is `fresh`.** No role needs the parent's process, and reviewers must not have it. A `fork` is never requested.
4. **Child sessions get a child note, not the phase card.** In every child session (livespec's or one the main agent launched itself):
   - the routing note and phase card are replaced by a short fixed child note: you are a child, the parent owns state, no tick, no push, no forge writes, ask the parent when context is missing;
   - the `tool_call` guard stays on.
   This alters the specified Routing note and Phase card requirements of `context-injection`, which today apply to every session of an initialized project.
5. **Isolation from other flows is automatic.**
   - livespec excludes known other-flow packages (for example Superpowers and pi-superspec) from its children without user setup.
   - A user list can extend the default.
   - Doctor reports what was excluded.
6. **Questions from a child reach the parent.** The parent answers through a livespec tool, and the answer becomes a source the child cites. Questions that only the user can answer go through `spec_question`.
7. **A unit is ticked only after review passed.** This adds a refusal to the specified `unit_finish` requirement in `unit-evidence`: an unresolved blocking finding refuses the tick.
8. **The parent may rebut a finding.** The rebuttal is recorded in the `finding-summary` comment (an existing core kind in `forge-markers`) and shown at the next human gate. `missed-context` findings cannot be rebutted.
9. **Model and effort.**
   - livespec never sets a model. It passes `Difficulty` as the thinking default, raised one level after a failed attempt.
   - Routing layers such as Jev may override it.
   - Receipts record the requested and the effective values.
10. **No coupling to a package name or version.** The executor is detected by the service capabilities livespec needs. After every launch, livespec compares what the child actually got with what was requested, and a mismatch aborts the dispatch. This keeps the coming repository split painless.
11. **Lanes are livespec's own worktrees.**
    - livespec registers no workspace provider.
    - When another provider moves a lane child elsewhere, the unit runs sequentially.
    - The user may remove `@gotgenes/pi-subagents-worktrees`, and doctor warns when such a provider conflicts with livespec roles.
12. **Defaults the user left to us.**
    - Implementer `auto` holds when `units>=3`, `difficulty>=medium` or `context>=60%`.
    - The `context>=N%` default is 60%, with a 2-point margin, never on the first turn (probe f).
    - `packetBudgetTokens` defaults to 24000. A source over budget is written to a file the child reads; it is never silently dropped.
13. **Settings this change adds or alters.**
    - User config gains `lanes`, `packetBudgetTokens` and `isolation.excludePackages`. This alters the specified `Config files` requirement of `init-and-doctor`.
    - Doctor gains checks for the executor's capabilities, role overrides and conflicting workspace providers. This alters `Doctor checks`.
    - The pack's `subagents` phase key gets its registered validator, through the `Registration hooks` requirement of `flow-pack`, which is unchanged.

## Open Questions

- Should Jev read `metadata.role` and `metadata.difficulty` as scoring signals? That is an optional follow-up issue for pi-jev-pilot, not needed here.
- Should the standalone pi-subagents expose `service.features`, so livespec can check capabilities before spawning instead of after? That is an optional follow-up once the repository exists. Until then, the post-launch check is the guard.
