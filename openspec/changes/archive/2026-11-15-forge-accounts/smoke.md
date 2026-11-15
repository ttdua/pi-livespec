# Manual smoke: account chosen per clone in a real pi session

Task 6 Step 2. Run on 2026-11-15, pi 1.5.2 on macOS, model `9router/gpt-6-luna`, livespec from branch `forge-accounts`.

## Setup

- **Clone:** a fresh scratch clone of `ttdua/pi-livespec` (origin `https://github.com/ttdua/pi-livespec.git`), with an empty `.pi/livespec/config.yaml`, so the project is initialized.
- **gh config:** a scratch copy of the gh config in `GH_CONFIG_DIR`, where the active `github.com` account was switched to `naicoi92`. The real gh config was not changed: its active account stayed `ttdua` throughout.
- **Tokens:** `GH_TOKEN`, `GH_ENTERPRISE_TOKEN` and `GITEA_TOKEN` were unset. Both accounts' tokens live in the macOS keychain. The scratch `HOME` links `~/Library/Keychains` so `gh auth token --user` can read them; without that link the tokens were unreadable and every candidate came back `unknown`.
- **pi home:** a scratch `PI_CODING_AGENT_DIR` with `defaultProjectTrust: "always"`. Extensions were loaded with `-e`: `pi-9router-ext`, and livespec through a small wrapper that also logs the session state at `before_agent_start`. The wrapper imports the same module instance as livespec, so it sees the real session.

## Results

| Step | Observation |
|---|---|
| Before | `git config --local --get livespec.account` was empty; scratch active gh account `naicoi92` |
| Session 1 (`Reply OK.`) | After the session: `livespec.account = ttdua`, `livespec.accountRemote = github.com/ttdua/pi-livespec` |
| Session 2 (`/livespec account`) | Output: `Account: ttdua`, `Source: stored`; candidates `naicoi92` (not checked: the stored account can push) and `ttdua` (access true, in use) |
| Session 3 (logged by the wrapper at `before_agent_start`) | `{"source":"stored","account":"ttdua","block":null,"forge":true,"whoami":"ttdua"}`: the session forge calls GitHub as `ttdua` while `naicoi92` is the active account in that gh config |
| After | Scratch active account still `naicoi92`; the real gh active account still `ttdua`. livespec never ran `gh auth switch` |

Session 1 showed source `automatic` through its notice, which JSON mode does not print. Session 2 reports `stored`, which is correct on every later run.

Direct check of the access probe in the same setup:
- `ttdua`: token found, access `true`, 614 ms.
- `naicoi92`: token found, access `false`, 622 ms.

## Verdict

**Pass.** livespec chose `ttdua`, the only account that can push, stored it in the clone's local git config, and used its token while another account was active. It changed no machine-wide state.

Observation: when `gh` cannot read its keyring (here, a scratch `HOME` without the keychain link), every candidate is `unknown` and writes are refused with the "log in" guidance. That is the specified fail-closed behaviour.
