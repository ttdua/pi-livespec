## MODIFIED Requirements

### Requirement: Discovered dependencies counter
`discovered_deps` SHALL be derived as the number of valid approved `new-dependency` gate results whose choice is `A`, `B`, `C` or `split`; a `counter` ledger entry for it MUST be ignored. The engine SHALL report it with its cap `loops.discovered_deps`. The cap SHALL block when the count is at least the cap and no stuck answer with a chosen option is dated after the latest counted result. While it blocks, `new_dependency` MUST refuse and the next step after a `missing-prerequisite` result SHALL name `spec_stuck`, so the human can send the work back to the initiative's shape.

#### Scenario: Counter shown
- **WHEN** one `new-dependency` gate was approved with choice A
- **THEN** `nextStep` reports `discovered_deps` as 1 of 2

#### Scenario: Cap exceeded
- **WHEN** two `new-dependency` gates were approved with choices A and B, and a third prerequisite is found
- **THEN** `new_dependency` refuses and names `spec_stuck`

#### Scenario: Option D does not count
- **WHEN** the only `new-dependency` result chose D
- **THEN** `discovered_deps` is 0
