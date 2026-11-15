## MODIFIED Requirements

### Requirement: Forge detection
`detectForge(repoRoot)` SHALL choose an adapter from the `origin` remote and the optional project config. `github.com` or a configured GitHub Enterprise host selects GitHub. Gitea is selected, in this order, by: config `forge: gitea` with a host, or with a web URL; an `origin` host equal to the `ssh_host` of a `tea` login, whose URL is then the web URL; or a successful `/api/v1/version` probe of the `origin` host. The Gitea web URL (`giteaUrl`) MUST be configurable, so a self-hosted server works at any domain. An account passed to detection MUST be handed to the chosen adapter: its token to GitHub, its login name to Gitea.

#### Scenario: GitHub remote
- **WHEN** `origin` points at `github.com`
- **THEN** a GitHub adapter is returned

#### Scenario: Gitea by config
- **WHEN** config sets `forge: gitea` and a host
- **THEN** a Gitea adapter for that host is returned without probing

#### Scenario: Gitea by configured URL
- **WHEN** config sets `forge: gitea` and `giteaUrl: https://gitea.example.org` and `origin` is on `ssh.gitea.example.org`
- **THEN** a Gitea adapter for `https://gitea.example.org` is returned without probing

#### Scenario: Gitea by tea SSH host
- **WHEN** there is no Gitea config, `origin` is `git@ssh.gitea.example.org:acme/shop.git`, and a `tea` login has `ssh_host: ssh.gitea.example.org` and URL `https://gitea.example.org`
- **THEN** a Gitea adapter for `https://gitea.example.org` is returned without probing

#### Scenario: Gitea by probe
- **WHEN** the `origin` host answers `/api/v1/version`
- **THEN** a Gitea adapter is returned

#### Scenario: Unknown host
- **WHEN** the host is neither GitHub nor configured nor answers the probe
- **THEN** detection throws `ForgeError` with code `unsupported`

#### Scenario: Account passed to GitHub
- **WHEN** detection runs for a `github.com` remote with an account carrying a token
- **THEN** the returned GitHub adapter makes its calls with that token

#### Scenario: Account passed to Gitea
- **WHEN** detection runs for a Gitea remote with an account named `gitea.example.org`
- **THEN** the returned Gitea adapter uses that `tea` login
