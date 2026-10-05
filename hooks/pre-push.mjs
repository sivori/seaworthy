#!/usr/bin/env node
// PreToolUse(Bash): before a `git push`, say in one line which Xcode Cloud
// workflows it starts and where their builds go. Never blocks the push.

import { readInput, resolvePushes, settings } from './lib.mjs';
import { execFileSync } from 'node:child_process';
import { describeDistribution } from '../lib/ci.mjs';
import { marketingVersions, APPROVED_STATES, bumpPatch } from '../lib/diagnose.mjs';

/**
 * Versions the pushed commit is stamped with that Apple has already approved.
 * A build on one of those is refused at upload, after the whole archive runs.
 */
async function closedTrains(api, push, hit) {
  const proj = hit.workflow.container;
  if (!proj?.endsWith('.xcodeproj') || !push.sha || !hit.product.appId) return [];
  let pbx;
  try {
    pbx = execFileSync('git', ['-C', push.dir, 'show', `${push.sha}:${proj}/project.pbxproj`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000, maxBuffer: 32 << 20 });
  } catch {
    return [];
  }
  const closed = [];
  for (const v of marketingVersions(pbx)) {
    const r = await api.get(`/v1/apps/${hit.product.appId}/appStoreVersions?filter[versionString]=${encodeURIComponent(v)}&limit=5`);
    const state = r.data[0]?.attributes.appVersionState;
    if (APPROVED_STATES.includes(state)) closed.push({ version: v, state });
  }
  return closed;
}

try {
  if (!settings.pushWarning) process.exit(0);
  const input = await readInput();
  const res = await resolvePushes(input.tool_input?.command || '', input.cwd || process.cwd(), { timeoutMs: 2500 });
  if (!res?.pushes.length) process.exit(0);
  const parts = res.pushes.flatMap((p) => p.hits.map((h) => `${h.product.name} › ${h.workflow.name} (${describeDistribution(h.workflow)})`));
  const line = `This push to ${[...new Set(res.pushes.map((p) => p.branch))].join(', ')} starts Xcode Cloud: ${[...new Set(parts)].join('; ')}.`;

  // Best effort inside the hook's few seconds: a slow check stays silent.
  const closed = [];
  for (const p of res.pushes) {
    for (const h of p.hits.filter((x) => x.workflow.actions.some((a) => a.type === 'ARCHIVE'))) {
      try { closed.push(...(await closedTrains(res.api, p, h))); } catch { /* skip */ }
    }
  }
  const out = {
    systemMessage: `⛵ ${line}`,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: `${line} If any archive ships to TestFlight, this push is a release: make sure the user meant to ship it. seaworthy watches for the build after the push.`,
    },
  };
  if (closed.length) {
    const c = closed[0];
    const why = `This build will fail at upload: version ${c.version} is already approved (${c.state}), so TestFlight takes no more builds on it. Bump MARKETING_VERSION to ${bumpPatch(c.version)} first.`;
    out.systemMessage += `\n⚠️ ${why}`;
    // Ask rather than block: the user may want the push for other reasons.
    out.hookSpecificOutput.permissionDecision = 'ask';
    out.hookSpecificOutput.permissionDecisionReason = why;
    out.hookSpecificOutput.additionalContext += ` ${why} Offer to bump the version and commit before pushing.`;
  }
  process.stdout.write(JSON.stringify(out));
} catch (e) {
  // Silent by design; see hooks/lib.mjs.
  if (process.env.SEAWORTHY_DEBUG) console.error(e);
}
process.exit(0);
