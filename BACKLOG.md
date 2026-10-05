## Now
- [ ] Confirm the harness accepts a 2700 s hook timeout (verified past 4 min; a lower cap would kill a long build watch silently)
- [ ] Submit to the claude.ai directory (claude.ai/directory/manage, repo sivori/seaworthy, root, branch main)

## Next
- [ ] check_release: warn when the attached build is older than the newest valid build for that version
- [ ] triage_run: verify against a real FAILED run (none in the account's retained history at build time; built from documented shapes)
- [ ] Screenshot upload (reserve → chunk upload → PATCH uploaded + md5) for update_version
- [ ] Copy review contact and description from the previous version into a new one
- [ ] Watch review status after submit (poll via asyncRewake, report approval or rejection with the guideline cited)
- [ ] Workflow audit: outdated Xcode images, archives with no distribution, missing ci_scripts
- [ ] Release action: release a PENDING_DEVELOPER_RELEASE version, phased release controls

## Someday
- [ ] Per-repo opt-out for the push warning (.seaworthy.json) @idea
- [ ] Xcode Cloud compute-hours usage, if Apple exposes it @idea

## Done
- [x] 2026-10-05 Renamed shipwright → seaworthy (0.3.0): four directory plugins already used "shipwright" (NAME_CONFUSABLE hold)
- [x] 2026-10-05 Verified the marketplace install end to end with credentials only in plugin settings (ASC_* unset): pre-push warning, decoy push (fetch URL = real repo, pushurl = local bare repo), missed-build rewake after 4 min
- [x] 2026-10-05 Security + privacy pass; published to github.com/sivori/seaworthy (public)
- [x] 2026-10-05 Verified async + asyncRewake in the real harness (turn 4.8 s with a 15 s hook; rewake starts a new turn), PostToolUse tool_response shape, PreToolUse systemMessage
