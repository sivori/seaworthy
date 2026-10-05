---
name: shipping
description: Release know-how for iOS, tvOS, watchOS and macOS apps built with Xcode Cloud and shipped through TestFlight and App Store Connect. Use when pushing to a branch that triggers Xcode Cloud, when a build failed or never started, when uploading to TestFlight, when preparing, submitting or resubmitting an App Store version, or when App Review rejected a build.
---

# Shipping with Xcode Cloud and App Store Connect

The seaworthy MCP tools do the work; this is what to know while using them.

## The tools, by tier

| Tier | Tools | Rule |
|---|---|---|
| Read | `list_apps`, `ci_status`, `triage_run`, `find_run_for_commit`, `check_release`, `review_status` | Use freely. |
| Draft | `create_version`, `update_version` | Reversible in App Store Connect. Say what you changed. |
| Irreversible | `start_build`, `submit_for_review` | The first call returns a plan and a `confirm` token. Show the user the plan, get an explicit yes, then call again with the token. Never pass a token the user has not approved, and never reuse one from an earlier plan. |

## Pushes are releases

- If a workflow's start condition matches a branch, **every push to that branch builds**, and an archive action with TestFlight distribution **ships that build to testers**. A docs-only commit ships too. The pre-push hook names the workflows; treat its line as "this push is a release".
- **A push can silently fail to start a build.** GitHub's webhook to Xcode Cloud occasionally never arrives: the workflow is fine and nothing runs. The post-push watcher reports it after 4 minutes. The fix is `start_build` on the branch, which needs the user's confirmation.
- Workflows with a files-and-folders rule skip commits that touch nothing matched. That is not a missed webhook.
- `autoCancel` cancels a running build when a newer push arrives. A CANCELED run right before a newer one is expected.

## Build numbers and versions

- Xcode Cloud sets the build number itself (`CI_BUILD_NUMBER`), increasing per product. Bumping `CURRENT_PROJECT_VERSION` locally does nothing for Xcode Cloud builds, and a manual upload must use a number above the last Xcode Cloud build.
- **Once a marketing version is approved, its train is closed.** TestFlight rejects new builds on it (altool 409: "train version X is closed for new build submissions"). Bump `MARKETING_VERSION`, not just the build number. `check_release` and `review_status` suggest the next version.
- The App Store version string must equal the build's `CFBundleShortVersionString`, or the build won't appear for that version.
- xcodegen projects: set `CFBundleShortVersionString: $(MARKETING_VERSION)` and `CFBundleVersion: $(CURRENT_PROJECT_VERSION)` in `info.properties`. xcodegen regenerates the Info.plists from it on every run, so edits made to the plist directly are lost.
- App extensions must match the host app's version and build, and a 64-bit appex needs `UIRequiredDeviceCapabilities: [arm64]` too, or export validation fails.

## TestFlight

- "What to Test" can live in the repo: Xcode Cloud reads `TestFlight/WhatToTest.<locale>.txt` next to the project (one file per locale) and applies it to the build. Edit it in the same commit as the change.
- Distribution is set on the workflow's archive action. Builds marked "TestFlight (Internal Testing Only)" can never be submitted to the App Store. The fix is in the Xcode Cloud workflow editor (Archive → Deployment Preparation → TestFlight and App Store), because **the API cannot change it**, followed by a new build.
- Builds expire after 90 days.
- An internal TestFlight group receives new builds automatically only when the group has automatic distribution turned on. Otherwise someone adds each build to it by hand.

## Export compliance

Every build needs an encryption answer before it can be tested externally or submitted. Set `ITSAppUsesNonExemptEncryption` (usually `NO`) in every target's Info.plist so it never has to be answered by hand. tvOS and watch targets are commonly missing it even when the iOS target has it.

## Submitting for review

`check_release` lists everything still blocking. The usual blockers, all fixed in App Store Connect or with `update_version`:

- **Copyright** empty: the submission 409s without it.
- **What's New** empty on any locale (not required on an app's first version).
- **Description, keywords, support URL** missing on a locale.
- **Screenshots**: at least one set per locale, and one for every device family the binary supports. iPad support means iPad screenshots. The API can't tell which families the binary supports, so ask the user if unsure.
- **App Review contact**: first name, last name, phone, email.
- **App Privacy** answers: not visible through the API, so remind the user to check.

The submission itself is three calls: create or reuse a review submission → add the version as an item → mark it submitted. `submit_for_review` does this and handles the cases below.

- **Resubmitting after a rejection:** attaching a new build to the rejected version moves it back to PREPARE_FOR_SUBMISSION, but adding it to a submission 409s ("appStoreVersion not in valid state") while the old submission still sits in UNRESOLVED_ISSUES. Cancel that one first; `submit_for_review` plans this automatically.
- A submission in READY_FOR_REVIEW is the reusable draft. It can't be canceled or deleted, and doesn't need to be.
- Relationship-write 409s hide the real reason in `meta.associatedErrors`; the tools print it.
- `releaseType` AFTER_APPROVAL means the app goes live the moment review approves it. Make sure the user wants that; MANUAL holds it for a release button.

## Common rejections

- **2.1 App Completeness, "loaded indefinitely" or a blank first screen:** review runs on a restricted network. If the first screen waits on the network, a reviewer sees a spinner forever. Render something real from bundled data before any network call, and let live data fill in after.
- **2.1 demo account:** if any feature sits behind sign-in, review needs working demo credentials in the App Review details.
- **5.1.1 / 5.1.2 privacy:** purpose strings must say why the app uses each permission. Data collected must match the App Privacy answers, and data sent to third-party AI services needs disclosure and consent.
- **4.2 minimum functionality:** a thin wrapper around a website or a single static screen. Point at the native features in the review notes.
- **Guideline 2.3 metadata:** screenshots must show the actual app, and the description must not promise features that aren't there.

Reply in the Resolution Center when the reviewer misunderstood. Fix and resubmit when they didn't. A reply to a rejection the fix would address only costs a round trip.

## When a build fails

Run `triage_run` (add `log_excerpt: true` when the errors list is empty, since script failures in `ci_scripts/` only show in the logs). Common causes:

- **Signing:** Xcode Cloud manages signing. Failures usually mean a capability was added to the target without being enabled on the App ID, or a new extension's bundle id isn't registered.
- **`ci_scripts/ci_post_clone.sh`** must be executable (`chmod +x`, committed) and is the place to install tools (`brew install xcodegen && xcodegen`). Scripts run from `ci_scripts/`, so use `$CI_PRIMARY_REPOSITORY_PATH` for repo paths.
- **Package resolution:** a `Package.resolved` that is out of date or not committed fails with "could not resolve package dependencies". Commit the resolved file.
- **Simulator runtimes for tests:** a scheme that embeds a watch app needs the watchOS runtime even for an iOS test action. Pick the test destination explicitly.
- **Xcode version:** "Latest release" moves under you. Pin a version on the workflow when a build breaks right after an Xcode release.
