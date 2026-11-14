## Design Summary

LS-01 (issue #1) lays the foundation for every later spec. It delivers two things and no product behavior.

1. **Package skeleton.** A TypeScript package with vitest that pi can load. Its one extension entry point registers `/livespec`, which only prints the package version. Typecheck and tests run in GitHub Actions on every push and pull request. `@earendil-works/pi-coding-agent` is a peer dependency (`*`), `yaml` is the only runtime dependency.
2. **Host evidence.** Ten throwaway probes (a–j) check pi behaviors that later specs rely on. Each result is recorded in `docs/evidence/host-seams.md` with the question, the method, the raw result and the consequence for the design. A failed probe names a fallback; if the fallback changes a decision in `docs/decisions/`, a new ADR is added or the old one superseded.

No living spec exists yet (`openspec/specs/` is empty), so this change alters no specified requirement. It introduces the first ones: the `/livespec` command, the package loading contract and the evidence document contract.

Environment facts found: pi 1.5.2 is installed. The four subagent executors (probe e) and `rpiv-ask-user-question` (probe j) are not installed here. Probe (c) spends model tokens, (g) needs a Gitea instance, (j) needs a human at the UI.

## Alternatives Considered

### Alternative A: Probes run by the agent in an isolated scratch pi home, evidence written as the probes complete
- **Approach**: Each probe is a minimal throwaway extension or script run in a scratch pi home. The agent runs everything it can automate; probes that need a human (j), real spend (c) or an external service (g) are prepared and run with the person's confirmation.
- **Pros**: First-hand evidence; the real pi config stays untouched; repeatable steps.
- **Cons**: More work up front; (c), (g), (j) need the person.
- **Why not chosen**: Chosen as the agreed approach (see below).

### Alternative B: Probes answered from documentation and source reading only
- **Approach**: Read pi docs and executor source, write conclusions without running anything.
- **Pros**: Cheap, no setup.
- **Cons**: The issue asks for evidence with raw results and measurements (cache-read tokens, `getContextUsage` accuracy); reading cannot give them. Docs can be stale.
- **Why not chosen**: Defeats the purpose of the change, which is to avoid late rework from unchecked assumptions.

### Alternative C: Probes as permanent code in the repository
- **Approach**: Keep probe extensions as runnable files in the repo so they can be re-run.
- **Pros**: Re-runnable.
- **Cons**: The issue says probe code is not kept in `src/`; permanent files add clutter and need CI exclusion.
- **Why not chosen**: Short snippets inside the evidence document give enough reproducibility.

## Agreed Approach

Alternative A. The scaffold is built first so the extension loads, then the probes run in a scratch pi home and results go into `docs/evidence/host-seams.md`. Probes that need the person (j), real model spend (c) or an external Gitea (g) are prepared by the agent and executed or confirmed by the person; if the person cannot run one, the evidence records it as not verified with the reason and a named fallback rather than a guessed result.

Probe code is deleted after use. Each evidence section keeps the method as exact steps plus a short code snippet where needed, so a later spec can repeat it.

## Key Decisions

- The person skipped both open questions, so these are **assumptions** and the person may overturn them at this gate:
  - Run everything automatable myself; (c), (g), (j) are prepared and confirmed with the person.
  - Probe code is not kept as files; only short snippets live inside the evidence sections.
- Probe (c) may spend tokens, using `claude-code/claude-haiku-5-5` and `9router/gpt-6-luna`.
- Probe (g) runs against a local Gitea started with Docker in a scratch directory (Docker/OrbStack is available here); no real token or remote system is used.
- Probe (e): pi-jev-pilot already ships a fork of pi-subagents (`packages/pi-subagents`), so that executor is tested from the local checkout; the other three packages are installed only into a scratch pi home.
- Probes never touch the real pi settings; each uses a scratch pi home or project directory.
- An unverifiable probe is reported as unverified, never filled with an assumed answer.
- No product behavior is added; `/livespec` prints the version only.
- No dependency beyond `yaml` is added without maintainer approval.

## Open Questions

- Which exact versions of `@tintinweb/pi-subagents`, `pi-subagents` and `@gotgenes/pi-subagents` does probe (e) install, and is the pi-jev-pilot executor (`packages/pi-subagents`, a vendored fork) tested from its local checkout? Resolved during design.
