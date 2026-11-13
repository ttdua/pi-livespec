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
