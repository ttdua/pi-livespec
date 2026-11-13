# Project brief

Date of this scope: 2026-11-13

## Intent

In long sessions, or near the end of one, coding agents forget and skip steps: they skip verification or review, do not record state, or declare work done without proof. pi-livespec is a native pi extension that owns the spec layer and the workflow state, so the agent cannot skip a step without being blocked or detected.

- The extension holds the state and enforces it, so the agent cannot jump ahead.
- A change lives on a forge issue (GitHub or Gitea), and each change ships as exactly one pull request.
- What to do in each phase comes from the agent-skills collection.

## Sources

| Source | What pi-livespec takes |
|---|---|
| OpenSpec | Spec format (Requirement with SHALL/MUST, Scenario with WHEN/THEN), proposal and design, a flow declared as data, validation, the contract between declared capabilities and edited specs |
| litespec | The issue as the work queue and the change's source of truth; a small-fix lane and a full lane; living specs edited in place; units with `Done means` mapped to scenarios; one `Verify` command that must fail before the work; receipts that are red before and green after, posted by tools; ticks done only by tools; unit digests and amendments; `product.md`, glossary and decisions |
| agent-skills | The content of each phase: skills and reviewer personas |
| pi-superspec | Harness patterns: per-turn context injection, subagent integration, `init` with a lock file and backups |

## Goals

- The agent cannot mark a unit done, ship a change or close a change without evidence and without human approval. A small fix ships as a pull request only after its tests pass, and a human merges it.
- After compaction or in a new session, the agent knows where it is and what comes next, without having to remember.
- Living specs with validation, without OpenSpec or Go installed.
- The flow is data written in YAML. The default pack follows agent-skills.
- Changes are tracked on the project's issues and pull requests. GitHub and Gitea are supported first.
- Large work is split into several changes, each with one issue and one pull request, in dependency order.
- Subagents are used where they help, in parallel when possible. The extension never picks models.
- agent-skills is installed from its upstream repository and kept up to date by default.
- The human approval channel is an adapter the user chooses.
- Every decision point has a rule that runs without any external classifier.

## Non-goals (v1)

- A Superpowers flow pack. The architecture allows one later.
- Stacked pull requests. v1 is sequential only.
- An offline mode with a local file queue instead of a forge.
- Other forges (GitLab, Forgejo). The adapter interface allows them later.
- Risk-case analysis and pre/post/HEAD replay in worktrees.
- Blocking pushes made outside pi (git hooks, branch protection).
- Jev-based decisions. v1 decides with rules, and Jev is a later upgrade ([ADR 0006](decisions/0006-rule-based-decisions.md)).

## Anti-goals

The work has failed, even if it technically runs, when:

- A small fix requires heavy ceremony.
- An agent inside pi gets around a gate (with `sed -i`, `gh issue edit`, `git -C . push`, and so on) without being blocked or detected.
- The phase card breaks the prompt cache every turn, so a long session costs several times more.

## Constraints

- Runs on pi, with `@earendil-works/pi-coding-agent` as a peer dependency (`*`).
- TypeScript with vitest.
- The only runtime dependency is `yaml` (eemeli/yaml, no transitive dependencies). Any other dependency needs the maintainer's approval first. Gitea is called with Node's built-in `fetch`, not an SDK.
- Needs `git`, plus `gh` (GitHub) or a Gitea token, plus network access to fetch agent-skills and reach the forge.
- Never installs git hooks and never changes branch protection.
- This repository is public, so code, docs, commits and comments are in English.
