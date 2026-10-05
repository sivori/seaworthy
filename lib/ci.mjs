// Xcode Cloud reads: the product/workflow index, run summaries, triage.

import { mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { normalizeRemote, branchMatches } from './git.mjs';
import { isSignalLine, archiveVersion, diagnosePrepareFailure } from './diagnose.mjs';

export const CACHE_DIR = join(homedir(), '.cache', 'seaworthy');
// Versioned: a cache from an older release lacks fields newer code reads.
const INDEX_FILE = join(CACHE_DIR, 'ci-index-v2.json');
const INDEX_TTL_MS = 60 * 60 * 1000;

/**
 * Every Xcode Cloud product with its repos and workflows, flattened to what
 * the hooks and tools need. Cached for an hour because the pre-push hook runs
 * on every push and must not cost a network round trip each time.
 */
export async function loadCiIndex(api, { fresh = false } = {}) {
  if (!fresh) {
    try {
      const c = JSON.parse(readFileSync(INDEX_FILE, 'utf8'));
      if (Date.now() - c.fetchedAt < INDEX_TTL_MS) return c;
    } catch { /* no cache yet */ }
  }
  const prods = await api.get('/v1/ciProducts?include=app,primaryRepositories&limit=200');
  const byId = new Map((prods.included || []).map((i) => [`${i.type}/${i.id}`, i]));
  const products = [];
  for (const p of prods.data) {
    const repos = (p.relationships.primaryRepositories?.data || [])
      .map((r) => byId.get(`scmRepositories/${r.id}`))
      .filter(Boolean)
      .map((r) => ({ id: r.id, url: r.attributes.httpCloneUrl, key: normalizeRemote(r.attributes.httpCloneUrl) }));
    const app = byId.get(`apps/${p.relationships.app?.data?.id}`);
    const wfs = await api.get(`/v1/ciProducts/${p.id}/workflows?include=repository&limit=200`);
    products.push({
      id: p.id,
      name: p.attributes.name,
      appId: app?.id,
      bundleId: app?.attributes?.bundleId,
      repos,
      workflows: wfs.data.map(summarizeWorkflow),
    });
  }
  const index = { fetchedAt: Date.now(), products };
  try {
    // Lists the account's apps and repos: readable by this user only.
    mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(INDEX_FILE, JSON.stringify(index), { mode: 0o600 });
    // `mode` only applies on creation; tighten files left by earlier versions.
    chmodSync(CACHE_DIR, 0o700);
    chmodSync(INDEX_FILE, 0o600);
  } catch { /* cache is best-effort */ }
  return index;
}

export function summarizeWorkflow(w) {
  const a = w.attributes;
  return {
    id: w.id,
    name: a.name,
    enabled: a.isEnabled,
    container: a.containerFilePath || null,
    repositoryId: w.relationships?.repository?.data?.id,
    branch: a.branchStartCondition
      ? { source: a.branchStartCondition.source, hasFileRule: !!a.branchStartCondition.filesAndFoldersRule }
      : null,
    tag: !!a.tagStartCondition,
    pullRequest: !!a.pullRequestStartCondition,
    scheduled: !!a.scheduledStartCondition,
    actions: (a.actions || []).map((x) => ({
      name: x.name,
      type: x.actionType,
      platform: x.platform,
      audience: x.buildDistributionAudience || null,
    })),
  };
}

/** Human summary of a workflow's triggers, e.g. "push to master". */
export function describeTriggers(wf) {
  const t = [];
  if (wf.branch) {
    const s = wf.branch.source;
    const pats = s?.isAllMatch ? 'any branch' : (s?.patterns || []).map((p) => (p.isPrefix ? `${p.pattern}*` : p.pattern)).join(', ');
    t.push(`push to ${pats}${wf.branch.hasFileRule ? ' (file filter)' : ''}`);
  }
  if (wf.tag) t.push('tags');
  if (wf.pullRequest) t.push('pull requests');
  if (wf.scheduled) t.push('schedule');
  return t.length ? t.join('; ') : 'manual only';
}

/** What a workflow's archive does with the build, in words a person uses. */
export function describeDistribution(wf) {
  const archives = wf.actions.filter((a) => a.type === 'ARCHIVE');
  if (!archives.length) return 'no archive (build/test only)';
  return archives
    .map((a) => `${a.platform} archive → ${a.audience === 'APP_STORE_ELIGIBLE' ? 'TestFlight + App Store' : a.audience === 'INTERNAL_ONLY' ? 'TestFlight internal only' : 'no distribution'}`)
    .join(', ');
}

/** Products and enabled workflows a push of `branch` to `remoteUrl` starts. */
export function matchPush(index, remoteUrl, branch) {
  const key = normalizeRemote(remoteUrl);
  const hits = [];
  for (const p of index.products) {
    const repo = p.repos.find((r) => r.key === key);
    if (!repo) continue;
    for (const wf of p.workflows) {
      if (!wf.enabled || !wf.branch) continue;
      if (wf.repositoryId && wf.repositoryId !== repo.id) continue;
      if (branchMatches(wf.branch.source, branch)) hits.push({ product: p, workflow: wf });
    }
  }
  return hits;
}

export function summarizeRun(r) {
  const a = r.attributes;
  const secs = a.startedDate && a.finishedDate ? Math.round((Date.parse(a.finishedDate) - Date.parse(a.startedDate)) / 1000) : null;
  return {
    id: r.id,
    number: a.number,
    status: a.executionProgress === 'COMPLETE' ? a.completionStatus : a.executionProgress,
    commit: a.sourceCommit ? `${a.sourceCommit.commitSha.slice(0, 7)} ${(a.sourceCommit.message || '').split('\n')[0].slice(0, 72)}` : null,
    commitSha: a.sourceCommit?.commitSha || null,
    created: a.createdDate,
    duration: secs == null ? null : `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, '0')}s`,
    startReason: a.startReason,
    issues: a.issueCounts || undefined,
    pullRequest: a.isPullRequestBuild || undefined,
  };
}

export async function recentRuns(api, productId, limit = 10) {
  const r = await api.get(`/v1/ciProducts/${productId}/buildRuns?sort=-number&limit=${limit}`);
  return r.data;
}

/**
 * Apple can't filter runs by commit (`filter[sourceCommit.commitSha]` is a 400),
 * so scan the newest runs. A push that started a build is always among them.
 */
export async function findRunsForCommit(api, productId, sha, limit = 25) {
  const runs = await recentRuns(api, productId, limit);
  return runs.filter((r) => r.attributes.sourceCommit?.commitSha?.startsWith(sha));
}

/**
 * Everything wrong with one run: per-action status, errors with file:line,
 * failing tests, and the log bundle, optionally grepped for error lines.
 */
export async function triageRun(api, run, { logExcerpt = false, appId } = {}) {
  const actions = await api.get(`/v1/ciBuildRuns/${run.id}/actions?limit=50`);
  // diagnosis first: when present, it's the answer and the rest is evidence.
  const out = { run: summarizeRun(run), diagnosis: undefined, actions: [] };
  for (const act of actions.data) {
    const a = act.attributes;
    const entry = { name: a.name, type: a.actionType, status: a.executionProgress === 'COMPLETE' ? a.completionStatus : a.executionProgress, required: a.isRequiredToPass };
    const failed = a.completionStatus && a.completionStatus !== 'SUCCEEDED';
    if (failed || a.issueCounts?.errors || a.issueCounts?.testFailures) {
      const issues = await api.get(`/v1/ciBuildActions/${act.id}/issues?limit=200`);
      const rank = { ERROR: 0, TEST_FAILURE: 1, ANALYZER_WARNING: 2, WARNING: 3 };
      entry.issues = issues.data
        .map((i) => ({
          type: i.attributes.issueType,
          message: i.attributes.message,
          at: i.attributes.fileSource ? `${i.attributes.fileSource.path}:${i.attributes.fileSource.lineNumber ?? '?'}` : undefined,
          category: i.attributes.category || undefined,
        }))
        .sort((x, y) => (rank[x.type] ?? 9) - (rank[y.type] ?? 9))
        .slice(0, 60);
      if (a.actionType === 'TEST') {
        const tests = await api.get(`/v1/ciBuildActions/${act.id}/testResults?limit=200`);
        entry.failedTests = tests.data
          .filter((t) => t.attributes.status && t.attributes.status !== 'SUCCESS' && t.attributes.status !== 'SKIPPED')
          .slice(0, 40)
          .map((t) => ({
            test: `${t.attributes.className}.${t.attributes.name}`,
            status: t.attributes.status,
            message: t.attributes.message || undefined,
            at: t.attributes.fileSource ? `${t.attributes.fileSource.path}:${t.attributes.fileSource.lineNumber ?? '?'}` : undefined,
            destinations: (t.attributes.destinationTestResults || []).filter((d) => d.status !== 'SUCCESS').map((d) => d.deviceName || d.osVersion).filter(Boolean),
          }));
      }
      const arts = await api.get(`/v1/ciBuildActions/${act.id}/artifacts?limit=50`);
      entry.artifacts = arts.data.map((x) => ({ type: x.attributes.fileType, name: x.attributes.fileName, bytes: x.attributes.fileSize }));
      const log = arts.data.find((x) => x.attributes.fileType === 'LOG_BUNDLE');
      if (logExcerpt && log?.attributes.downloadUrl) entry.logExcerpt = await grepLogBundle(log.attributes.downloadUrl, log.attributes.fileSize);

      // "Preparing build for App Store Connect failed": the archive built and
      // the upload was refused. Name the cause rather than the symptom.
      if (a.actionType === 'ARCHIVE' && entry.issues?.some((i) => i.category === 'PrepareBuildForAppStoreConnect')) {
        const version = archiveVersion(entry.artifacts.map((x) => x.name));
        let versionState = null;
        if (version && appId) {
          try {
            const v = await api.get(`/v1/apps/${appId}/appStoreVersions?filter[versionString]=${encodeURIComponent(version)}&limit=5`);
            versionState = v.data[0]?.attributes.appVersionState || null;
          } catch { /* diagnosis degrades to the generic one */ }
        }
        out.diagnosis = { version, versionState, ...diagnosePrepareFailure({ version, versionState }) };
      }
    }
    out.actions.push(entry);
  }
  return out;
}

const MAX_LOG_BYTES = 200 << 20;

/**
 * Secrets that CI scripts commonly echo into logs. Log lines go to the model,
 * so anything token-shaped is masked before it leaves this function.
 */
export function redactSecrets(line) {
  return line
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+)/g, '[redacted]')
    .replace(/((?:token|secret|password|passwd|api[_-]?key|auth)[\w-]*\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/g, '$1[redacted]@');
}

/** Download a LOG_BUNDLE zip and pull the error lines out of its text logs. */
async function grepLogBundle(url, size) {
  if (!/^https:\/\//.test(url)) return ['(log bundle URL is not https; not downloaded)'];
  if (size > MAX_LOG_BYTES) return [`(log bundle is ${Math.round(size / 1048576)} MB; too large to download here)`];
  const dir = mkdtempSync(join(tmpdir(), 'seaworthy-log-'));
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (Number(r.headers.get('content-length')) > MAX_LOG_BYTES) return ['(log bundle too large to download here)'];
    if (!r.ok) return [`(log download failed: HTTP ${r.status})`];
    writeFileSync(join(dir, 'logs.zip'), Buffer.from(await r.arrayBuffer()));
    execFileSync('unzip', ['-q', '-o', 'logs.zip', '-d', 'x'], { cwd: dir });
    // grep narrows megabytes of logs; isSignalLine then drops Xcode's
    // provisioning chatter, whose ObjC selectors read as "error:".
    const hits = execFileSync('grep', ['-rhiE', '(error:|fatal error|\\*\\* [A-Z]+ FAILED|Command .* failed|exit code [1-9]|ITMS-|closed for new build|previously approved|STATE_ERROR|ENTITY_ERROR)', 'x'], { cwd: dir, maxBuffer: 16 << 20 })
      .toString()
      .split('\n')
      .filter(isSignalLine)
      .map((l) => redactSecrets(l.trim()).slice(0, 400))
      .filter(Boolean);
    return hits.length ? [...new Set(hits)].slice(0, 40) : ['(no error lines in the log bundle beyond Xcode provisioning chatter)'];
  } catch (e) {
    return e.status === 1 ? ['(no error lines found in the log bundle)'] : [`(could not read log bundle: ${e.message.split('\n')[0]})`];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Resolve "Exorcise", a bundle id, an app id or a product id to one product. */
export function findProduct(index, query) {
  if (!query) return index.products.length === 1 ? index.products[0] : null;
  const q = String(query).toLowerCase();
  return (
    index.products.find((p) => p.id === query || p.appId === query || p.bundleId?.toLowerCase() === q || p.name.toLowerCase() === q) ||
    index.products.find((p) => p.name.toLowerCase().includes(q)) ||
    null
  );
}
