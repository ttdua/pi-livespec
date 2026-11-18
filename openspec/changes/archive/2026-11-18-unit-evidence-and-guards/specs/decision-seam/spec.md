## ADDED Requirements

### Requirement: Progress rule
The `progress` rule SHALL be registered with `registerRule` and configured as `decisions.progress: { mode: rule }`. Its facts SHALL be built by code from the failed `Verify` run that `unit_finish` captured, never from the agent:
- the attempt number and the cap;
- the failure signature;
- the previous signature in the current attempt budget, when one exists.

The signature SHALL hold two parts:
- the sorted, deduplicated failing test names that can be read from the output (vitest and jest `FAIL`, `go test` `--- FAIL:`, pytest `FAILED`, TAP `not ok`);
- a sha256 hash of the output after ANSI codes, hex runs of seven or more characters, absolute paths, timestamps, durations and other digit runs are normalized and whitespace is collapsed.

The rule MUST return outcome `stop` when either the previous signature equals the current one or the attempt number reached the cap, and `retry` otherwise. It MUST NOT ask a human. Each outcome SHALL be posted as a decision record `progress.U<n>` with the unit digest, and the record SHALL keep the signature and the attempt number readable even when its facts are replaced by `facts_hash`.

#### Scenario: Two identical failures stop early
- **WHEN** U1's first and second post runs fail with the same failing test names and the same normalized output, differing only in timings and temporary paths
- **THEN** the second `progress.U1` record has outcome `stop`, U1 is blocked with reason `progress`, and the attempt count is 2 of 3

#### Scenario: Different failures retry
- **WHEN** U1's first post run fails test `a` and the second fails test `b`
- **THEN** the second `progress.U1` record has outcome `retry`

#### Scenario: Cap with different failures
- **WHEN** the cap is 3 and U1's third failed run has a signature different from the second
- **THEN** the third `progress.U1` record has outcome `stop` and its reason names the cap

#### Scenario: Unrecognized output
- **WHEN** a failed run prints no recognizable test name
- **THEN** the signature has no test names and its hash alone decides equality

#### Scenario: Large output keeps the signature
- **WHEN** a failed run's facts exceed 2,000 characters of yaml
- **THEN** the record holds `facts_hash`, and the next attempt's rule still reads the previous signature
