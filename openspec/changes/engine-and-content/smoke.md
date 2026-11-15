# Cache smoke: phase card over real models

Manual run for `context-injection` / Requirement: Cache evidence, in the format of probe (c) in `docs/evidence/host-seams.md`.

## Setup

- **Date and host:** 2026-11-15, pi 1.5.2 on macOS (Darwin 24.6.0), commit `12a4c43`..`2d4dbad` of branch `engine-and-content`.
- **Isolation:**
  - `PI_CODING_AGENT_DIR` and `HOME` point at a scratch directory, so the real `~/.pi` was not read for livespec state and was never written.
  - Runs use `-ne -ns` (no discovered extensions or skills). Extensions are loaded explicitly with `-e`: `pi-9router-ext` (model route), the livespec extension (hooked runs only), and a logger that appends `turn_end` usage and the last `context` message to a file.
- **Project:**
  - A scratch git repo with `.pi/livespec/config.yaml` (`forge: gitea`, `host: gitea.invalid`) and an `https://gitea.invalid/...` origin, with `protocol.https.allow never`.
  - So the project is initialized and the forge is unavailable. Every turn shows the same `forge unavailable` card: the card text was byte-identical on every turn (one unique value).
  - No agent-skills clone exists, so no skills are exposed.
- **Prompt:** `Run the bash command 'ls' N times, one call at a time …`, one turn per tool call. The control run is the same command without the livespec extension.
- **Models:** through the local 9router: `cmc/claude-haiku-5-5`, `cmc/gpt-5.6-luna`, `cx/gpt-5.6-luna`.

## Results

Per turn `input / cacheRead` (tokens; `input` is the uncached part).

### cmc/claude-haiku-5-5 (6 calls, 7 turns)

| Turn | control | livespec |
|---|---|---|
| 1 | 2922 / 0 | 4301 / 0 |
| 2 | 60 / 2918 | 169 / 4192 |
| 3 | 58 / 2976 | 167 / 4250 |
| 4 | 58 / 3032 | 167 / 4306 |
| 5 | 58 / 3088 | 167 / 4362 |
| 6 | 58 / 3144 | 167 / 4418 |
| 7 | 58 / 3200 | 167 / 4474 |

`cacheRead` grows every turn in both runs, and the hooked run reads more than the control from turn 2 on. The routing note adds about 1300 cached tokens. Uncached input is a constant ~110 tokens above control, the size of one card. **Pass.**

### cx/gpt-5.6-luna (8 calls)

| Turn | control | livespec |
|---|---|---|
| 1 | 3425 / 0 | 4142 / 0 |
| 2 | 2181 / 1280 | 2258 / 1920 |
| 3 | 2217 / 1280 | 4214 / 0 |
| 4 | 2125 / 1408 | 2202 / 2048 |
| 5 | 2161 / 1408 | 2238 / 2048 |
| 6 | 3605 / 0 | 2402 / 1920 |
| 7 | 2233 / 1408 | 2310 / 2048 |
| 8 | 2269 / 1408 | 2218 / 2176 |
| 9 | 2177 / 1536 | — |

This route caches in 128-token blocks and misses now and then in both runs. The hooked run reads more than the control on every turn except turn 3, which was an isolated full miss. The control run also has a full miss (turn 6), so turn 3 does not count under the pass rule. **Pass.**

### cmc/gpt-5.6-luna (12 calls)

| Turn | control | livespec |
|---|---|---|
| 1 | 40 / 1385 | 109 / 2033 |
| 2 | 39 / 1422 | 145 / 2033 |
| 3 | 39 / 1458 | 181 / 2033 |
| 4 | 39 / 1494 | 217 / 2033 |
| 5 | 39 / 1530 | 253 / 2033 |
| 6 | 39 / 1566 | 289 / 2033 |
| 7 | 39 / 1602 | 325 / 2033 |
| 8 | 39 / 1638 | 361 / 2033 |
| 9 | 39 / 1674 | 397 / 2033 |
| 10 | 39 / 1710 | 433 / 2033 |
| 11 | 39 / 1746 | 469 / 2033 |
| 12 | 39 / 1782 | — |
| 13 | 39 / 1818 | — |

In the control run `cacheRead` grows with the conversation. In the hooked run it stays at 2033, the system prompt plus the first user message, and the uncached input grows by about 36 tokens a turn. So nothing after the first user message is ever read from cache.

Two variants isolate the cause (8 calls each):

| Variant | input / cacheRead per turn |
|---|---|
| routing note only, no `context` card | 40/2033, 39/2070, 39/2106, 39/2142, 39/2178, 39/2214, 39/2250, 39/2286, 39/2322 |
| card only, no routing note | 1888/0, 145/1779, 181/1779, 217/1779, 253/1779, 289/1779 |

The routing note is cache-friendly. The appended card is what stops incremental caching on this route.

A payload dump (`before_provider_request`) shows that the request bodies are as designed:
- the system message is identical in every request;
- every message before the card is identical to the previous request;
- the card is the last message.

The break is in how this route caches. It appears to reuse only a prefix that ends where an earlier request ended, and that point is always the previous card, which the next request no longer contains. Probe (c) did not measure this route. **Fail** under the pass rule, from turn 2 on.

## Verdict

- **Pass:** `cmc/claude-haiku-5-5` and `cx/gpt-5.6-luna`.
- **Fail:** `cmc/gpt-5.6-luna`. The phase card stops cache growth after the first user message, so uncached input grows linearly with the conversation. That is the anti-goal named in the project brief.

The decision on how to handle this is recorded in `apply.md` (Contract deviations / follow-ups) once taken.
