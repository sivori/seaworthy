## Now
- [ ] Verify userConfig → hooks via a real marketplace install (`claude plugin marketplace add ./`): CLAUDE_PLUGIN_OPTION_KEY_ID naming is from docs, untested; if wrong, hooks silently no-op for userConfig-only users
- [ ] Confirm the harness accepts a 2700 s hook timeout (a lower cap would kill the watcher mid-watch, silently)
- [ ] Create the GitHub repo, push, submit to the claude.ai directory

## Next
- [ ] check_release: warn when the attached build is older than the newest valid build for that version
- [ ] triage_run: verify against a real FAILED run (none in the account's retained history at build time; built from documented shapes)
- [ ] Screenshot upload (reserve → chunk upload → PATCH uploaded + md5) for update_version
- [ ] Copy review contact and description from the previous version into a new one
- [ ] Watch review status after submit (poll via asyncRewake, report approval or rejection with the guideline cited)
- [ ] Workflow audit: outdated Xcode images, archives with no distribution, missing ci_scripts
- [ ] Release action: release a PENDING_DEVELOPER_RELEASE version, phased release controls

## Someday
- [ ] Per-repo opt-out for the push warning (.shipwright.json) @idea
- [ ] Xcode Cloud compute-hours usage, if Apple exposes it @idea

## Done
- [x] 2026-10-05 Verified async + asyncRewake in the real harness (turn 4.8 s with a 15 s hook; rewake starts a new turn), PostToolUse tool_response shape, PreToolUse systemMessage
