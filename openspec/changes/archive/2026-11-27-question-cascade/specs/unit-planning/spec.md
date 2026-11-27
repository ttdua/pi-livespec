## MODIFIED Requirements

### Requirement: Re-planning after the lock
After the first lock, `plan_units` MUST refuse, and every unit change SHALL go through `unit_amend`. While a lock exists, the plan gate MUST refuse when any unit is frozen or stale. When the plan gate is approved again, its comment SHALL lock the digests of every unit in the body. Status lines of unchanged units MUST be kept.

A unit SHALL stop being stale when, after the `stale` comment that named it, either an amendment for it is approved, even one whose content is identical to the current unit, or a plan gate is approved and not superseded. A unit made stale before the first lock is therefore cleared by the first plan approval. Every approved plan gate comment SHALL carry the requirement digests that questions-and-stuck "Requirement baseline" defines, and SHALL be the new baseline of the requirement cascade, including one approved again after a missing baseline commit (see questions-and-stuck "Locks without requirement digests").

#### Scenario: Second plan gate re-locks
- **WHEN** after a cascade the stale units are amended and the plan gate is approved again
- **THEN** the new plan `gate` comment locks the digests of every unit in the body and records the requirement digests

#### Scenario: Plan gate with a stale unit
- **WHEN** a lock exists, U3 is stale, and `spec_gate plan` runs
- **THEN** the tool refuses and names U3

#### Scenario: Stale before the first lock
- **WHEN** before any plan gate was approved, an own `stale` comment written before the first lock (for example by an earlier release) names U2, and the define and plan gates are then approved
- **THEN** U2 is not stale and the next step does not ask to amend it

#### Scenario: Re-approval after a missing baseline
- **WHEN** a missing baseline commit moved the change back to `define`, the define gate is approved, no unit is stale or frozen, and the plan gate is approved
- **THEN** the new plan `gate` comment records `requirements` and `requirement_scope`, and that record is the baseline for later requirement cascades

#### Scenario: Identical amendment clears a stale unit
- **WHEN** a lock exists, U3 is stale, and an amendment of U3 with unchanged content is approved
- **THEN** U3 is no longer stale
