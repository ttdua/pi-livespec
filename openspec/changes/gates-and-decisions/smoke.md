# Smoke record: gates-and-decisions (LS-05)

- **Date:** 2026-11-16
- **pi version:** 1.5.2 (`pi --version`; devDependency `@earendil-works/pi-coding-agent` `^1.5.0`)
- **Branch:** `gates-and-decisions`

## Automated checks

| Command | Result |
|---|---|
| `bun run typecheck` | pass (`tsc --noEmit`, no errors) |
| `bun run test` | pass: 112 test files, 1518 tests |

## Manual smoke

**Outcome: not run against a real forge.** No scratch GitHub repository was available in the implementation session, and that session made no network or real forge calls by design. It also could not drive an interactive pi TUI.

**Fallback evidence:** `tests/e2e/gates-flow.test.ts` › `full gate flow over a memory forge` passes. It runs the same flow through the real tools, the approver chain and forge polling over `MemoryWorld` and a local bare origin:

1. a define change with a spec diff, with `spec_gate define` approved in session, after which the phase is `plan`;
2. `plan_units`, then `spec_gate plan` with `interaction.adapter: [forge]`, then a writer's `/livespec approve`, then `spec_status` polls, after which the phase is `build` and the units are locked;
3. a web edit freezes U2, then `unit_amend U2` is approved through `/livespec approve` and U2 is no longer frozen;
4. U1 is ticked, then `spec_question` is answered with `/livespec answer Q1 … --changes rate-limit/Requirement: Per-IP cap`, after which the change is back in define, U1 is unticked and stale, and `change_iterations` is 1 (cap 1);
5. `spec_gate define` refuses and names `spec_stuck`; `spec_stuck` followed by `/livespec choose A` lifts the block, and `spec_gate define` is accepted again.

`tests/tools/no-answer-params.test.ts` › `Tool has no answer parameter` also passes.

### Pending for a human

Run these on a scratch GitHub repository where the plugin account and a second writer account both have write access:

1. **Interactive approval.** Run `/livespec init` in an interactive pi session in the scratch clone. Create a change with `change_new`, then `change_start`. Write a capability spec under `specs/<capability>/spec.md`, commit it, and fill `Capabilities` and `## Proposal`. Ask the agent to run `spec_gate define`, then choose **approve** in the dialog. Expect a `gate` comment on the issue with `adapter: in-session`, and the label `livespec:phase/plan`.
2. **Forge approval.** Set `.pi/livespec/config.yaml` to `interaction: { adapter: [forge] }` and commit it. Run `pi -p "plan the units and request the plan gate"` so that `plan_units` and `spec_gate plan` run. Expect a `request` comment with subject `gate:plan`. From the second writer account, comment `/livespec approve` on the issue. Then run `pi -p "/livespec next"`. Expect a `gate` comment with `adapter: forge` and `answer_comment` naming that comment, and a next step in `build`.
3. Record here the date, `pi --version`, the repository, and the outcome of each step.
