## Context

- `decide(point, facts, deps)` (`src/decide/seam.ts`) is pure: it runs the rule and, on `ask`, calls `deps.ask`. It never reads or writes the forge.
- `createDecisionAsker` (`src/tools/decide-ask.ts`) turns an ask into a blocking `decide:<point>.<subject>` request. It already reads comments fresh from the forge to find an open request for the subject.
- `applyDecide` (`src/interaction/complete-decide.ts`) writes the human record from `DecideSnapshot { point, subject, facts }`, without digest.
- `classifyUnits` (`src/tools/classify-units.ts`) runs `tags` then `difficulty` per unit with no asker and returns one rule record per unit and point; `plan_units` posts them before the body write, `unit_amend` stores them in `AmendSnapshot.records` for `applyAmend`.
- `unitDigest` excludes `Difficulty` and `Tags`, so the digest is known before classification runs.
- `currentDecision(marked, point, subject, digest)` picks the latest record for the digest; the `unit-classification` check and gate payload use it.

## Goals / Non-Goals

**Goals:**
- Classification in `plan_units` and `unit_amend` can ask through the approver chain.
- A recorded human answer for the same digest and facts is reused, so a forge answer converges.
- The human record is the only record for a human-answered decision and satisfies `unit-classification`.

**Non-Goals:**
- Making a built-in rule ask.
- Defining the option set a future `tags` ask offers.
- Changing gate-time overrides (`overridden_by`).

## Decisions

### D1. The digest travels through the seam
`DecideDeps` and `DecisionAsk` gain an optional `digest`; `decide` copies `deps.digest` into the ask intent. `DecideSnapshot` gains `digest?`, and `applyDecide` writes it into the record when present. Alternative: let the tool post a second record with the digest — rejected, it duplicates the decision (issue #24, problem 2).

### D2. Reuse lives in the asker, not the seam
The seam stays free of IO. `createDecisionAsker` already reads fresh comments; before looking for an open request it looks for a reusable record: `currentDecision(comments, point, subject, digest)` (the latest record for the digest, any source), reused only when it has `source: human`, outcome not `null`, and same facts. Using `currentDecision` keeps reuse and the `unit-classification` check / gate payload on the same record: a newer rule record for the digest stops reuse, so the tool never writes a human outcome that the check would compare against a rule record. On a hit it returns a new ask result `{ status: "recorded", outcome, reason }`, and `decide` returns `{ status: "decided", source: "human", outcome, reason, facts }`. The fresh read matters: the answer can arrive after the tool's snapshot. An intent without digest never reuses (non-unit subjects keep today's behaviour). Alternative: pass marked comments into `decide` — rejected, it puts forge state into the pure seam.

Order inside the asker: reuse → open request (pending) → dispatch. A newer dismissed record (`outcome: null`) after an older chosen one: "latest wins" applies first, so the latest human record for the digest decides; if it is dismissed, there is no reuse and a new request is sent.

### D3. Facts equality by canonical YAML
`sameFacts(record, facts)` in `src/decide/records.ts`: when the record has `facts`, compare `stringify(record.facts)` with `stringify(facts)`; when it has `facts_hash`, compare with the sha256 of `stringify(facts)` (the same hash `compactFacts` writes). The facts the rule saw are built by code in a fixed key order, so YAML text equality is stable. Because `difficulty` facts include the `tags` outcome, a changed `tags` answer changes `difficulty` facts and forces a new ask.

### D4. Classification returns pending; rule records only
`classifyUnits(units, config, ask?)` computes each unit's digest from the rendered unit before deciding (Difficulty/Tags do not affect it), passes `{ config, subject, digest, ask }`, and returns either `{ status: "classified", units, records }` or `{ status: "pending", point, subject, requestId }` at the first pending decision; the tool refusal joins `<point>.<subject>`. `records` holds only `source: rule` decisions; human decisions are already on the issue (written by `applyDecide` in session, or by `/livespec choose`). The digest is computed once from the input with placeholder classification and reused for both points, since classification does not affect it.

A human `tags` outcome that is not a string array refuses the classification ("tags decision … is not a list of tags"), instead of casting it. No built-in `tags` rule asks yet; the first one defines its options.

### D4a. Stable id for an added unit across an ask
`historyUnitIds` (`src/tools/unit-amend.ts`) counts every decision subject as a taken id, so the human record of `--add`'s ask would push the rerun to the next id and the answer would never be reused. A decision record that carries `request` is the answer of a rule ask (gate overrides and amendment records strip `request`, see `complete-amend.ts`), so `historyUnitIds` skips those. A unit that really existed stays reserved by the body, its `amendment` comment or the locked digests. Alternative: allocate the id once and store it in the `decide:` request — rejected, it couples request ids to amendment state.

### D5. Tool behaviour on pending
- `plan_units`: `classifyPlan` maps pending to a refusal `plan_units refused: decision <point>.<subject> waits for a human answer (request <id>); nothing was merged or written. Rerun plan_units after it is answered.` Classification runs before the merge, so nothing is written.
- `unit_amend`: `contractSnapshot` maps pending to `unit_amend refused: decision … waits for a human answer (request <id>); no amendment request was sent.` The `decide:` request itself was sent by the asker and is the one reported.
- `plan_units` gains the tool `ctx` in `execute` (as `unit_amend` already has) to build the asker.
- The existing blocking-request refusal (`decide:` is always blocking) still runs first on reruns while the request is open.

### D6. In-session answers mid-run
An in-session answer posts the request's answer and human record during classification. If a later step refuses (validation, merge conflict), those comments stay; the rerun reuses the answer. This matches the "Decision records" requirement that every decision is recorded. The spec scopes "writing nothing" to the plan's effects (merge, rule records, `## Units`, `Base`, `livespecBase`) for this reason.

## Risks / Trade-offs

- [Facts change whenever pack config changes the facts] → the human is asked again; accepted, strict reuse is the agreed rule.
- [YAML stringify key order differs between the record and recomputed facts] → facts objects are built by code in fixed order; a unit test pins equality after a forge round-trip.
- [A stale `tags` human answer for an old digest] → ignored by digest match, as `currentDecision` already does.
- [Comments written by an in-session answer before a later refusal] → intended (D6); they are valid decision records.

## Migration Plan

None: records without `digest` from earlier human asks stay ignored by `currentDecision`; no built-in rule asked before this change.

## Open Questions

None.
