# Apply Receipt

**Change**: `forge-accounts`
**Iteration**: `1`
**Applied at**: `2026-11-15T15:25:09+0700`
**Executor**: `subagent-driven-development`.
- **Agents:** `implementer` writes each task; `code-reviewer` (read-only tools) reviews each task.
- **Reviews:** one combined spec and quality review after each task, scoped re-reviews after each fix round, then one whole-branch review with a single fix wave and its scoped re-review.

---

## Workspace

- **Worktree path**: `/Users/naicoi/Projects/oss/pi-livespec.forge-accounts`
- **Worktree branch**: `forge-accounts`
- **Feature branch**: `spec/forge-accounts`
  - It was checked out before step 0, which committed the change directory there as `c4e2cc9`.
  - The feature branch was cut from `ls-04` (PR #15, LS-04), so it must merge after #15.
- **Base branch**: `main`

---

## Commits

- **Range**: `c4e2cc9..HEAD`.
  - `c4e2cc9` is the scaffold commit of the change directory.
  - HEAD is the parent of this receipt, `3c41644`; the receipt itself is committed after it.
- **Count**: `19` commits up to `3c41644`, with no merge commits.

---

## Tasks

- **Completed**: `19 of 19` checkboxes in `tasks.md` are `- [x]`.
- **Remaining**: none.
- **Checks:**
  - `bun run typecheck`: clean.
  - `bun run test`: 1152 tests in 84 files passed.
  - `openspec validate forge-accounts --strict`: valid.
  - `dependencies`: still exactly `yaml`.
- **Manual smoke:** recorded in `smoke.md`. **PASS:** a real pi session on a scratch clone of `ttdua/pi-livespec` chose and stored `ttdua` while `naicoi92` was the active account in a scratch gh config. The session forge called GitHub as `ttdua`, and no `gh auth switch` was run.

---

## Open item for the next iteration

- **Gitea read-only fallback token is not redacted** (found by the re-review of the final fix wave; Important, security).
  - **Problem:** on a refused Gitea selection, the adapter now reads with `readOnlyLogin` (`src/hooks/session.ts:311`). The refused resolution carries no token, so the `RedactingForge` at `session.ts:328–332` gets an empty token list. A Gitea HTTP error that echoes the credential could then reach session errors or the card unredacted. That violates "Secret handling".
  - **Fix:** fetch the read-only login's token through `AccountEnv` and add it to the connection's redaction list, without treating the login as chosen or clearing `accountBlock`.
  - **Regression test:** a refused Gitea read returns an error containing that token; the token must be absent from session errors and model-visible output, and writes must stay blocked.
  - **Rule:** SDD allows no second fix wave after the whole-branch review, so this is handed to verify, which should score it CRITICAL, and then to `/opsx-apply` iteration 2.

---

## Contract deviations

### Public

None changed in shape. All new public rows were added as planned.

### Internal

**Task 1: adapters accept an account**
- `TeaLogin` is exported for the return type of `teaLogins`.
- `DetectDeps.teaLookup` was added for tests.
- A `giteaUrl` with a path prefix keeps the path in `baseUrl`.
- An invalid `giteaUrl` fails at detection with `unsupported`.

**Task 2: discovery, access check, storage**
- `listCandidates`, `candidateToken` and `checkAccess`/`checkAll` take a `ForgeTarget`.
- `ExecFn` gains an optional fifth `signal`, and `createExec` sends SIGKILL after a 500 ms grace when an aborted child ignores SIGTERM.
- `writeStored(…, forge)` and the forge-aware `isSafeAccountName` were added; `isSafeRemote` is a separate check for the remote. GitHub names must match `^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$` (design wins over the plan's generic rule).
- `ABORTED_SPAWN_ERROR` is exported.

**Task 3: pure selection**
- A stored name that is invalid for the forge is treated exactly as "not stored".
- `selectAccount` never returns the `invalid` reason.

**Task 4: session wiring**
- `ResolvedAccount.source` is optional; it is undefined for a refusal and rendered as "none".
- `Session.bind(link)` was added.
- The hook-harness origin is `https://github.com/acme/shop.git`.
- An environment token gives the adapter the account name `GH_TOKEN`.
- `tests/e2e-resume.test.ts` injects fake accounts so it never reaches the real `gh`.

**Task 5: command, doctor, card**
- `src/accounts/describe.ts` holds the shared wording.
- Forge-derived fragments are wrapped with `untrusted()` where each message is built. The account modules import `untrusted` from `src/hooks/phase-card.ts`, which creates no import cycle.

**Final fix wave**
- `ResolvedAccount.readOnlyLogin` (`src/accounts/read-only.ts`): a read-only Gitea login used on a refusal.
- A `tea` login without `user` is confirmed by a successful `whoami`, and that login is recorded.
- The forge error in write refusals is wrapped with `untrusted()`.

---

## Lanes

| Task | Lane branch | Lane range | Review | Merge commit |
|---|---|---|---|---|
| 1 | sequential | `c4e2cc9..b5fe26b` | APPROVED after 1 fix round | n/a |
| 2 | sequential | `8308d17..0a67c64` | APPROVED after 1 fix round | n/a |
| 3 | sequential | `aac0587..e56442e` | APPROVED after 1 fix round | n/a |
| 4 | sequential | `8b93e5b..7981f47` | APPROVED after 1 fix round | n/a |
| 5 | sequential | `8b98a38..f32953b` | APPROVED after 1 fix round | n/a |
| 6 | sequential | `48369c3..713547e` (docs `2a1cdd2`; smoke run by the parent) | APPROVED | n/a |

**Whole-branch review** of `c4e2cc9..713547e`: "With fixes", with 1 Important, 4 Minor and 1 Nit.
- **Fix wave:** `3c41644` fixed all six.
- **Scoped re-review:** all six addressed, but it found one new Important. See "Open item for the next iteration".

---

## Known limits kept

- **No real Gitea smoke.** Gitea behaviour (named login, ambiguity, `ssh_host` mapping, read-only fallback) is covered by the loopback fake only.
- **A timed-out `gh` check can take up to about 5.5 s,** counting the SIGKILL grace.
- **Unknown-only rule.** With no environment token and only `unknown` candidates, a stored account is used unverified; otherwise writes are refused.
- **Deferred minors from the reviews:**
  - The card's `/livespec account` hint is still shown when an environment token decides.
  - `untrusted()` lives in `hooks/phase-card.ts`; moving it to a neutral module is optional.
  - The pending-`whoami` test checks only the write paths; the read paths were checked by inspection.

---

## Next step

Run `/opsx-verify`. It is expected to report the open item as CRITICAL; then run `/opsx-apply` for iteration 2.
