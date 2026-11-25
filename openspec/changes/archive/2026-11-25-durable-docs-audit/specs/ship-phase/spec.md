## MODIFIED Requirements

### Requirement: Durable docs rule and check
The `durable-docs` decision point SHALL be registered with `registerRule`, configured as `decisions.durable-docs: { mode: rule }`, and MUST NOT ask. From facts built by code (the change diff's files, the `Capabilities` line, each living spec's capability and `paths`, the table rows, and for each capability the latest `behavior-change` record of the change issue with source `human`, if any) it SHALL return errors and confirmation items:
- a `new` capability and no `updated` row for `specs/product.md`: error;
- `specs/constraints.md` changed and no file added under `specs/decisions/` in the diff: error; with one, a confirmation item naming both files;
- a changed file matching a capability's `paths` and no `updated` row for `specs/<capability>/spec.md`: a confirmation item naming the capability and the files, unless that capability's latest human `behavior-change` record has outcome `unchanged` and its `files` field includes every one of those files (a superset counts, since the ship diff and the define diff may start from different commits), in which case no item; an older record never counts when a newer one exists;
- a changed file under `specs/` other than `specs/decisions/` with no row, an `updated` row not in the diff, or a `not needed` row a hard requirement covers: error.

The check `durable-docs` of the `ship` phase SHALL report each error with severity `error` and each confirmation item with severity `warning`; it is not waivable. The ship gate payload SHALL hold a "Needs your confirmation" section with every confirmation item, every `not needed` reason verbatim, and each new decision file; approving the ship gate SHALL be the human's confirmation.

#### Scenario: Capability code without a spec row
- **WHEN** `specs/rate-limit/spec.md` lists `paths: [src/limit/**]`, the diff changes `src/limit/cap.ts`, the table marks `specs/rate-limit/spec.md` `not needed — refactor`, and the issue has no `behavior-change` record for `rate-limit`
- **THEN** the check reports a warning, and the ship gate payload asks the human to confirm that `rate-limit` behavior did not change and shows the reason `refactor`

#### Scenario: Behavior answered earlier
- **WHEN** the same diff and table, and the issue has a human `behavior-change` record for `rate-limit` with outcome `unchanged` listing `src/limit/cap.ts`
- **THEN** the check reports no confirmation item for `rate-limit`, and the payload still shows the reason `refactor`

#### Scenario: Record misses a file
- **WHEN** the record lists only `src/limit/cap.ts` and the diff also changes `src/limit/window.ts`
- **THEN** the check reports the confirmation item for `rate-limit` naming both files

#### Scenario: Newer changed record wins
- **WHEN** the issue has an `unchanged` record for `rate-limit` listing `src/limit/cap.ts`, then a newer `changed` record for the same capability
- **THEN** the check reports the confirmation item for `rate-limit`

#### Scenario: Superset record
- **WHEN** the latest `unchanged` record lists `src/limit/cap.ts` and `src/limit/window.ts`, and the ship diff changes only `src/limit/cap.ts` under `rate-limit`
- **THEN** the check reports no confirmation item for `rate-limit`

#### Scenario: Constraints without a decision
- **WHEN** the diff changes `specs/constraints.md` and adds nothing under `specs/decisions/`
- **THEN** the check reports an error and `spec_gate ship` refuses

#### Scenario: Constraints with a decision
- **WHEN** the diff changes `specs/constraints.md` and adds `specs/decisions/0007-cap.md`
- **THEN** the check reports no error with only a `specs/constraints.md` `updated` row, and the ship gate payload lists both files for explicit approval

#### Scenario: Changed durable doc without a row
- **WHEN** the diff changes `specs/glossary.md` and the table has no row for it
- **THEN** the check reports an error naming `specs/glossary.md`
