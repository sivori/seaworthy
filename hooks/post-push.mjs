#!/usr/bin/env node
// PostToolUse(Bash), async with asyncRewake: after a push that should start
// Xcode Cloud, wait for the build run. Exits 2 (waking Claude with the stderr
// text) when no run appears, which is the webhook that silently never arrived,
// or when the run fails. Stays silent on success.

import { readInput, resolvePushes, enabled } from './lib.mjs';
import { findRunsForCommit } from '../lib/ci.mjs';

// Overridable so the watcher can be exercised in seconds rather than minutes.
const ms = (name, dflt) => Number(process.env[`SHIPWRIGHT_${name}`]) || dflt;
const POLL_MS = ms('POLL_MS', 20_000);
const START_GRACE_MS = ms('START_GRACE_MS', 4 * 60_000);
const MAX_WATCH_MS = ms('MAX_WATCH_MS', 40 * 60_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function failedPush(resp) {
  const text = typeof resp === 'string' ? resp : `${resp?.stdout || ''}\n${resp?.stderr || ''}`;
  return resp?.interrupted || /\[rejected\]|! \[remote rejected\]|^fatal:|^error:|Everything up-to-date/m.test(text);
}

try {
  if (!enabled('BUILD_WATCH')) process.exit(0);
  const input = await readInput();
  if (failedPush(input.tool_response)) process.exit(0);
  const res = await resolvePushes(input.tool_input?.command || '', input.cwd || process.cwd(), { timeoutMs: 15000 });
  const watches = [];
  for (const p of res?.pushes || []) {
    if (!p.sha) continue;
    for (const product of new Map(p.hits.map((h) => [h.product.id, h.product])).values()) {
      const wfs = p.hits.filter((h) => h.product.id === product.id).map((h) => h.workflow);
      watches.push({ product, wfs, sha: p.sha, branch: p.branch });
    }
  }
  if (!watches.length) process.exit(0);

  const started = Date.now();
  const messages = [];
  const pending = new Set(watches);
  while (pending.size && Date.now() - started < MAX_WATCH_MS) {
    await sleep(POLL_MS);
    for (const w of [...pending]) {
      let runs;
      try { runs = await findRunsForCommit(res.api, w.product.id, w.sha); } catch { continue; }
      const short = w.sha.slice(0, 7);
      if (!runs.length) {
        if (Date.now() - started > START_GRACE_MS) {
          const filtered = w.wfs.some((x) => x.branch?.hasFileRule);
          messages.push(`shipwright: no Xcode Cloud build started for ${short} on ${w.branch} (${w.product.name} › ${w.wfs.map((x) => x.name).join(', ')}) ${Math.round(START_GRACE_MS / 60000)} minutes after the push. ${filtered ? 'The workflow has a files-and-folders filter, which may have skipped this commit; otherwise the' : 'The'} GitHub webhook was probably missed. Tell the user, and offer start_build (it asks for confirmation first).`);
          pending.delete(w);
        }
        continue;
      }
      const r = runs[0].attributes;
      if (r.executionProgress !== 'COMPLETE') continue;
      pending.delete(w);
      if (r.completionStatus === 'FAILED' || r.completionStatus === 'ERRORED') {
        messages.push(`shipwright: Xcode Cloud run #${r.number} for ${short} (${w.product.name}) ${r.completionStatus}. Call triage_run with app "${w.product.name}" and run_number ${r.number} to see why, then tell the user.`);
      }
    }
  }
  // Anything still pending here has a run that outlasted the watch window:
  // slow, but not news.
  if (messages.length) {
    process.stderr.write(messages.join('\n'));
    process.exit(2);
  }
} catch (e) {
  // Silent by design; see hooks/lib.mjs.
  if (process.env.SHIPWRIGHT_DEBUG) console.error(e);
}
process.exit(0);
