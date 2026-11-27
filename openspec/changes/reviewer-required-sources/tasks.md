## 1. Optional grouped record sources in reviewer packets

Blocked by: none

- [x] 1.1 Add a `grouped(kind, title, provider)` helper that folds a provider's sources into one optional `records:<kind>` source (text names each record by its own id, untrusted, version = content hash, none when empty) in `src/subagents/sources-records.ts`
- [x] 1.2 Use `grouped` for `decisionRecords` and `dispatchAnswers(true)` in the reviewer manifest `REVIEWER_ALL` in `src/subagents/sources.ts`; leave the implementer manifest unchanged
- [x] 1.3 Tests in `tests/subagents/sources.test.ts`: records do not grow the required list, grouped records keep their ids (and untrusted), implementer answers stay required, a new record changes the grouped version but not the required ids; update the existing untrusted-decision test to the grouped source

## 2. Optional marking in the packet and protocol

Blocked by: 1

- [ ] 2.1 Mark optional sources in `renderSource` and the spilled-source list in `src/subagents/render.ts`
- [ ] 2.2 Update the protocol Result paragraph and bump `PROTOCOL_VERSION` to 2 in `src/subagents/protocol.ts`
- [ ] 2.3 Update the return-to-child message in `src/subagents/dispatch.ts` to ask for every required source
- [ ] 2.4 Tests in `tests/subagents/packet.test.ts` and `tests/subagents/protocol.test.ts`: optional source marked inline and spilled, required source unmarked, protocol explains optional sources

## 3. Finding summary keeps the why

Blocked by: none

- [x] 3.1 Add optional `notes` and `evidence` to `FindingSummaryData` in `src/subagents/records.ts`, accept `notes`/`evidence` in `isSummaryData` in `src/subagents/validate.ts`
- [x] 3.2 Record `notes`, `reason` and `evidence` for every role in `summaryData` in `src/subagents/run-record.ts`
- [x] 3.3 Tests in `tests/subagents/records.test.ts` and `tests/subagents/dispatch.test.ts`: why of a run kept, parent-written block names omitted ids, older summary still valid

## 4. Result handling and #268-shaped review fixture

Blocked by: 1, 2, 3

- [ ] 4.1 Unit tests in `tests/subagents/dispatch.test.ts`: missing optional source accepted without return; blocked reason names omitted required ids
- [ ] 4.2 Harness test in `tests/tools/subagent-dispatch.test.ts` (and an inline `subagent_record` case in `tests/tools/subagent-record.test.ts`): change review round 1 with 29 decision records and 14 parent answers, reviewer lists only the required ids → accepted on first dispatch, `completed: true`, no resume
- [ ] 4.3 Update `docs/architecture.md` (packet sources and `finding-summary` fields) and run the full test suite and typecheck
