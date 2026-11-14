## Design Summary

LS-02 (issue #2) adds the pure core every later spec reads and writes: parsers, validators and serializers for the durable `specs/` files and for change and initiative issue bodies, plus the unit digest, byte-preserving ticks, `capabilitiesMatchDiff`, `matchGlob`, `/livespec validate` (with a `spec_validate` tool) and `/livespec migrate-openspec`. Input is text or a git diff of the local repository. There is no forge and no engine.

Existing specified requirements (`package-scaffold`, `host-seam-evidence`) are not altered, with one extension: `package-scaffold` says the `/livespec` command "SHALL perform no other action" than printing the version. This change gives `/livespec` subcommands (`validate`, `migrate-openspec`); bare `/livespec` keeps printing the version. This is stated as a MODIFIED requirement, not a silent re-decision.

Capabilities, split by responsibility so each can be tested alone:

| Capability | Responsibility |
|---|---|
| `spec-formats` | Parse and serialize the living spec, decision, glossary and bare-work files; byte-for-byte round trip; `matchGlob` |
| `change-issue-format` | Parse and serialize the change issue body and initiative body; unit fields; unit digest; `tickUnit`/`untickUnit`/`tickChange`/`untickChange` |
| `spec-validation` | Validators returning `{ code, severity, file/section, line, message }`; `units-format`, `done-maps-scenarios`, `capabilities-match-diff`; `/livespec validate` and `spec_validate` |
| `openspec-migration` | `/livespec migrate-openspec` |

Behavior follows the issue's **Formats** and **Rules** sections exactly; this change does not re-decide any of them.

## Alternatives Considered

### Alternative A: Line-oriented parser that keeps the raw text (chosen)
- **Approach**: Each document is parsed into a model that stores the original source slices for every section and field. Serializing an unmodified model emits the stored slices; edits replace only the affected slice.
- **Pros**: Round trip is exact by construction; unknown sections are preserved for free; tick is a one-line splice.
- **Cons**: Model carries raw text next to structured data.
- **Why not chosen**: Chosen.

### Alternative B: Full Markdown AST (remark/unified)
- **Approach**: Parse to an AST and print back.
- **Pros**: Robust for arbitrary Markdown.
- **Cons**: Needs a new runtime dependency (policy: `yaml` only, maintainer approval otherwise); AST printers normalize bytes, breaking the round-trip rule.
- **Why not chosen**: Violates the dependency policy and the byte-preserving rule.

### Alternative C: Regex extraction with re-render from structured data
- **Approach**: Extract fields with regexes; serialize by re-rendering a template.
- **Pros**: Small.
- **Cons**: Re-rendering changes bytes (whitespace, unknown sections); tick would not be byte-preserving.
- **Why not chosen**: Cannot meet the round-trip rule.

## Agreed Approach

Alternative A, as pure TypeScript modules under `src/core/`, with no I/O in parsers, validators or serializers. I/O (reading `specs/`, running `git diff`, `git mv`) lives in a thin `src/commands/` layer that feeds text to the core. YAML front matter is read with the existing `yaml` dependency; no new dependency is added.

## Key Decisions

- The issue's open question (Durable docs table in the body or a comment) is resolved as the brief states: it stays in the issue body.
- `matchGlob` uses Node's built-in `path.matchesGlob` if `engines.node` allows it, otherwise an in-house implementation; the design artifact settles which after checking the minimum Node version. No dependency is added.
- The unit digest hashes the normalized contract (every field except status line, `Difficulty`, `Tags`) in canonical field order, so re-serializing never changes it.
- `capabilitiesMatchDiff` takes issue text and diff text (pure); the command layer produces `git diff <Base>..HEAD -- specs/`. Without `Base` it reports "not started".
- Migration refuses if any target exists, before moving anything (all-or-nothing check first).
- The "Done when" check on a copy of pi-superspec's `openspec/specs` is run during verify; warnings found there are listed in the change, not fixed in pi-superspec.
- These are assumptions from the brief; you may overturn them at this gate.

## Open Questions

- Does pi-superspec's `openspec/specs` pass the spec checks as is (SHALL/MUST wording, scenarios with WHEN/THEN)? Unknown until the verify run; violations are reported as findings rather than silently relaxed.
