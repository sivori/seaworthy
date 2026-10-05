---
name: ship-check
description: Check whether an app is ready to submit to the App Store, and fix what can be fixed. Use when the user runs /ship-check or asks "can I submit", "is it ready for review", "what's blocking the release".
argument-hint: "[app] [version]"
---

# /ship-check

1. Resolve the app from the arguments, or from the current repo: `list_apps`, matched on the repo's bundle id or name. If there are several and nothing matches, ask.
2. Run `check_release` (pass the version if given).
3. Report as a short list: blockers first, each with its fix, then warnings, then the manual checks.
4. Offer to fix what the tools can:
   - No editable version: `create_version` with the suggested next version (confirm the number with the user).
   - Copyright, release type, What's New: `update_version`. Draft What's New from the commits since the last released version (`git log <last-tag>..HEAD`) in plain user-facing language, show it, and write it only after the user agrees.
   - A newer build than the attached one: offer to attach it via `submit_for_review` with `build_number`.
   Metadata the tools can't write (descriptions, screenshots, review contact, privacy) needs App Store Connect. Say exactly which screen.
5. If everything passes, show the `submit_plan` and ask whether to submit. Then follow the `submit_for_review` confirmation flow: plan → explicit yes → call with `confirm`.

Never submit without an explicit yes in this conversation, even if the user said "ship it" earlier about something else.
