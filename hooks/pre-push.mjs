#!/usr/bin/env node
// PreToolUse(Bash): before a `git push`, say in one line which Xcode Cloud
// workflows it starts and where their builds go. Never blocks the push.

import { readInput, resolvePushes, settings } from './lib.mjs';
import { describeDistribution } from '../lib/ci.mjs';

try {
  if (!settings.pushWarning) process.exit(0);
  const input = await readInput();
  const res = await resolvePushes(input.tool_input?.command || '', input.cwd || process.cwd(), { timeoutMs: 2500 });
  if (!res?.pushes.length) process.exit(0);
  const parts = res.pushes.flatMap((p) => p.hits.map((h) => `${h.product.name} › ${h.workflow.name} (${describeDistribution(h.workflow)})`));
  const line = `This push to ${[...new Set(res.pushes.map((p) => p.branch))].join(', ')} starts Xcode Cloud: ${[...new Set(parts)].join('; ')}.`;
  process.stdout.write(JSON.stringify({
    systemMessage: `⛵ ${line}`,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: `${line} If any archive ships to TestFlight, this push is a release: make sure the user meant to ship it. seaworthy watches for the build after the push.`,
    },
  }));
} catch (e) {
  // Silent by design; see hooks/lib.mjs.
  if (process.env.SEAWORTHY_DEBUG) console.error(e);
}
process.exit(0);
