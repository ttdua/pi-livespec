## 1. Lenient target parameters with warnings

Blocked by: none

- [ ] 1.1 Normalise `""` to omitted for `unit`, `subject` and `finding` in `checkTarget` (`src/tools/subagent-target.ts`)
- [ ] 1.2 Ignore a `subject` for non-reviewers and a `finding` for non-verifiers without validating it, and return one warning per ignored parameter
- [ ] 1.3 Prepend the warnings to the results of `subagent_dispatch`, `subagent_packet` and `subagent_record`
- [ ] 1.4 State the role/parameter matrix in `TARGET_PROPERTIES` and the three tool descriptions
- [ ] 1.5 Update the refusal tests and add tests for every spec scenario in `tests/tools/subagent-dispatch.test.ts` and `tests/tools/subagent-record.test.ts`
- [ ] 1.6 Update `docs/architecture.md` (dispatch section) and `CHANGELOG.md` (Unreleased → Changed)
