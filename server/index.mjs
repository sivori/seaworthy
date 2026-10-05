#!/usr/bin/env node
// seaworthy MCP server: Xcode Cloud + App Store releases over the App Store
// Connect API, with the user's own key. stdio, newline-delimited JSON-RPC,
// no dependencies.
//
// Tools come in three tiers:
//   read          status, triage, readiness: no side effects
//   draft         create a version, edit its fields: reversible in ASC
//   irreversible  start a build, submit for review: need a confirm token
//                 that only the tool's own dry run hands out (lib/confirm.mjs)

import { createInterface } from 'node:readline';
import { resolveCreds, ascClient, describeErrors } from '../lib/asc.mjs';
import { loadCiIndex, findProduct, recentRuns, summarizeRun, findRunsForCommit, triageRun, describeTriggers, describeDistribution } from '../lib/ci.mjs';
import { findApp, gatherRelease, checkReadiness, planSubmission, executeSubmission, compareVersions, PLATFORMS } from '../lib/release.mjs';
import { gate } from '../lib/confirm.mjs';

const VERSION = '0.3.2';

let apiCache;
function api() {
  if (apiCache) return apiCache;
  const creds = resolveCreds();
  if (creds.error) throw new UserError(creds.error);
  apiCache = ascClient(creds);
  return apiCache;
}

class UserError extends Error {}

async function product(query) {
  const index = await loadCiIndex(api());
  const p = findProduct(index, query);
  if (!p) {
    const names = index.products.map((x) => x.name).join(', ') || 'none';
    throw new UserError(query ? `No Xcode Cloud product matches "${query}". Products: ${names}.` : `Several products; pass app. Products: ${names}.`);
  }
  return p;
}

async function app(query) {
  const a = await findApp(api(), query);
  if (!a) throw new UserError(`No app matches "${query ?? ''}". Try list_apps.`);
  return a;
}

const appArg = { type: 'string', description: 'App name, bundle id, or App Store Connect app id' };
const platformArg = { type: 'string', enum: PLATFORMS, description: 'Default IOS' };

const TOOLS = [
  {
    name: 'list_apps',
    description: 'List the apps in the App Store Connect account and which have Xcode Cloud set up.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    async run() {
      const [apps, index] = await Promise.all([api().get('/v1/apps?fields[apps]=name,bundleId&limit=200'), loadCiIndex(api(), { fresh: true })]);
      return apps.data.map((a) => {
        const p = index.products.find((x) => x.appId === a.id);
        return { name: a.attributes.name, bundleId: a.attributes.bundleId, appId: a.id, xcodeCloud: p ? { workflows: p.workflows.map((w) => w.name), repo: p.repos[0]?.url } : null };
      });
    },
  },
  {
    name: 'ci_status',
    description: 'Xcode Cloud status for an app: each workflow with what starts it and where its builds go (TestFlight/App Store), plus the most recent build runs.',
    inputSchema: { type: 'object', properties: { app: appArg, runs: { type: 'number', description: 'Recent runs to show (default 8)' } } },
    annotations: { readOnlyHint: true },
    async run({ app: q, runs = 8 }) {
      const p = await product(q);
      const list = await recentRuns(api(), p.id, Math.min(runs, 50));
      return {
        product: p.name,
        repo: p.repos.map((r) => r.url),
        workflows: p.workflows.map((w) => ({ name: w.name, enabled: w.enabled, starts_on: describeTriggers(w), ships_to: describeDistribution(w) })),
        runs: list.map(summarizeRun),
      };
    },
  },
  {
    name: 'triage_run',
    description: 'Explain a failed Xcode Cloud build run: status per action, errors and warnings with file:line, failing tests, artifacts. Defaults to the latest failed run.',
    inputSchema: {
      type: 'object',
      properties: {
        app: appArg,
        run_number: { type: 'number', description: 'Build run number; default is the most recent failed or errored run' },
        log_excerpt: { type: 'boolean', description: 'Also download the log bundle and extract its error lines (slower)' },
      },
    },
    annotations: { readOnlyHint: true },
    async run({ app: q, run_number, log_excerpt }) {
      const p = await product(q);
      const list = await recentRuns(api(), p.id, 50);
      const run = run_number
        ? list.find((r) => r.attributes.number === run_number)
        : list.find((r) => ['FAILED', 'ERRORED'].includes(r.attributes.completionStatus));
      if (!run) return run_number ? `Run ${run_number} is not among the 50 most recent runs of ${p.name}.` : `No failed runs among the 50 most recent runs of ${p.name}.`;
      return triageRun(api(), run, { logExcerpt: !!log_excerpt });
    },
  },
  {
    name: 'find_run_for_commit',
    description: 'Did a commit start an Xcode Cloud build? Looks for runs of the commit (full or short sha) and which workflows a push of that branch should have started.',
    inputSchema: { type: 'object', properties: { app: appArg, sha: { type: 'string' } }, required: ['sha'] },
    annotations: { readOnlyHint: true },
    async run({ app: q, sha }) {
      const p = await product(q);
      const runs = await findRunsForCommit(api(), p.id, sha.trim());
      return runs.length
        ? { product: p.name, runs: runs.map(summarizeRun) }
        : { product: p.name, runs: [], note: 'No run for this commit among the 25 newest. If a workflow should have started, the webhook may have been missed: start_build can start it.' };
    },
  },
  {
    name: 'check_release',
    description: 'Readiness check for an App Store submission: version state, attached build (processing, export compliance, App Store eligibility), copyright, per-locale metadata and screenshots, review contact, and leftover rejected submissions. Lists blockers, warnings and the checks the API cannot see.',
    inputSchema: {
      type: 'object',
      properties: {
        app: appArg,
        version: { type: 'string', description: 'Marketing version, e.g. 1.4.2; default is the editable version' },
        platform: platformArg,
        build_number: { type: 'string', description: 'Check this build instead of the attached one' },
      },
      required: ['app'],
    },
    annotations: { readOnlyHint: true },
    async run({ app: q, version, platform = 'IOS', build_number }) {
      const a = await app(q);
      const bundle = await gatherRelease(api(), a, { version, platform, buildNumber: build_number });
      const res = checkReadiness(bundle);
      return {
        app: bundle.app.name,
        version: bundle.version ? `${bundle.version.versionString} (${bundle.version.state})` : null,
        build: bundle.candidateBuild || bundle.version?.build || null,
        ...res,
        submit_plan: res.ready ? planSubmission(bundle).map(describeStep) : undefined,
      };
    },
  },
  {
    name: 'review_status',
    description: 'Where App Review stands for an app: recent versions and their states, and open review submissions.',
    inputSchema: { type: 'object', properties: { app: appArg, platform: platformArg }, required: ['app'] },
    annotations: { readOnlyHint: true },
    async run({ app: q, platform = 'IOS' }) {
      const a = await app(q);
      const b = await gatherRelease(api(), a, { platform });
      return {
        app: b.app.name,
        versions: b.versions.slice(0, 5).map((v) => ({ version: v.versionString, state: v.state, created: v.created })),
        openSubmissions: b.submissions.map((s) => ({ state: s.state, submitted: s.submittedDate, versions: s.versionIds.map((id) => b.versions.find((v) => v.id === id)?.versionString || id) })),
        nextVersion: b.suggestedNextVersion,
      };
    },
  },
  {
    name: 'create_version',
    description: 'Create a new App Store version (draft; deletable in App Store Connect while unsubmitted). Refuses a version at or below the live one, whose train is closed.',
    inputSchema: {
      type: 'object',
      properties: {
        app: appArg,
        version: { type: 'string', description: 'Marketing version; must match the build CFBundleShortVersionString' },
        platform: platformArg,
        release_type: { type: 'string', enum: ['MANUAL', 'AFTER_APPROVAL', 'SCHEDULED'], description: 'Default MANUAL: you press release after approval' },
      },
      required: ['app', 'version'],
    },
    async run({ app: q, version, platform = 'IOS', release_type = 'MANUAL' }) {
      const a = await app(q);
      const b = await gatherRelease(api(), a, { platform });
      const top = b.versions.filter((v) => v.state === 'READY_FOR_DISTRIBUTION').map((v) => v.versionString).sort(compareVersions).at(-1);
      if (top && compareVersions(version, top) <= 0) throw new UserError(`${version} is not above the live version ${top}; that train is closed. Use ${b.suggestedNextVersion}.`);
      const editable = b.versions.find((v) => !['READY_FOR_DISTRIBUTION', 'REPLACED_WITH_NEW_VERSION', 'REMOVED_FROM_SALE'].includes(v.state));
      if (editable) throw new UserError(`Version ${editable.versionString} (${editable.state}) is already open for ${platform}; Apple allows one at a time. Use update_version to rename or edit it.`);
      const r = await api()('POST', '/v1/appStoreVersions', {
        data: { type: 'appStoreVersions', attributes: { platform, versionString: version, releaseType: release_type }, relationships: { app: { data: { type: 'apps', id: a.id } } } },
      });
      if (!r.ok) throw new UserError(describeErrors(r));
      return { created: version, id: r.json.data.id, state: r.json.data.attributes.appVersionState, next: 'Run check_release to see what it still needs.' };
    },
  },
  {
    name: 'update_version',
    description: "Edit an unsubmitted App Store version: version string, copyright, release type, and What's New per locale. Will not overwrite a non-empty field unless overwrite is true; it returns old and new values instead.",
    inputSchema: {
      type: 'object',
      properties: {
        app: appArg,
        version: { type: 'string', description: 'Version to edit; default is the editable one' },
        platform: platformArg,
        new_version: { type: 'string' },
        copyright: { type: 'string' },
        release_type: { type: 'string', enum: ['MANUAL', 'AFTER_APPROVAL', 'SCHEDULED'] },
        whats_new: { type: 'object', additionalProperties: { type: 'string' }, description: 'Locale → text, e.g. {"en-US": "Bug fixes"}; "*" means every locale' },
        overwrite: { type: 'boolean' },
      },
      required: ['app'],
    },
    async run({ app: q, version, platform = 'IOS', new_version, copyright, release_type, whats_new, overwrite }) {
      const a = await app(q);
      const b = await gatherRelease(api(), a, { version, platform });
      const v = b.version;
      if (!v) throw new UserError('No editable version found.');
      const conflicts = [];
      const attrs = {};
      if (new_version && new_version !== v.versionString) attrs.versionString = new_version;
      if (copyright !== undefined && copyright !== v.copyright) {
        if (v.copyright && !overwrite) conflicts.push({ field: 'copyright', old: v.copyright, new: copyright });
        else attrs.copyright = copyright;
      }
      if (release_type && release_type !== v.releaseType) attrs.releaseType = release_type;
      const done = [];
      if (conflicts.length) return { changed: [], conflicts, note: 'Fields already have values. Show the user old vs new; call again with overwrite: true to replace.' };

      const locEdits = [];
      if (whats_new) {
        const full = await api().get(`/v1/appStoreVersions/${v.id}/appStoreVersionLocalizations?limit=50`);
        for (const l of full.data) {
          const text = whats_new[l.attributes.locale] ?? whats_new['*'];
          if (text === undefined || text === l.attributes.whatsNew) continue;
          if (l.attributes.whatsNew && !overwrite) conflicts.push({ field: `whatsNew ${l.attributes.locale}`, old: l.attributes.whatsNew, new: text });
          else locEdits.push({ id: l.id, locale: l.attributes.locale, text });
        }
        if (conflicts.length) return { changed: [], conflicts, note: 'Fields already have values. Show the user old vs new; call again with overwrite: true to replace.' };
      }
      if (Object.keys(attrs).length) {
        const r = await api()('PATCH', `/v1/appStoreVersions/${v.id}`, { data: { type: 'appStoreVersions', id: v.id, attributes: attrs } });
        if (!r.ok) throw new UserError(describeErrors(r));
        done.push(...Object.keys(attrs));
      }
      for (const e of locEdits) {
        const r = await api()('PATCH', `/v1/appStoreVersionLocalizations/${e.id}`, { data: { type: 'appStoreVersionLocalizations', id: e.id, attributes: { whatsNew: e.text } } });
        if (!r.ok) throw new UserError(`whatsNew ${e.locale}: ${describeErrors(r)}`);
        done.push(`whatsNew ${e.locale}`);
      }
      return { version: attrs.versionString || v.versionString, changed: done };
    },
  },
  {
    name: 'start_build',
    description: 'Start an Xcode Cloud workflow on a branch (e.g. after a push whose webhook was missed). IRREVERSIBLE: a build that archives ships to TestFlight. First call returns the plan and a confirm token; ask the user, then call again with confirm.',
    inputSchema: {
      type: 'object',
      properties: {
        app: appArg,
        workflow: { type: 'string', description: 'Workflow name; default when the product has one' },
        branch: { type: 'string', description: 'Branch to build; default is the first branch the workflow starts on' },
        confirm: { type: 'string' },
      },
    },
    async run({ app: q, workflow, branch, confirm }) {
      const p = await product(q);
      const wfs = p.workflows.filter((w) => w.enabled);
      const wf = workflow ? wfs.find((w) => w.name.toLowerCase() === workflow.toLowerCase()) : wfs.length === 1 ? wfs[0] : null;
      if (!wf) throw new UserError(`Pick a workflow: ${wfs.map((w) => w.name).join(', ')}.`);
      const target = branch || wf.branch?.source?.patterns?.find((x) => !x.isPrefix)?.pattern;
      if (!target) throw new UserError('Pass branch: the workflow has no fixed branch to default to.');
      const repoId = wf.repositoryId || p.repos[0]?.id;
      const refs = await api().get(`/v1/scmRepositories/${repoId}/gitReferences?limit=200`);
      const ref = refs.data.find((r) => r.attributes.kind === 'BRANCH' && !r.attributes.isDeleted && r.attributes.name === target);
      if (!ref) throw new UserError(`Branch ${target} not found in the repository Xcode Cloud sees.`);
      const [latest] = await recentRuns(api(), p.id, 1);
      const plan = { product: p.name, workflow: wf.name, branch: target, ships_to: describeDistribution(wf), refId: ref.id, workflowId: wf.id };
      const g = gate('start_build', { ...plan, latestRun: latest?.id || null }, confirm, {
        action: `Start "${wf.name}" for ${p.name} on ${target}`,
        effect: wf.actions.some((x) => x.type === 'ARCHIVE') ? `Builds and archives; ${describeDistribution(wf)}.` : 'Builds/tests only; nothing ships.',
        latest_run: latest ? summarizeRun(latest) : null,
      });
      if (!g.run) return g.response;
      const r = await api()('POST', '/v1/ciBuildRuns', {
        data: { type: 'ciBuildRuns', relationships: { workflow: { data: { type: 'ciWorkflows', id: wf.id } }, sourceBranchOrTag: { data: { type: 'scmGitReferences', id: ref.id } } } },
      });
      if (!r.ok) throw new UserError(describeErrors(r));
      return { started: true, run: summarizeRun(r.json.data) };
    },
  },
  {
    name: 'submit_for_review',
    description: 'Submit an App Store version for review: cancels a leftover rejected submission if one holds the version, attaches build_number if given, reuses or creates the review submission, adds the version and submits. Refuses while check_release has blockers. IRREVERSIBLE: first call returns the plan and a confirm token; ask the user, then call again with confirm.',
    inputSchema: {
      type: 'object',
      properties: {
        app: appArg,
        version: { type: 'string' },
        platform: platformArg,
        build_number: { type: 'string', description: 'Attach this build first' },
        confirm: { type: 'string' },
      },
      required: ['app'],
    },
    async run({ app: q, version, platform = 'IOS', build_number, confirm }) {
      const a = await app(q);
      const bundle = await gatherRelease(api(), a, { version, platform, buildNumber: build_number });
      const check = checkReadiness(bundle);
      if (!check.ready) return { submitted: false, blockers: check.blockers, warnings: check.warnings };
      const steps = planSubmission(bundle);
      const g = gate('submit_for_review', steps, confirm, {
        action: `Submit ${bundle.app.name} ${bundle.version.versionString} (${platform}) for App Review`,
        steps: steps.map(describeStep),
        warnings: check.warnings,
        manual_checks: check.manual,
      });
      if (!g.run) return g.response;
      const res = await executeSubmission(api(), steps);
      return res.ok
        ? { submitted: true, steps: res.log, next: 'review_status shows progress; reviews usually take about a day.' }
        : { submitted: false, steps: res.log, note: 'Stopped at the failed step; earlier steps are done. Fix the cause and run check_release again.' };
    },
  },
];

function describeStep(s) {
  switch (s.op) {
    case 'cancel_submission': return `Cancel rejected submission ${s.submissionId.slice(0, 8)}… (${s.why})`;
    case 'attach_build': return `Attach build ${s.build}${s.replaces ? ` (replacing ${s.replaces})` : ''}`;
    case 'reuse_draft': return `Use the existing draft submission ${s.submissionId.slice(0, 8)}…`;
    case 'create_submission': return `Create a review submission for ${s.platform}`;
    case 'add_version': return `Add version ${s.version} to it`;
    case 'submit': return 'Submit for review';
    default: return s.op;
  }
}

// --- JSON-RPC over stdio -----------------------------------------------------

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications (initialized, cancelled) need no reply
  try {
    switch (method) {
      case 'initialize':
        return send({ jsonrpc: '2.0', id, result: {
          protocolVersion: params?.protocolVersion || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'seaworthy', version: VERSION },
          instructions: 'Xcode Cloud and App Store release tools using the user\'s own App Store Connect API key. start_build and submit_for_review are irreversible and return a plan plus a confirm token first: always show the plan and get an explicit yes from the user before calling again with confirm. Never pass a token the user has not approved.',
        } });
      case 'ping':
        return send({ jsonrpc: '2.0', id, result: {} });
      case 'tools/list':
        return send({ jsonrpc: '2.0', id, result: { tools: TOOLS.map(({ run, ...t }) => t) } });
      case 'tools/call': {
        const tool = TOOLS.find((t) => t.name === params?.name);
        if (!tool) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool ${params?.name}` } });
        try {
          const out = await tool.run(params.arguments || {});
          return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 1) }] } });
        } catch (e) {
          const text = e instanceof UserError ? e.message : `${tool.name} failed: ${e.message}`;
          return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } });
        }
      }
      default:
        return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (e) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
  handle(msg);
});
