// Pure helpers for reading a `git push` and matching it to Xcode Cloud start
// conditions. No network, no fs: everything here is unit-tested.

/**
 * Pull the pushes out of a shell command. Handles `cd x && git push`,
 * `git -C dir push`, flags, and `src:dst` refspecs. Returns [] for anything
 * that can't send commits to a branch (dry runs, deletes, tag-only pushes).
 * @returns {{ dir?: string, remote?: string, refspecs: string[] }[]}
 */
export function parsePushCommands(command) {
  const out = [];
  // Split on shell separators; quoting inside a push is rare enough to ignore.
  for (const seg of command.split(/&&|\|\||;|\n/)) {
    const toks = seg.trim().split(/\s+/).filter(Boolean);
    const g = toks.indexOf('git');
    if (g === -1) continue;
    let i = g + 1;
    let dir;
    // git's own global options come before the subcommand.
    while (i < toks.length && toks[i].startsWith('-')) {
      if (toks[i] === '-C') { dir = toks[i + 1]; i += 2; continue; }
      if (toks[i] === '-c') { i += 2; continue; }
      i += 1;
    }
    if (toks[i] !== 'push') continue;
    const rest = toks.slice(i + 1);
    const flags = rest.filter((t) => t.startsWith('-'));
    if (flags.some((f) => ['-n', '--dry-run', '-d', '--delete', '--tags', '--help'].includes(f))) continue;
    const valued = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);
    const positional = [];
    for (let j = 0; j < rest.length; j++) {
      if (valued.has(rest[j])) { j++; continue; }
      if (!rest[j].startsWith('-')) positional.push(rest[j]);
    }
    const [remote, ...refspecs] = positional;
    out.push({ dir, remote, refspecs });
  }
  return out;
}

/**
 * The branch a refspec lands on: `a:b` → b, `+a` → a, `HEAD`/none → current.
 * Returns null for tag refs, which branch start conditions never match.
 */
export function destinationBranch(refspec, currentBranch) {
  if (!refspec || refspec === 'HEAD') return currentBranch;
  let r = refspec.replace(/^\+/, '');
  if (r.includes(':')) r = r.split(':')[1];
  if (!r || r === 'HEAD') return currentBranch;
  if (r.startsWith('refs/tags/')) return null;
  return r.replace(/^refs\/heads\//, '');
}

/** The local commit a refspec sends: `a:b` → a, `a` → a, none → HEAD. */
export function sourceRef(refspec) {
  if (!refspec) return 'HEAD';
  const r = refspec.replace(/^\+/, '');
  return (r.includes(':') ? r.split(':')[0] : r) || 'HEAD';
}

/**
 * github.com/Owner/Repo for https, ssh://, and scp-style remotes alike, so a
 * local `git@github.com:o/r.git` matches Apple's `https://github.com/o/r.git`.
 */
export function normalizeRemote(url) {
  if (!url) return '';
  let u = url.trim().replace(/\.git$/, '').replace(/\/$/, '');
  u = u.replace(/^[a-z+]+:\/\//i, '');          // scheme
  u = u.replace(/^[^@/]+@/, '');                // user@
  u = u.replace(/^([^/:]+):(?!\d+\/)/, '$1/'); // scp-style host:path
  u = u.replace(/^([^/:]+):\d+\//, '$1/');     // explicit port
  return u.toLowerCase();
}

/**
 * Does a branch satisfy a workflow's branchStartCondition.source? Apple's shape
 * is `{ isAllMatch, patterns: [{ pattern, isPrefix }] }`; isAllMatch means any
 * branch. Non-prefix patterns may carry `*` wildcards.
 */
export function branchMatches(source, branch) {
  if (!source || !branch) return false;
  if (source.isAllMatch) return true;
  return (source.patterns || []).some(({ pattern, isPrefix }) => {
    if (isPrefix) return branch.startsWith(pattern);
    if (pattern.includes('*')) {
      const re = new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
      return re.test(branch);
    }
    return branch === pattern;
  });
}
