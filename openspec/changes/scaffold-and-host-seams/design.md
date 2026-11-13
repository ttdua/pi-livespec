## Context

The repo has docs and ADRs only. The sibling package `pi-superspec` shows a working layout: `package.json` with a `pi.extensions` key, vitest, `tsc --noEmit`, peer dependency `*`. Pi 1.5.2 is installed locally. `brainstorm.md` fixes the approach (real probes in a scratch pi home, evidence recorded as results arrive, no kept probe code). This document covers only the technical choices it leaves open.

## Goals / Non-Goals

**Goals:**
- A package that pi loads and that CI can check.
- Reproducible probe evidence a later spec can cite.

**Non-Goals:**
- Product behavior, state machine, forge access, or any `tools/` and `hooks/` listed in `docs/architecture.md`.
- Keeping probe code as files.

## Decisions

- **Layout follows pi-superspec**, except that source lives in `src/` (as `docs/architecture.md` implies): `src/extension.ts` is the single entry point and `package.json` declares `"pi": { "extensions": ["./src/extension.ts"] }`. Pi loads TypeScript directly, so there is no build step. Reason: the least code and the same convention as the sibling package.
- **Version source.** `/livespec` reads `version` from `package.json` through a small `readVersion()` in `src/version.ts` so the command logic is testable without pi. Reason: no duplicated version string.
- **Tooling.** `typescript`, `vitest`, `@types/node` as devDependencies, `bun` as package manager and CI runner (user rule), with `bun.lock` committed. Scripts `typecheck` (`tsc --noEmit`) and `test` (`vitest run`). Reason: global rule prefers `bun`; CI locks to the same lockfile.
- **CI.** One workflow on `push` and `pull_request`: checkout, setup bun, `bun install --frozen-lockfile`, typecheck, test.
- **Probe isolation.** Each probe uses a scratch pi home and project directory under a temp dir; the real `~/.pi` is never read for writing. Packages for probe (e) are installed only there, except the pi-jev-pilot executor, which is loaded from its local checkout.
- **Probe (g)** runs a local Gitea container in a scratch directory and compares its API behavior with `/api/swagger` of the same release.
- **Probe (c)** compares cache-read tokens over at least 5 turns with the appended message replaced each turn against a control run without it, on both configured models.
- **Evidence format.** One H2 section per probe, fixed sub-headings: Question, Method, Result, Consequence, Fallback. An unverifiable probe says so under Result and still names a fallback.
- **ADR rule.** A fallback that changes a decision gets a new ADR (next number) or marks the old one `Superseded` with a link, and updates `docs/decisions/README.md`.

## Risks / Trade-offs

- [Probe (j) needs a human click] → prepare it and ask in the Inbox; if no answer, record it unverified with the fallback.
- [Probe (c) is noisy across models] → report raw numbers per turn and per model, not a single verdict.
- [Third-party package versions drift] → record exact versions and the pi version in each Method.
- [Docker or Gitea image unavailable] → record probe (g) unverified; fall back to swagger-only comparison.
- [`vitest`/`typescript` versions chosen here become the baseline] → use the same majors as pi-superspec to stay consistent.
