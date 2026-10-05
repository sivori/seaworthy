## Now
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
