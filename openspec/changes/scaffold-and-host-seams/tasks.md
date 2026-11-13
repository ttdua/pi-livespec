## 1. Package skeleton

Blocked by: none

- [ ] 1.1 Add `package.json` (pi manifest, peer dependency `*`, `yaml`, scripts), `tsconfig.json`, `vitest.config.ts` and the lockfile
- [ ] 1.2 Add `src/version.ts` and `src/extension.ts` registering `/livespec` that prints the version, with tests
- [ ] 1.3 Add a test that checks manifest paths and the dependency policy
- [ ] 1.4 Add `.github/workflows/ci.yml` running typecheck and tests on push and pull request

## 2. Probe harness and local-only probes

Blocked by: 1

- [ ] 2.1 Create the scratch pi home and the evidence skeleton `docs/evidence/host-seams.md` with one section per probe
- [ ] 2.2 Run probes a, b, d, h and i; record results and fallbacks
- [ ] 2.3 Run probe e (pi-jev-pilot executor from its checkout; the other packages in the scratch home) and probe f

## 3. Probes needing models, Docker or a human

Blocked by: 2

- [ ] 3.1 Run probe c with both configured models over at least 5 turns and record per-turn cache-read tokens
- [ ] 3.2 Run probe g against a local Gitea container and record API coverage against its swagger
- [ ] 3.3 Prepare probe j, ask the person to confirm it, and record the result (or mark unverified)

## 4. Consequences, checks and cleanup

Blocked by: 3

- [ ] 4.1 Write Consequence and Fallback for every probe; add or supersede ADRs and update `docs/decisions/README.md`
- [ ] 4.2 Add `tests/evidence.test.ts` that checks the evidence document structure and the ADR index
- [ ] 4.3 Remove probe code and scratch directories; check the real pi config is unchanged
- [ ] 4.4 Run typecheck and tests fresh
