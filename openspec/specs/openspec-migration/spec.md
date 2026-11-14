# openspec-migration Specification

## Purpose

Defines `/livespec migrate-openspec`, which moves only the `openspec/specs/<capability>/spec.md` files into `specs/` with `git mv`, leaving content and every other file untouched.

## Requirements

### Requirement: Migrate OpenSpec specs
`/livespec migrate-openspec` SHALL move only the file `openspec/specs/<cap>/spec.md` of each capability to `specs/<cap>/spec.md` with `git mv`, and SHALL NOT change file content. It SHALL NOT move or copy any other file or directory under `openspec/` (including `openspec/specs/README.md`, `.gitkeep`, other files inside a capability folder, `openspec/changes/`, `openspec/config.yaml` and `openspec/schemas/`).

#### Scenario: Specs moved
- **WHEN** `openspec/specs/a/spec.md` and `openspec/specs/b/spec.md` exist and `specs/` does not
- **THEN** both files exist under `specs/` with identical bytes, and git records them as renames

#### Scenario: Only spec files are moved
- **WHEN** `openspec/specs/a/` also contains `notes.md`, and `openspec/specs/README.md`, `openspec/config.yaml` and `openspec/changes/x/proposal.md` exist
- **THEN** only `specs/a/spec.md` is created, and `notes.md`, `README.md`, `config.yaml` and `proposal.md` stay where they were

#### Scenario: Directories without spec files
- **WHEN** `openspec/specs/` contains a folder with no `spec.md`
- **THEN** it is left in place and nothing is created for it under `specs/`

### Requirement: Refuse on conflict
The command SHALL refuse, before moving any file, when any target `specs/<cap>/spec.md` already exists, and SHALL change nothing.

#### Scenario: Target exists
- **WHEN** `specs/a/spec.md` already exists and `openspec/specs/a/spec.md` is to be moved
- **THEN** the command reports the conflict and no file is moved, including other capabilities

#### Scenario: Nothing to migrate
- **WHEN** `openspec/specs/` has no capabilities
- **THEN** the command reports that and changes nothing

### Requirement: Migrated specs validate
After migration, `/livespec validate` SHALL accept the moved files by the same rules as any other living spec.

#### Scenario: Migrate then validate
- **WHEN** only the `spec.md` files of pi-superspec's `openspec/specs` are migrated and validated
- **THEN** validation reports no errors, and any warnings are listed in the change's verify record
