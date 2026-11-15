# Apply Receipt

**Change**: `forge-accounts`
**Iteration**: `2`
**Applied at**: `2026-11-15` (iteration 2; iteration 1 at `2026-11-15T15:25:09+0700`)
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
  - HEAD is the parent of this receipt, `4f40865`; the receipt itself is committed after it.
- **Count**: `23` commits up to `4f40865`, with no merge commits.
- **Iteration 2 range**: `58bc883..4f40865`, after the iteration 1 verify receipt. It holds 2 fix commits:
  - `7b71430` fix: redact the read-only tea login's token in forge errors;
  - `4f40865` fix: redact the forge environment token when account selection fails.

---

## Tasks

- **Completed**: `19 of 19` checkboxes in `tasks.md` are `- [x]`.
- **Remaining**: none.
- **Checks:**
  - `bun run typecheck`: clean.
  - `bun run test`: 1154 tests in 84 files passed, on two fresh runs in iteration 2.
  - `openspec validate forge-accounts --strict`: valid.
  - `dependencies`: still exactly `yaml`.
- **Manual smoke:** recorded in `smoke.md`. **PASS:** a real pi session on a scratch clone of `ttdua/pi-livespec` chose and stored `ttdua` while `naicoi92` was the active account in a scratch gh config. The session forge called GitHub as `ttdua`, and no `gh auth switch` was run.

---

## Iteration 2 (fix for verify FAIL)

**Cause:** the redaction list handed to `RedactingForge` and to the connect `catch` in `src/hooks/session.ts` came only from `resolved.token`, the chosen account's token. Two tokens the adapter can still send were missing from it:
1. **Read-only login:** on a refused Gitea selection the adapter reads with `readOnlyLogin` and takes that login's token from the `tea` config itself. This is the CRITICAL item in `verify.md`.
2. **Environment token on a failed selection:** when the resolution fails, for example because the stored-account read fails, it returns a block without a token. The adapter still sends `GITEA_TOKEN`, or `GH_TOKEN`/`GH_ENTERPRISE_TOKEN` for GitHub. The scoped re-review found this path; the cause is the same.

**Fix:**
- `knownTokens(target, resolved, d)` returns the chosen token plus the forge's non-empty environment token, whatever the resolution decided.
- `redactionTokens(target, resolved, d)` adds the read-only login's token from `candidateToken(d.accounts, …)`.
- These tokens are used only for redaction. They are never stored, never put on the session and never rendered. `accountBlock` is unchanged.

**Tests** (`tests/hooks/session-account-gitea.test.ts`): the fake Gitea gains `echoTokenOnRead()`, and the hook harness gains `accountGit`. Each new test has a positive control: the error text reaches the user, with the token shown as `***`.
- **Read-only login, refused selection:** the read-only login's token is absent from `session.errors`, `forgeError`, the card, and the `spec_status` content and details. `change_new` is still refused.
- **Failed selection with `GITEA_TOKEN` set:** same assertions. The stored-account read is made to fail with `git config` exit 3.
- **RED then GREEN:** both tests failed first, with the token visible in `session.errors`, then passed.
- **Not covered:** the GitHub environment token shares the code path (`envTokenVar(target)`) but has no test of its own.

**Review:** an `implementer` writes; a `code-reviewer` did the scoped re-review of `58bc883..7b71430`. Verdict: ADDRESSED, no new breakage. Its out-of-scope Critical (item 2 above) was fixed in `4f40865`, which the parent reviewed by diff and re-ran fresh: typecheck clean, 1154/1154 tests.

**Earlier flake:** the verify WARNING could not be reproduced (24 further full runs green). During iteration 2, `tests/accounts/secrets.test.ts` › "No token in arguments" once hit its 5 s timeout and passed on rerun. It is kept as a known risk, not changed here, because it is outside the CRITICAL scope.

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

**Iteration 2**
- Private helpers `knownTokens` and `redactionTokens` in `src/hooks/session.ts`. No types changed.
- Test seams: `FakeGitea.echoTokenOnRead()` and `HarnessOptions.accountGit`.

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

Run `/opsx-verify` (iteration 2).
