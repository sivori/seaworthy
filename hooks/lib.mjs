// Shared by the push hooks: read the hook input, resolve which Xcode Cloud
// workflows a `git push` starts. Every failure path returns nothing: a hook
// that errors or stalls on a push gets uninstalled, so silence beats noise.

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { resolveCreds, ascClient } from '../lib/asc.mjs';
import { loadCiIndex, matchPush } from '../lib/ci.mjs';
import { parsePushCommands, destinationBranch, sourceRef } from '../lib/git.mjs';

export async function readInput() {
  let s = '';
  for await (const chunk of process.stdin) s += chunk;
  return JSON.parse(s);
}

const git = (dir, ...args) => {
  try {
    return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
  } catch {
    return '';
  }
};

/**
 * For a Bash command, the pushes in it that start Xcode Cloud workflows.
 * @returns {Promise<{ api, pushes: { dir, branch, sha, hits }[] } | null>}
 */
export async function resolvePushes(command, cwd, { timeoutMs }) {
  if (!/\bgit\b/.test(command) || !/\bpush\b/.test(command)) return null;
  const parsed = parsePushCommands(command);
  if (!parsed.length) return null;
  const creds = resolveCreds();
  if (creds.error) return null;
  const api = ascClient(creds, { timeoutMs });
  let index;
  try {
    index = await loadCiIndex(api);
  } catch {
    return null;
  }
  const pushes = [];
  for (const p of parsed) {
    const dir = p.dir ? resolve(cwd, p.dir) : cwd;
    const current = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');
    // The current branch's upstream, e.g. "origin/master" → "origin".
    const upstream = git(dir, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}');
    const remote = p.remote || upstream.split('/')[0] || 'origin';
    const url = /[:@/]/.test(remote) ? remote : git(dir, 'remote', 'get-url', remote);
    if (!url) continue;
    const refspecs = p.refspecs.length ? p.refspecs : [undefined];
    for (const rs of refspecs) {
      const branch = destinationBranch(rs, current);
      if (!branch) continue;
      const hits = matchPush(index, url, branch);
      if (hits.length) pushes.push({ dir, branch, sha: git(dir, 'rev-parse', sourceRef(rs)), hits });
    }
  }
  return { api, pushes };
}

// Fixed names, not computed ones: each switch is one boolean plugin setting.
export const settings = {
  pushWarning: process.env.CLAUDE_PLUGIN_OPTION_PUSH_WARNING !== 'false',
  buildWatch: process.env.CLAUDE_PLUGIN_OPTION_BUILD_WATCH !== 'false',
};
