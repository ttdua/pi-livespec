## ADDED Requirements

### Requirement: Managed clone and lock
The system SHALL keep agent-skills from `https://github.com/addyosmani/agent-skills` under `~/.pi/agent/livespec/agent-skills/`, with each installed commit checked out in `<sha>/`, a `current` link pointing at the active commit, and a `livespec.lock` file recording the source, the commit, the pin, the install history, skipped commits and the last check time. Only the `git` executable SHALL be used to fetch and check out.

#### Scenario: First clone
- **WHEN** no clone exists and the clone is requested
- **THEN** `<sha>/` holds the upstream tree, `current` points at it, and `livespec.lock` records that commit

#### Scenario: Clone fails
- **WHEN** the upstream cannot be fetched
- **THEN** no `current` link is created and the error names the source URL

### Requirement: Skill exposure
On `resources_discover`, the system SHALL return the directories of the skills that the effective pack names in `skills.required`, `skills.optional` and `init.skills`, resolved under the active commit's real path. It MUST return nothing when the project is not initialized, the pack is invalid, or no clone exists. It MUST NOT return `using-agent-skills` or `context-engineering`, even when a pack names them.

#### Scenario: Initialized project
- **WHEN** an initialized project uses the default pack and the clone exists
- **THEN** exactly the pack's skill directories are returned, each ending in `skills/<name>`

#### Scenario: Uninitialized project
- **WHEN** the project has no `.pi/livespec/config.yaml`
- **THEN** no skill path is returned

#### Scenario: Excluded skills
- **WHEN** a project override lists `using-agent-skills` and `context-engineering` in a phase
- **THEN** neither is returned and pack validation reports a warning for each

### Requirement: Upgrade channel
The user config key `agentSkills.channel` SHALL accept `auto`, `notify` or `pinned`, defaulting to `auto`. A pin recorded in the lock MUST act as `pinned`. The decision whether to upgrade SHALL be a pure function of the channel, the lock, the current time, the upstream head and whether work is in progress.

#### Scenario: Default channel
- **WHEN** no user config sets `agentSkills.channel`
- **THEN** the channel is `auto`

#### Scenario: Notify channel
- **WHEN** the channel is `notify` and upstream has a new commit
- **THEN** the user is told a new commit exists and nothing is installed

#### Scenario: Pinned
- **WHEN** the lock has a pin
- **THEN** no automatic upgrade check installs anything

### Requirement: Automatic upgrade
With channel `auto`, at `session_start` and at most once per 24 hours, the system SHALL fetch upstream in the background without delaying the session. A new commit SHALL be checked out into a staging directory and pass the compatibility check before it is installed. On success the system MUST switch `current` atomically, update the lock, and tell the user which pack skills were added, removed or changed.

#### Scenario: Compatible upgrade
- **WHEN** the local upstream gains a commit that changes `skills/interview-me/SKILL.md`
- **THEN** `current` points at the new commit, the lock records it, and the notice lists `interview-me` as changed

#### Scenario: Throttled
- **WHEN** the last check was less than 24 hours ago
- **THEN** no fetch is made at `session_start`

#### Scenario: Not blocking
- **WHEN** the fetch is slow
- **THEN** the `session_start` handler returns before the fetch completes

### Requirement: Failed upgrade keeps the old version
When a commit fails the compatibility check, the system MUST keep the active commit, the pin and the install history unchanged, and SHALL warn the user with the failing items. An automatic check MUST still record the check time.

#### Scenario: Incompatible upgrade
- **WHEN** the new upstream commit removes `skills/interview-me/`
- **THEN** `current` still points at the old commit, the lock's commit, pin and history are unchanged, and the warning names `interview-me`

#### Scenario: Failed check throttles too
- **WHEN** an incompatible upgrade was rejected and a second session starts 1 hour later
- **THEN** no fetch is made

### Requirement: Compatibility check
A commit SHALL be compatible only when every skill the effective pack names has `skills/<name>/SKILL.md` whose front matter parses as a YAML map with a string `name` equal to the directory name and valid under pi's skill name rules (lowercase letters, digits and single hyphens, at most 64 characters) and a string `description` of 1 to 1024 characters, and every persona the pack references exists in `agents/`.

#### Scenario: Malformed front matter
- **WHEN** `skills/idea-refine/SKILL.md` has front matter that is not valid YAML
- **THEN** the check fails and names `idea-refine`

#### Scenario: Description too long
- **WHEN** a pack skill's `description` has 1025 characters
- **THEN** the check fails and names that skill

#### Scenario: Name mismatch
- **WHEN** `skills/interview-me/SKILL.md` declares `name: interview`
- **THEN** the check fails and names `interview-me`

#### Scenario: Missing persona
- **WHEN** a registered sub-schema reports persona `code-reviewer` and `agents/code-reviewer.md` is absent
- **THEN** the check fails and names `code-reviewer`

### Requirement: No upgrade during work in progress
No upgrade MUST be installed while work is in progress, whether automatic or through `update` or `pin`. Until a later spec registers a finer signal, work is in progress when any open change of the project is in phase `build` with at least one pending unit. `rollback` SHALL remain allowed as recovery from a bad commit.

#### Scenario: Build in progress
- **WHEN** an open change is in `build` with a pending unit and upstream has a compatible new commit
- **THEN** nothing is installed and the skip reason is recorded

#### Scenario: Manual update refused in build
- **WHEN** work is in progress and the user runs `/livespec skills update` or `/livespec skills pin <sha>`
- **THEN** the command refuses, names the change in progress, and changes nothing

#### Scenario: Rollback allowed in build
- **WHEN** work is in progress and the user runs `/livespec skills rollback`
- **THEN** the rollback is performed

### Requirement: Skills command
`/livespec skills status` SHALL print the active commit, the pin, the channel, the last check time and the kept commits. `update` SHALL fetch and install immediately after the compatibility check, ignoring the 24-hour limit, and MUST refuse while pinned. `pin <sha>` SHALL install that commit after the compatibility check and record the pin. `unpin` SHALL clear the pin.

#### Scenario: Manual update
- **WHEN** no pin is set, no work is in progress, the last check was 1 hour ago, and upstream has a compatible new commit
- **THEN** `/livespec skills update` installs it

#### Scenario: Unpin
- **WHEN** a pin is set and the user runs `/livespec skills unpin`
- **THEN** the lock has no pin and the active commit is unchanged

#### Scenario: Status
- **WHEN** the user runs `/livespec skills status`
- **THEN** the output shows the active commit, pin, channel, last check time and kept commits

#### Scenario: Pin
- **WHEN** the user runs `/livespec skills pin <older-sha>`
- **THEN** `current` points at that commit, the lock records the pin, and later automatic checks install nothing

#### Scenario: Pin incompatible commit
- **WHEN** the pinned commit fails the compatibility check
- **THEN** the active commit, the pin and the install history are unchanged and the failing items are printed

#### Scenario: Update while pinned
- **WHEN** a pin is set and the user runs `/livespec skills update`
- **THEN** the command refuses and tells the user to unpin first
### Requirement: Skills rollback
`/livespec skills rollback` SHALL switch `current` back to the previous commit in the install history and record the abandoned commit as skipped, so automatic upgrades do not reinstall it while a newer commit can still be installed.

#### Scenario: Rollback
- **WHEN** commit B was installed after A and the user runs `/livespec skills rollback`
- **THEN** `current` points at A and B is recorded as skipped

#### Scenario: Skipped commit not reinstalled
- **WHEN** B is skipped and upstream head is still B
- **THEN** the automatic check installs nothing

