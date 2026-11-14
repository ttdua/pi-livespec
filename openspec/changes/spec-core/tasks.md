## 1. Line model, front matter and glob

Blocked by: none

- [x] 1.1 Add `src/core/lines.ts`: split text into lines keeping terminators; join back byte-exact
- [x] 1.2 Add `src/core/frontmatter.ts`: split leading `---` block, parse body with `yaml`, keep raw text
- [x] 1.3 Add `src/core/glob.ts`: `matchGlob` and `validateGlob`, with tests

## 2. Durable file formats

Blocked by: 1

- [x] 2.1 Add `src/core/spec.ts`: parse and serialize living spec (paths, purpose, requirements, scenarios)
- [x] 2.2 Add `src/core/decision.ts`, `glossary.ts`, `bare-work.ts` parsers and serializers
- [x] 2.3 Round-trip tests for each format, including CRLF and unknown sections

## 3. Change and initiative issue bodies

Blocked by: 1

- [x] 3.1 Add `src/core/change.ts`: ownership lines, sections, questions, units, durable docs table
- [x] 3.2 Add `src/core/initiative.ts`: goal, capabilities, changes list
- [x] 3.3 Add `src/core/digest.ts`: `unitDigest`
- [x] 3.4 Add `src/core/tick.ts`: `tickUnit`, `untickUnit`, `tickChange`, `untickChange`
- [x] 3.5 Round-trip, digest and tick tests on the brief's example bodies

## 4. Validators

Blocked by: 2, 3

- [x] 4.1 Add `src/core/result.ts` and `validate-spec.ts` (spec and glossary checks)
- [x] 4.2 Add `validate-decisions.ts` (numbers, superseded, diff deletion)
- [x] 4.3 Add `validate-units.ts` (`units-format`, `done-maps-scenarios`)
- [x] 4.4 Add `capabilities-diff.ts` (`capabilitiesMatchDiff`)
- [x] 4.5 Tests for every check and scenario

## 5. Validate command, tool and dispatch

Blocked by: 4

- [x] 5.1 Add `src/commands/validate.ts`: read `specs/`, run checks, format results, exit status
- [x] 5.2 Add `src/tools/spec-validate.ts` and register it in `src/extension.ts`
- [x] 5.3 Dispatch `/livespec` subcommands in `src/extension.ts`; keep bare command printing the version; usage for unknown
- [x] 5.4 Update `tests/extension.test.ts` and add command tests on temp git repos

## 6. Migrate command

Blocked by: 5

- [x] 6.1 Add `src/commands/migrate.ts`: collect only `openspec/specs/*/spec.md`, pre-check conflicts, `git mv` those files, report; touch nothing else
- [x] 6.2 Tests on temp git repos: move, only spec files moved (other files stay), conflict refusal, nothing to migrate
- [x] 6.3 Copy only the `spec.md` files of pi-superspec's `openspec/specs` into a scratch git repo, run migrate then validate; record warnings in the verify record
