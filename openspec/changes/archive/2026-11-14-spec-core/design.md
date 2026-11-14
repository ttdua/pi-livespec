## Context

LS-01 left a loadable extension with only `/livespec`. Dependency policy allows `yaml` only. Node is v26 locally; the minimum supported Node is not declared in `package.json`. The brief fixes the formats and rules; this design fixes structure and a few technical choices. The approach (raw-text-preserving parsers) is in `brainstorm.md` and is not repeated.

## Goals / Non-Goals

**Goals:**
- Pure, I/O-free core modules that later specs import.
- Exact round trip and exact one-line tick.
- A thin command layer for `validate` and `migrate-openspec`.

**Non-Goals:**
- Forge access, flow engine, deciding `Difficulty`/`Tags`.
- Fixing pi-superspec's specs; findings are only reported.

## Decisions

- **Layout.** `src/core/{markdown,frontmatter,glob,spec,decision,glossary,bare-work,change,initiative,digest,tick,validate,diff}.ts`; `src/commands/{validate,migrate}.ts`; `src/tools/spec-validate.ts`. Reason: one responsibility per file, and core stays I/O-free.
- **Line model.** A document is an array of lines with their original terminators, so serialization joins the stored lines. Structured views hold line indexes into that array. Reason: exact round trip, unknown sections preserved, tick is one splice. Alternative (AST, re-render) rejected in brainstorm.
- **Front matter.** Split on a leading `---` block and parse its body with `yaml`; the raw block text is kept for serialization.
- **`matchGlob`.** In-house implementation (`*`, `**`, `?`, `{a,b}`, character classes). Reason: `path.matchesGlob` is experimental and the minimum Node version is undeclared. An invalid pattern (unbalanced `[` or `{`) is reported by a separate `validateGlob`.
- **Digest.** `sha256` (node:crypto) over canonical text: fields in the order Covers, Files, Done means, Scenarios, Depends, Verify, Kind; each as `Name:\n` plus normalized lines (LF, trailing whitespace trimmed). Reason: independent of source layout, so re-serialization is stable. `Difficulty`, `Tags` and the status line are excluded.
- **Validation result.** `{ code, severity, file?, section?, line?, message }`. Validators are pure and return arrays; the command layer concatenates them and sets the exit code.
- **Diff input.** `capabilitiesMatchDiff(issue, diffText)` parses `diff --git` headers and `new file` markers for paths under `specs/<cap>/`. Top-level `specs/*.md` and `specs/decisions/` are not capabilities. The command layer runs `git diff <Base>..HEAD -- specs/`. A missing `Base` gives a single "not started" result with severity `warning`.
- **Decision deletion.** `validateDecisionDiff(diffText)` flags a deleted `specs/decisions/*.md` as an error.
- **Command dispatch.** `/livespec <sub>` splits on the first word: empty prints the version, `validate`, `migrate-openspec`, anything else prints usage and changes nothing. Reason: keeps the scaffold contract for bare `/livespec`.
- **Tool schema.** `spec_validate` takes no parameters; its schema is an empty JSON-schema object literal, so no `typebox` dependency is added.
- **Migration.** Check all targets first and refuse before any move; then `git mv` each; create `specs/` parents as needed. Content bytes are untouched because `git mv` renames only.

## Risks / Trade-offs

- [In-house glob has edge-case bugs] → table-driven tests over documented syntax; unsupported syntax is rejected, not guessed.
- [Real-world specs in pi-superspec fail checks] → report as findings and list warnings in the change; do not relax rules.
- [Line model drifts from structured view after edits] → only tick functions edit, and they splice one line; tests assert all other bytes equal.
- [CRLF files] → terminators are stored per line, so round trip holds; the digest normalizes them.

## Migration Plan

No data migration. Rollback is reverting the commit. `/livespec migrate-openspec` is itself reversible with `git mv`.
