# Fix iteration 3 report

## CRITICAL 1: expansion script bypass
- Root cause: `checkChildScript` (classify.ts) used `obscured(nestedScan(...))`, which blocks on `dangerous` only. An expansion script that names `.pi/livespec` was allowed, although the unreadable-text path blocks it.
- Change: the expansion branch now calls `obscured({...nested, dangerous: nested.dangerous || nested.mentionsLivespec})`. `nestedScan` already scans the decoded text, so `\_` is a separator. `sh -c` and `flock -c` share this function, so they were affected the same way and are fixed too.
- Test: "an expansion script that mentions .pi/livespec fails closed" in tests/guard/classify.test.ts. It blocks `env -S 'rm\_.pi/livespec/flow.yaml ${X}'`, `sh -c "rm .pi/livespec/flow.yaml $X"`, `bash -c` with `${X}`, and `flock F -c '…'"$X"`. It allows `env -S 'echo\_hi'`, `env -S 'echo\_${X}'` and `sh -c "echo $X"`.
- RED (878d376 src): `bunx vitest run tests/guard/classify.test.ts` → 1 failed, all 4 block commands received as allowed. GREEN: `bunx vitest run tests/guard` → 66 passed.

## CRITICAL 2: determinism under load
- Root cause: the e2e tests used the 5 s default timeout. Under load they time out mid-run and leave a temp `home/cache`. The next test's `rm` then hits ENOTEMPTY, and the later assertion fails.
- Change: a project-wide `testTimeout`/`hookTimeout` of 30_000 in vitest.config.ts. I chose this over per-file patches because several heavy git/e2e files share the problem, and one setting covers all of them. `rm` in tests/tools/helpers.ts and tests/helpers/repo.ts now uses `maxRetries: 5, retryDelay: 50`.
- RED: with 40 busy loops running (load about 39) and a 50 ms timeout override, `gates-flow.test.ts` → both tests "timed out". That reproduces the timeout failure mode. It did not reproduce naturally on this machine at load 39, where the 5 s default still passed. GREEN: the two full runs below.

## SUGGESTION: pgrep markers
- tests/evidence/runner.test.ts now sleeps for a random-suffixed duration (`sleep 5.<rand>`), and `running` greps for that exact command. Other processes on the machine can no longer match it.

## Verification
- `bun run typecheck`: clean.
- `bun run test` run 1, `uptime` load 31.29 17.79 20.34 → 136 files / 1949 tests passed.
- `bun run test` run 2, `uptime` load 48.75 24.66 22.72 → 136 files / 1949 tests passed.
- A first run at load 6 after commit 1 also passed.

## Contract deviations
None.
