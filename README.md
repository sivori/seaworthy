# seaworthy

Ship Apple-platform apps from Claude Code with **Xcode Cloud** and **App Store Connect**, using your own API key. Nothing runs on anyone else's Mac, and your key never leaves your machine.

- **Know what a push ships.** Before a `git push`, one line says which Xcode Cloud workflows it starts and where the builds go (TestFlight, App Store).
- **Catch builds that never started.** GitHub's webhook to Xcode Cloud sometimes never arrives. After a push, seaworthy watches for the build run and tells Claude if none appears within 4 minutes, or if the build fails.
- **Triage failures.** Errors with `file:line`, failing tests, and error lines pulled out of the log bundle.
- **Check release readiness.** Version state, build processing and export compliance, App Store eligibility, copyright, per-locale metadata and screenshots, review contact, and leftover rejected submissions. Each blocker comes with its fix.
- **Create versions, edit release notes, submit for review**, including resubmitting after a rejection (cancel the stale submission, attach the new build, reuse the draft).

## Install

```sh
claude plugin marketplace add sivori/seaworthy
claude plugin install seaworthy@seaworthy
```

Then configure it from `/plugin` → seaworthy:

| Setting | |
|---|---|
| `key_id`, `issuer_id` | An App Store Connect API key from Users and Access → Integrations → App Store Connect API. **App Manager** role to create versions and submit; Developer is enough for read-only use. |
| `private_key` | The contents of the `AuthKey_<key_id>.p8` file you downloaded, BEGIN and END lines included. A sensitive setting: Claude Code keeps it in the system keychain. |
| `push_warning`, `build_watch` | The two push hooks; both on by default. |

Requires Node 18+ and nothing else: no `npm install`.

## Tools

| | Tool | |
|---|---|---|
| Read | `list_apps` | Apps in the account and which use Xcode Cloud |
| | `ci_status` | Workflows (what starts them, where builds go) and recent runs |
| | `triage_run` | Why a run failed; `log_excerpt` greps the log bundle |
| | `find_run_for_commit` | Did this commit build? |
| | `check_release` | Blockers, warnings and manual checks for a submission |
| | `review_status` | Versions, open review submissions, next version number |
| Draft | `create_version` | New App Store version; refuses closed trains |
| | `update_version` | Version string, copyright, release type, What's New. Won't overwrite without `overwrite` |
| Irreversible | `start_build` | Start a workflow on a branch |
| | `submit_for_review` | Cancel stale → attach build → submit |

**Irreversible tools ask first.** Called without a token, they change nothing and return the plan plus a `confirm` token. The token is a hash of that plan. Calling again with it rebuilds the plan from live state and runs only if nothing changed, so an approval can't be stretched to cover a different action.

Plus a `shipping` skill (traps: closed trains, missed webhooks, export compliance, rejection patterns) and `/ship-check`.

## Security and privacy

- **Your key stays local.** The private key lives in the system keychain as a sensitive plugin setting. seaworthy reads no key files or other tools' credentials. The key signs short-lived (10-minute) tokens, which are sent only to `api.appstoreconnect.apple.com`. seaworthy has no server, no telemetry and no dependencies.
- **What reaches the model:** app and build metadata, workflow settings, run results, commit subjects, and error and test messages from your builds. The App Review demo-account password is never read into a tool result. Error lines taken from build logs (`log_excerpt`) are passed through a filter that masks token-shaped strings, but it can't catch every secret a script prints, so keep secrets out of CI logs.
- **Confirmation is a guard, not a lock.** The confirm token makes Claude show you the plan before acting, and goes stale if anything changes, but Claude receives the token in the same response. The real boundary is Claude Code's permission prompt. **Don't add `start_build` or `submit_for_review` to your allowed tools.** Build logs and commit messages are untrusted text, and the prompt is what stops an instruction hidden in them.
- **Hooks** run `git` read-only (`rev-parse`, `config`, `remote get-url`) and make App Store Connect GETs. They never modify your repo or your account. A small cache of your Xcode Cloud workflows lives at `~/.cache/seaworthy/` (mode 600).
- **Least privilege:** a Developer-role key covers everything except creating versions and submitting.

## Development

```sh
npm test                              # unit tests, no network
claude --plugin-dir .                 # try it locally
SEAWORTHY_DEBUG=1                    # hooks print errors instead of staying silent
```

## License

MIT
