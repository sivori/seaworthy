# shipwright

Ship Apple-platform apps from Claude Code with **Xcode Cloud** and **App Store Connect**, using your own API key. Nothing runs on anyone else's Mac, and your key never leaves your machine.

- **Know what a push ships.** Before a `git push`, one line says which Xcode Cloud workflows it starts and where the builds go (TestFlight, App Store).
- **Catch builds that never started.** GitHub's webhook to Xcode Cloud sometimes never arrives. After a push, shipwright watches for the build run and tells Claude if none appears within 4 minutes, or if the build fails.
- **Triage failures.** Errors with `file:line`, failing tests, and error lines pulled out of the log bundle.
- **Check release readiness.** Version state, build processing and export compliance, App Store eligibility, copyright, per-locale metadata and screenshots, review contact, and leftover rejected submissions. Each blocker comes with its fix.
- **Create versions, edit release notes, submit for review**, including resubmitting after a rejection (cancel the stale submission, attach the new build, reuse the draft).

## Install

```sh
claude plugin marketplace add sivori/shipwright
claude plugin install shipwright@shipwright
```

Then configure it from `/plugin` → shipwright:

| Setting | |
|---|---|
| `key_id`, `issuer_id` | An App Store Connect API key from Users and Access → Integrations → App Store Connect API. **App Manager** role to create versions and submit; Developer is enough for read-only use. |
| `key_path` | Optional. Defaults to `~/.appstoreconnect/private_keys/AuthKey_<key_id>.p8`. |
| | Already export `ASC_KEY_ID` / `ASC_ISSUER_ID` / `ASC_KEY_PATH` for other tooling? Leave the settings blank and those are used. |
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

**Irreversible tools ask first, structurally.** Called without a token, they change nothing and return the plan plus a `confirm` token. The token is a hash of that plan. Calling again with it rebuilds the plan from live state and runs only if nothing changed, so an approval can't be stretched to cover a different action.

Plus a `shipping` skill (traps: closed trains, missed webhooks, export compliance, rejection patterns) and `/ship-check`.

## Development

```sh
npm test                              # unit tests, no network
claude --plugin-dir .                 # try it locally
SHIPWRIGHT_DEBUG=1                    # hooks print errors instead of staying silent
```

## License

MIT
