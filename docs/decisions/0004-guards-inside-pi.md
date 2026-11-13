# 0004: Guards inside pi only

Status: Accepted (2026-11-13)

## Context

An agent can get around a workflow with shell commands such as `gh issue edit`, `git push` or `sed -i` on state. Git hooks and branch protection would also catch pushes from outside pi, but they change the user's repository and settings.

## Decision

- A `tool_call` guard blocks forge writes made outside the plugin's tools, and direct `git push` and pull request creation or merge by the agent. Pushes happen only inside livespec tools, which check the state first. The guard fails closed.
- The plugin installs no git hooks and never changes branch protection.

## Consequences

- Pushes made outside pi are not blocked. This is an accepted limit.
- The guard has to recognize command variants (`git -C . push`, `sh -c`, environment prefixes).
