# Scaffold and Host Seams Implementation Plan

> Executed via `/opsx-apply`, which chooses the executor.
> Spec reference: this change's `specs/` and `design.md`.

**Goal:** Ship a loadable pi package with a `/livespec` version command and CI, and record verified evidence for ten pi host behaviors.

**Architecture:** One TypeScript extension entry point (`src/extension.ts`) delegating to a pure `readVersion()` (`src/version.ts`). Probes run as throwaway code in a scratch pi home; only their results and short snippets are kept in `docs/evidence/host-seams.md`. A vitest test guards the evidence structure.

**Tech Stack:** TypeScript, vitest, bun, `yaml`, `@earendil-works/pi-coding-agent` (peer), GitHub Actions.

---

## Contracts

| Name | new / modified | Shape | public |
|---|---|---|---|
| `package.json` pi manifest | new | `"pi": { "extensions": ["./src/extension.ts"] }` | public |
| Dependency policy | new | `peerDependencies: { "@earendil-works/pi-coding-agent": "*" }`; `dependencies: { "yaml": "<semver>" }` only | public |
| `/livespec` command | new | no arguments; sends the text `pi-livespec <version>` to the user; no side effects | public |
| `readVersion` | new | `readVersion(packageJsonPath?: string): string` in `src/version.ts`; reads `version` from `package.json` | internal |
| `extension` default export | new | `export default function (pi: ExtensionAPI): void`; calls `pi.registerCommand("livespec", …)` | internal |
| CI workflow | new | `.github/workflows/ci.yml`, triggers `push` and `pull_request`, runs `bun run typecheck` and `bun run test` | public |
| Evidence document | new | `docs/evidence/host-seams.md`: one H2 per probe `## (a) …` to `## (j) …`, each with H3 `Question`, `Method`, `Result`, `Consequence`, `Fallback`; unverified probes put `Unverified: <reason>` under Result | public |
| ADR index | modified | `docs/decisions/README.md` table gains a row for each new ADR; superseded ADRs show status `Superseded by NNNN` | public |

---

## Task 1: Package skeleton — implements 1

**Covers:** 1.1, 1.2, 1.3, 1.4
**Difficulty:** Normal
**Blocked by:** none

Files: create `package.json`, `tsconfig.json`, `vitest.config.ts`, `bun.lock`, `.gitignore`, `src/version.ts`, `src/extension.ts`, `tests/version.test.ts`, `tests/extension.test.ts`, `tests/manifest.test.ts`, `.github/workflows/ci.yml`.

- [ ] **Step 1:** Write `package.json` (name `pi-livespec`, `type: module`, `pi.extensions`, peer dep `*`, dependency `yaml`, devDependencies `typescript`, `vitest`, `@types/node`, `@earendil-works/pi-coding-agent`, scripts `typecheck` and `test`), `tsconfig.json` (strict, NodeNext, `noEmit`, include `src` and `tests`) and `vitest.config.ts`, copying the conventions of `pi-superspec`. Run `bun install` and commit `bun.lock`.
- [ ] **Step 2:** Write failing `tests/version.test.ts`: `readVersion()` equals the `version` in `package.json`.
- [ ] **Step 3:** Run `bun run test`; expect FAIL (module missing).
- [ ] **Step 4:** Implement `src/version.ts`; run the test; expect PASS.
- [ ] **Step 5:** Write failing `tests/extension.test.ts` with a fake `ExtensionAPI`: the extension registers `livespec`; running its handler sends text containing the version and calls nothing else.
- [ ] **Step 6:** Run; expect FAIL. Implement `src/extension.ts`; run; expect PASS.
- [ ] **Step 7:** Write `tests/manifest.test.ts`: every `pi.extensions` path exists; peer range is `*`; `dependencies` keys equal `["yaml"]`; `ci.yml` contains `push`, `pull_request`, `typecheck` and `test`. Run; expect PASS once `ci.yml` exists.
- [ ] **Step 8:** Write `.github/workflows/ci.yml` (checkout, setup-bun, `bun install --frozen-lockfile`, `bun run typecheck`, `bun run test`). Run `bun run typecheck && bun run test`; expect PASS.
- [ ] **Step 9:** Smoke-load: run pi in a scratch home with the package path and run `/livespec`; expect the version. Commit `feat: package skeleton and /livespec version command`.

---

## Task 2: Probe harness and local-only probes — implements 2

**Covers:** 2.1, 2.2, 2.3
**Difficulty:** Hard
**Blocked by:** Task 1

Files: create `docs/evidence/host-seams.md`; throwaway files only under a temp scratch directory outside the repo.

- [ ] **Step 1:** Create a scratch directory (`mktemp -d`) with its own pi home (`PI_CODING_AGENT_DIR`-style override per pi docs, read `docs/` first) and project dir; record pi version (`pi --version`). Before any probe, save a copy of the real pi settings file and package list outside the repo, for the comparison in Task 4 Step 6.
- [ ] **Step 2:** Write the evidence skeleton with H2 sections `(a)`–`(j)`, each with Question (copied from issue #1), Method, Result, Consequence, Fallback placeholders.
- [ ] **Step 3:** Probe (a): install the Superpowers package in the scratch home, add project settings `"skills": []` and `"extensions": []` for it, start pi, and check that no Superpowers skill or bootstrap message is present. Record raw output.
- [ ] **Step 4:** Probe (b): a throwaway extension whose `resources_discover` returns two individual skill directories from a multi-skill clone; check that only those two are listed.
- [ ] **Step 5:** Probe (d): a throwaway extension on `agent_before_settle` requesting one continuation with a message; observe the continuation count and what happens afterwards, including a second request.
- [ ] **Step 6:** Probe (h): two throwaway extensions; one registers an adapter over `pi.events` request/response, the other calls it; record round trip and failure behavior when no adapter exists.
- [ ] **Step 7:** Probe (i): a throwaway `tool_call` hook that blocks bash with a reason; test the plain command, `sh -c '…'`, an `env FOO=1` prefix and `git -C <dir> push`; record what string the hook sees and whether the agent sees the reason.
- [ ] **Step 8:** Probe (e): list the four executors' versions; for each, start a child session and check whether a marker extension loads in the child and whether it can detect that it is a child. Use `~/.pi/agent/git/github.com/ttdua/pi-jev-pilot/packages/pi-subagents` from its checkout; install the other three only in the scratch home.
- [ ] **Step 9:** Probe (f): in a session with a known prompt, compare `ctx.getContextUsage()` with the provider's reported token counts over several turns; record the error range.
- [ ] **Step 10:** Fill Result for (a), (b), (d), (e), (f), (h), (i); a probe that cannot run gets `Unverified: <reason>`. Commit `docs: host seam evidence (local probes)`.

---

## Task 3: Probes needing models, Docker or a human — implements 3

**Covers:** 3.1, 3.2, 3.3
**Difficulty:** Hard
**Blocked by:** Task 2

Files: modify `docs/evidence/host-seams.md`; throwaway files under the scratch directory.

- [ ] **Step 1:** Probe (c): a throwaway extension whose `context` hook appends one message at the end of the list and replaces it each turn. Run at least 5 turns on `claude-code/claude-haiku-5-5` and again on `9router/gpt-6-luna`, plus a control run without the hook; record cache-read tokens per turn for each.
- [ ] **Step 2:** Probe (g): start a Gitea container (`docker run` in the scratch dir), create an admin and a repo, fetch `/api/swagger`, then call each operation in the issue: edit issue body with a concurrency check, comments (create, edit, list), labels, pull requests (create, update), review comments (list, create), commit status or checks. Record request, response status and a verdict per operation.
- [ ] **Step 3:** Stop and remove the Gitea container and volumes.
- [ ] **Step 4:** Probe (j): prepare a throwaway tool that shows `select`, `confirm` and `text` prompts and returns only the UI answer; check with the installed `rpiv-ask-user-question` (scratch home) that its result holds only the human's choice. Ask the person in the Inbox to run it; record the answer, or mark `Unverified` with the reason if not confirmed.
- [ ] **Step 5:** Fill Result for (c), (g), (j). Commit `docs: host seam evidence (model, Gitea, UI probes)`.

---

## Task 4: Consequences, checks and cleanup — implements 4

**Covers:** 4.1, 4.2, 4.3, 4.4
**Difficulty:** Normal
**Blocked by:** Task 3

Files: modify `docs/evidence/host-seams.md`, `docs/decisions/README.md`; create `tests/evidence.test.ts` and any new `docs/decisions/NNNN-<slug>.md`; modify a superseded ADR's status line.

- [ ] **Step 1:** Write failing `tests/evidence.test.ts`: the document has H2 sections for probes a–j in order; each has Question, Method, Result, Consequence and Fallback; a section whose Result starts with `Unverified:` has a non-empty Fallback and no other result text; every ADR file in `docs/decisions/` appears in the README table; any ADR marked `Superseded` links to an existing file.
- [ ] **Step 2:** Run; expect FAIL until Consequence and Fallback are written.
- [ ] **Step 3:** Write Consequence and Fallback for each probe, citing the later spec that uses it (a, b: LS-04; c: phase card; d: settle continuation; e: `forge_read` and guards; f: `context>=N%`; g: Gitea adapter; h: approval adapters; i: guards; j: in-session approver).
- [ ] **Step 4:** For each fallback that changes an accepted ADR, add a new ADR or mark the old one `Superseded` with a link, and update `docs/decisions/README.md`.
- [ ] **Step 5:** Run the test; expect PASS.
- [ ] **Step 6:** Delete the scratch directories and any probe leftovers; check `git status` shows no probe code and that the real pi settings and package list are unchanged (compare with a copy taken before Task 2).
- [ ] **Step 7:** Run `bun run typecheck && bun run test`; expect PASS. Commit `docs: probe consequences, ADRs and evidence check`.

---

## Scenario → test

- Pi loads the extension → `tests/extension.test.ts` (fake API registers `livespec`) plus the Task 1 Step 9 smoke-load.
- Manifest names a real entry point → `tests/manifest.test.ts`.
- Peer dependency range → `tests/manifest.test.ts`.
- Runtime dependencies → `tests/manifest.test.ts`.
- Command prints the version → `tests/extension.test.ts`, `tests/version.test.ts`.
- Command has no side effects → `tests/extension.test.ts` (fake API records only the one message).
- Workflow triggers → `tests/manifest.test.ts` (reads `ci.yml`).
- Failing check blocks → verified by CI behavior: a deliberately failing test on a throwaway branch (Task 1 Step 8) shows the run fails.
- All probes present → `tests/evidence.test.ts`.
- Section content → `tests/evidence.test.ts`.
- Failed probe → `tests/evidence.test.ts` (Fallback non-empty for every probe).
- Unverifiable probe → `tests/evidence.test.ts` (Unverified rule).
- Fallback changes a decision → `tests/evidence.test.ts` (ADR index and Superseded links).
- Source tree is clean → Task 4 Step 6 (`git status` and `rg` for probe files in `src/`).
- Real config untouched → Task 4 Step 6 (before/after comparison).
