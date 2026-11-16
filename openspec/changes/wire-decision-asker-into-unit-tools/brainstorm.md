## Design Summary

Issue #24, follow-up to #19. `createDecisionAsker` already routes a rule `ask` through the approver chain and completes a `source: human` decision record (at once in session, later via `/livespec choose` on the forge). `plan_units` and `unit_amend` still run classification rule-only, so a rule that asks refuses them before any write.

This change lets `plan_units` and `unit_amend` ask a human when a classification rule (`tags`, `difficulty`) asks, and makes the answer stick:

- **Ask:** when a rule asks for a unit, the tool sends the question through the approver chain. An in-session answer is used at once and the run continues. A forge question leaves the tool refusing with the request id, having written nothing (no body write, no merge, no amendment request).
- **Reuse on rerun:** a recorded human answer for `<point>.U<n>` is used instead of asking again only when it was given for the same question: the same unit digest (the unit's current contract) and the same facts. A dismissed answer (outcome `null`) is never reused; the rerun asks again with a fresh request.
- **One record per decision:** the human record carries the unit digest, so it is the decision record of that unit and point. The `unit-classification` check accepts it, and the tool posts no second (rule) record for the same decision.
- The rule still runs first on every run. Reuse applies only when the rule asks; a rule that decides by itself is not overridden by an old human answer.

Existing requirements involved:
- `decision-seam` / "Decision seam": a rule MAY return `ask`; an answer gives `source: human`; a pending answer returns `pending` with the request id. This change adds when a recorded answer is reused.
- `decision-seam` / "Decision records": records carry "the unit digest when the subject is a unit". Today a human `ask` record has no digest; this change makes it comply.
- `unit-planning` / "Plan units tool" step 2 and step 5 ("one decision record per unit and decision point"): step 5 changes so a decision answered by a human is not posted again. A pending `decide:` request is already blocking for both tools; that stays.
- `unit-planning` / "Unit amendments": re-running `tags` and `difficulty` may now ask; a pending ask refuses with no amendment request sent.
- `unit-planning` / "Unit classification check": unchanged in wording; a human record with the current digest now satisfies it.

Non-goals: no built-in rule asks yet (expected in LS-08/LS-09); this change is verified with a test rule. No change to human overrides at the plan gate (`overridden_by`). No new decision points.

Anti-goals: a forge answer that never converges (rerun asks forever); an answer reused for a different question (changed unit, or `difficulty` asked again after the `tags` answer changed its facts); duplicate decision records for one decision.

## Alternatives Considered

### Alternative A: Reuse by digest only
- **Approach**: reuse any human answer recorded for the unit's current digest.
- **Pros**: simplest match; the digest is already the key `currentDecision` uses.
- **Cons**: the digest excludes Difficulty and Tags, so a `difficulty` answer given for one tag set would be reused after the `tags` answer changed; a config change that alters the facts would also reuse a stale answer.
- **Why not chosen**: it can apply an answer to a question the human never saw.

### Alternative B: Reuse by facts only
- **Approach**: reuse a human answer whose recorded facts equal the current facts, whatever the digest.
- **Pros**: tracks exactly what the rule saw.
- **Cons**: facts do not cover the whole contract (Done means, Scenarios, Verify…); the record would not be keyed to the contract, so `unit-classification` still could not see it.
- **Why not chosen**: breaks the digest keying the check depends on.

### Alternative C: Reuse by digest and facts (chosen)
- **Approach**: reuse only when both the unit digest and the facts (or their hash) match, and the outcome is not `null`.
- **Pros**: an answer applies only to the exact question asked about the exact contract; the record satisfies the check as is.
- **Cons**: any facts change (including a pack config change that reaches the facts) asks again.
- **Why not chosen**: n/a — chosen.

## Agreed Approach

Alternative C, approved by the user in chat: the strictest rule, so an answer is reused only for the question it answered, which also covers the `difficulty`-after-`tags` dependency. Dismissed answers are not reused.

## Key Decisions

- Reuse key: the latest decision record for the point, subject and unit digest (the one the classification check reads) is reused only when it is a human answer with the same facts (or `facts_hash` when the facts are large) and an outcome that is not `null`; a newer rule record for the same contract stops reuse. (Refined after plan review, so the reused answer and the checked record are always the same.)
- An added unit keeps its id when its classification asked a human, so the rerun finds the answer. (Added after plan review.)
- Dismissed (`outcome: null`) is not reused; a rerun asks again.
- The rule runs first each time; reuse is consulted only when the rule asks.
- A human-answered decision is recorded once (the human record, with digest); the tool posts no duplicate rule record for it.
- A forge ask leaves `plan_units` / `unit_amend` refusing with the request id and nothing written or sent; the existing blocking-request refusal covers reruns while it is open.
- Verified with a test rule that asks; no built-in rule is changed to ask.

## Open Questions

None.
