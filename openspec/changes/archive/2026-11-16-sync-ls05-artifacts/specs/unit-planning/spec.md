## MODIFIED Requirements

### Requirement: Re-planning after the lock
After the first lock, `plan_units` MUST refuse, and every unit change SHALL go through `unit_amend`. While a lock exists, the plan gate MUST refuse when any unit is frozen or stale. When the plan gate is approved again, its comment SHALL lock the digests of every unit in the body. Status lines of unchanged units MUST be kept.

A unit SHALL stop being stale when, after the `stale` comment that named it, either an amendment for it is approved, even one whose content is identical to the current unit, or a plan gate is approved and not superseded. A unit made stale before the first lock is therefore cleared by the first plan approval.

#### Scenario: Second plan gate re-locks
- **WHEN** after a cascade the stale units are amended and the plan gate is approved again
- **THEN** the new plan `gate` comment locks the digests of every unit in the body

#### Scenario: Plan gate with a stale unit
- **WHEN** a lock exists, U3 is stale, and `spec_gate plan` runs
- **THEN** the tool refuses and names U3

#### Scenario: Stale before the first lock
- **WHEN** in `plan` before any plan gate was approved, an answer's cascade marks U2 stale and moves the change to `define`, and the define and plan gates are then approved
- **THEN** U2 is not stale and the next step does not ask to amend it

#### Scenario: Identical amendment clears a stale unit
- **WHEN** a lock exists, U3 is stale, and an amendment of U3 with unchanged content is approved
- **THEN** U3 is no longer stale
