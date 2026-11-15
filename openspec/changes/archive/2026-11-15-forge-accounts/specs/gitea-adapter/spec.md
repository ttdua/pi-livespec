## MODIFIED Requirements

### Requirement: Gitea transport and auth
The Gitea adapter SHALL call `/api/v1` with Node's built-in `fetch` and a token, and MUST NOT run `tea`. The token MUST come from `GITEA_TOKEN`; otherwise from the `tea` config login whose name the adapter was given, which MUST also have a URL host equal to the server's; otherwise from the single `tea` login whose URL host matches the server. When several `tea` logins match the host and no login name was given, the adapter MUST throw `ForgeError` with code `auth` naming those logins, and MUST NOT pick one by file order.

#### Scenario: Token from environment
- **WHEN** `GITEA_TOKEN` is set
- **THEN** requests carry it in the authorization header

#### Scenario: Token from tea config
- **WHEN** `GITEA_TOKEN` is unset, no login name is given, and the `tea` config has exactly one login for the host
- **THEN** that login's token is used and no process is spawned

#### Scenario: Named login
- **WHEN** `GITEA_TOKEN` is unset, the `tea` config has logins `gitea.example.org` and `gitea-admin` for the host, and the adapter is given the login name `gitea.example.org`
- **THEN** requests carry the token of `gitea.example.org`

#### Scenario: Ambiguous logins
- **WHEN** `GITEA_TOKEN` is unset, two `tea` logins match the host, and no login name is given
- **THEN** the adapter throws `ForgeError` with code `auth` whose message names both logins, and no request is sent

#### Scenario: Named login missing
- **WHEN** `GITEA_TOKEN` is unset and the given login name is not in the `tea` config
- **THEN** the adapter throws `ForgeError` with code `auth` naming the missing login

#### Scenario: Named login for another host
- **WHEN** `GITEA_TOKEN` is unset and the given login exists but its URL host is not the server's host
- **THEN** the adapter throws `ForgeError` with code `auth` before any request is sent

#### Scenario: No token
- **WHEN** no token is found
- **THEN** the adapter throws `ForgeError` with code `auth`
