## Why

Later specs (LS-02 to LS-11) depend on pi host behavior nobody has verified: prompt-cache placement of injected context, child-session extension loading, whether a hook can block a shell command, and others. A wrong assumption found late forces rework across many specs. There is also no package yet for them to build on. One small change now removes both risks.

## What Changes

- Add the package skeleton: TypeScript, vitest, GitHub Actions CI, the `pi` manifest, and an extension that registers `/livespec` and prints the package version.
- Run ten throwaway host probes (a–j) in a scratch pi home and record each result in `docs/evidence/host-seams.md`: question, method, raw result, consequence for the design.
- Name a fallback for every failed or unverifiable probe. When a fallback changes a decision, add an ADR or supersede the old one in `docs/decisions/`.
- Add no product behavior. Probe code is deleted after use; only short snippets stay in the evidence.

## Capabilities

### New Capabilities
- `package-scaffold`: the installable pi package, its dependency rules, its CI gate and the `/livespec` version command.
- `host-seam-evidence`: the contract of the evidence document that records the host probes and their consequences.

### Modified Capabilities

None. `openspec/specs/` has no living specs yet, so no existing requirement changes.

## Impact

- New files: `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/extension.ts`, `tests/`, `.github/workflows/ci.yml`, `docs/evidence/host-seams.md`, possibly new ADRs.
- Dependencies: peer `@earendil-works/pi-coding-agent` (`*`), runtime `yaml`; dev `typescript`, `vitest`, `@types/node`. Any other dependency needs maintainer approval.
- Probes need local Docker (probe g), real model turns with `claude-code/claude-haiku-5-5` and `9router/gpt-6-luna` (probe c) and a human at the UI (probe j).
- Later specs cite `docs/evidence/host-seams.md` for their host assumptions.
