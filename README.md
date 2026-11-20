# pi-livespec

A pi (`@earendil-works/pi-coding-agent`) extension that keeps a coding agent on a spec-driven workflow it cannot skip. The work for each change lives on a forge issue (GitHub or Gitea). The living spec lives in the repository under `specs/`. The extension holds the state and the evidence, and it blocks the shortcuts.

> **Status: design stage.** Nothing is implemented yet. The work is split into specs, one GitHub issue each, listed in the [roadmap](docs/roadmap.md).

## The problem

In long sessions, or near the end of one, agents forget steps: they skip verification or review, do not record state, or declare work done without proof. A skill that only asks the agent to behave does not stop this, because the agent decides whether to follow it.

## The approach

- **The extension owns the workflow.** A flow pack (YAML data) defines the phases `shape → define → plan → build → review → ship → close`. The extension computes the next step and blocks actions the state does not allow.
- **The change lives on an issue.** The issue holds the proposal, questions and units. Tool-written comments hold receipts and gate decisions. Each change ships as exactly one pull request.
- **The living spec lives in the repo.** `specs/<capability>/spec.md` is edited in place on the change branch, so the spec delta is the pull request diff.
- **The parent owns the evidence.** Each unit has one `Verify` command. The extension runs it, requires it to fail before the work and pass after, and posts the result as a receipt. Only the extension ticks a unit done.
- **Humans approve gates.** The extension sends gate approvals and questions through an approver adapter that the user chooses. The agent has no path to approve a gate itself.
- **The method comes from [agent-skills](https://github.com/addyosmani/agent-skills).** The extension loads the skill that matches each phase.

It takes ideas from [OpenSpec](https://github.com/Fission-AI/OpenSpec) (spec format, data-driven flow, validation), litespec (the issue as the work queue, receipts, unit digests) and [pi-superspec](https://github.com/ttdua/pi-superspec) (context injection and subagent integration).

## Subagents

livespec can hand role work (`scout`, `implementer`, `reviewer`) to subagent children, and it can run independent units in parallel lanes. The `verifier` role is reserved for LS-08 (no tool can give it a finding yet). Without an executor, every role runs inline in the main session and leaves the same evidence. See [Architecture: Subagents](docs/architecture.md#subagents).

**Executor setup.** Install the executor [`@ttdua/pi-subagents`](https://github.com/ttdua/pi-subagents) 0.1.1 or later:

```sh
pi install git:github.com/ttdua/pi-subagents@v0.1.1
```

To add Jev model routing, install [pi-jev-pilot](https://github.com/ttdua/pi-jev-pilot) 0.6.0 or later after the executor. pi-jev-pilot 0.5.x bundled the executor itself; from 0.6.0 it no longer does.

livespec detects the executor by capability: the published service must provide `spawn`, `wait`, `resume`, `abort`, `childSession` and `getAgentType`. It never checks the package name or version. `/livespec doctor` reports the executor, any missing capability and any role agent that a user or project file overrides.

**Model and effort.** livespec never sets a model. It requests a thinking level only: the unit's `Difficulty` (`low`, `medium`, `high`) is the default, raised one level after each failed attempt.

- **With Jev**, pi-jev-pilot's launch policy routes the model and may replace the thinking level.
- **Without Jev**, the role's agent file and your pi settings choose the model, and the requested thinking level applies.

Each `dispatch` record stores the requested thinking and the effective model and thinking, so you can audit the routing.

**Findings.** A blocking review finding refuses `unit_finish` until it is fixed, rebutted with `finding_rebut` or, for `needs-decision`, answered. An `out-of-scope` finding never refuses the tick; it is listed at the next human gate.

**Known limit.** A pi `/fork` or `/clone` of your main session is treated as a child when no executor is installed: it shows no phase card and the subagent and lane tools refuse there. With an executor, only the executor decides which sessions are children.

**Role guidance.** Give `reviewer` and `verifier` strong models, because their findings gate `unit_finish`. A fast, cheap model suits `scout`, which only reads. Override a role by placing an agent file with its name (for example `~/.pi/agent/agents/reviewer.md`). livespec uses the override as is and doctor lists it.

**Workspace providers.** `@gotgenes/pi-subagents-worktrees` conflicts with livespec lanes: it moves a child into its own worktree, so the lane's unit has to re-run sequentially. Remove `npm:@gotgenes/pi-subagents-worktrees` from your pi settings to keep lanes parallel. Doctor warns while it is configured.

## Documentation

- [Project brief](docs/project-brief.md): intent, goals, non-goals and constraints.
- [Architecture](docs/architecture.md): modules, where data lives, the phase flow.
- [Glossary](docs/glossary.md): the vocabulary used by the specs and issues.
- [Roadmap](docs/roadmap.md): the specs in build order, with their issues.
- [Decisions](docs/decisions/): architecture decision records.

## Development

This repository is built with [pi-superspec](https://github.com/ttdua/pi-superspec):

- Each roadmap spec is one GitHub issue, one OpenSpec change and one pull request. The issue names the change.
- To start a spec, run `/opsx-new <change-name>` and use the issue as the input to brainstorming.
- Once a change is archived, the behavior it built is recorded in `openspec/specs/`.

There are two kinds of spec folder, and they are easy to confuse:

- `openspec/` is this repository's own development record, managed by pi-superspec.
- `specs/` is the folder pi-livespec creates in the projects that *use* it.

Repository content is in English.

## License

MIT. See [LICENSE](LICENSE).
