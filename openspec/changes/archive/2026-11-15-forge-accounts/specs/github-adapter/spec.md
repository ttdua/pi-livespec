## MODIFIED Requirements

### Requirement: GitHub transport and auth
The GitHub adapter SHALL call the forge only through `gh api` with JSON output, and its authentication check MUST use `gh auth status`. When the adapter is given an account token, every `gh` call it makes (`api` and `auth status`) MUST run with that token in the environment of that call only, in the variable `gh` reads for the host (`GH_TOKEN` for `github.com` and `*.ghe.com`, `GH_ENTERPRISE_TOKEN` for a GitHub Enterprise Server host), so the account that is active machine-wide in `gh` does not decide its identity. The adapter MUST NOT run `gh auth switch` and MUST NOT pass a token on the command line.

#### Scenario: Not logged in
- **WHEN** `gh auth status` fails
- **THEN** the adapter throws `ForgeError` with code `auth`

#### Scenario: Identity
- **WHEN** `whoami()` is called
- **THEN** it returns the login reported by `gh api user`

#### Scenario: Account token used
- **WHEN** the adapter is built for `github.com` with the token of account `ttdua` while `naicoi92` is the active `gh` account
- **THEN** every `gh` call it makes carries `GH_TOKEN` equal to that token and `whoami()` returns `ttdua`

#### Scenario: Enterprise host token
- **WHEN** the adapter is built for the Enterprise host `ghe.example.org` with a token
- **THEN** every `gh` call carries `GH_ENTERPRISE_TOKEN` equal to that token and `--hostname ghe.example.org`

#### Scenario: Token not in arguments
- **WHEN** the adapter is built with a token and makes any call
- **THEN** no `gh` argument contains the token

#### Scenario: No token given
- **WHEN** the adapter is built without a token
- **THEN** no `GH_TOKEN` is added and the calls behave as before
