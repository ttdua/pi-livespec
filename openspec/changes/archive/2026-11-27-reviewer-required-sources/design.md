## Context

`placed()` in `src/subagents/source-kit.ts` defaults every source to `required: true`, and no provider overrides it. The reviewer manifest `REVIEWER_ALL` in `src/subagents/sources.ts` includes `decisionRecords` (one `comment:<id>` per `decision` record) and `dispatchAnswers(true)` (one `answer:<agentId>:<n>` per `ANSWERED` dispatch record). `interpret` in `src/subagents/result.ts` returns a result once when a required id is missing from `sources_used`, then blocks with a reason naming the ids; `finish` in `src/subagents/dispatch.ts` records `blockedResult(reason)`, and `summaryData` in `src/subagents/run-record.ts` drops `notes`, `evidence`, and `reason` (except for verifiers). The packet text (`renderSource`, spill list) never shows whether a source is required, and the protocol asks for "every source you used".

Freshness before finish (`finish-freshness.ts`) reads only implementer dispatches, so reviewer source ids do not take part in it.

## Goals / Non-Goals

**Goals:**
- The reviewer required list does not depend on the number of decision records or parent answers.
- Omitting an optional source is never returned or blocked.
- A child can see which sources are optional.
- A `finding-summary` keeps the why of a run.

**Non-Goals:**
- Implementer, verifier, scout, spec- and plan-review manifests.
- Freshness logic, `MISSING_SOURCE_RETURNS`, the respawn loop (#66), the decision ledger (#59).

## Decisions

1. **Grouped id form `records:<kind>`.** `records:decisions` and `records:dispatch-answers`. A new prefix rather than reusing `comment:` because the source is not one comment; `records:` reads as state the plugin keeps. The `SOURCE_ID` regex in `result.ts` already matches `<kind>:<rest>`, so `NEEDS_CONTEXT` naming works.
2. **Grouped text and version.** Text: one block per record, in thread order, headed by its own id (`comment:<commentId>` for a decision, `answer:<agentId>:<n>` for an answer) followed by the record body, so a reviewer can still cite a specific record in findings. The whole source is `untrusted: true`, as today. Version: SHA-256 of that text. No source when the kind has no record.
3. **Providers keep their single-record form for implementers.** `dispatchAnswers(false)` (implementer) stays per-answer and required. Grouping is a reviewer-only provider wrapper: `grouped(kind, title, provider)` runs the existing provider and folds its sources into one `placed(..., required: false)` source. This reuses the existing record readers and keeps one place that knows how a record becomes text.
4. **Optional marking in the packet.** `renderSource` adds a line `optional: list in sources_used only if you used it` after `version:` for an optional source; the spill list appends ` (optional)`. Required sources render as today, so non-reviewer packets change only by the protocol text.
5. **Protocol.** Result paragraph becomes: list by id in `sources_used` every required source; a source marked optional is listed only if you used it. `PROTOCOL_VERSION` 1 → 2 because the text a child relies on changed.
6. **Return message.** `returnToChild` says "omits required sources … submit your result again listing every required source", matching the protocol. `subagent_record`'s refusal already says "required".
7. **Finding summary fields.** `FindingSummaryData` gains optional `notes` and `evidence`; `reason` (already present for verifiers) is recorded for every role. `summaryData` copies them from the result when non-empty; `isSummaryData` accepts them as optional strings. Old records stay valid. Because `blockedResult` sets `notes` and `reason` to the `interpret` reason (`the result still omits required sources: <ids>`), a parent-written BLOCKED summary now names the omitted ids with no change to `blockedResult`.

## Risks / Trade-offs

- [A reviewer may skip a relevant decision because it is optional] → the source is still in the packet and inline unless spilled; the rubric and persona still direct the review. Decisions that are product rules live in `specs/decisions/` files, which stay required.
- [Any new decision or answer changes the grouped version, so the reviewer packet hash changes] → reviewer packets are not freshness-checked; the hash changing per new record is the same as today.
- [Grouped source is large and spills] → spilling is by reverse manifest order; the grouped sources come after the diff, specs, constraints, receipts, issue and answered questions, so those stay inline longer (review comments, checks, persona, rubric and product excerpt still spill first, as today); a spilled optional source is listed with its path.
- [Protocol version bump] → no reader branches on the version; tests pin the new text.

## Migration Plan

No data migration. Existing `finding-summary` comments without the new fields stay valid; new comments carry them. Rollback is a code revert.

## Open Questions

None.
