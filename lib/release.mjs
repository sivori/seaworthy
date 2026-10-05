// App Store releases: gather a version's state, check it, plan a submission.
//
// Split into gather (network) → check/plan (pure) → execute (network) so the
// readiness rules and the submit plan are unit-testable against fixtures, and
// so a confirmation token can be derived from a plan that is recomputed fresh.

import { describeErrors } from './asc.mjs';

const OPEN_SUBMISSION_STATES = ['READY_FOR_REVIEW', 'UNRESOLVED_ISSUES', 'WAITING_FOR_REVIEW', 'IN_REVIEW', 'CANCELING', 'COMPLETING'];
// Version states in which a version can still be edited and submitted.
const EDITABLE = ['PREPARE_FOR_SUBMISSION', 'READY_FOR_REVIEW', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY'];
const IN_FLIGHT = ['WAITING_FOR_REVIEW', 'IN_REVIEW', 'PENDING_DEVELOPER_RELEASE', 'PENDING_APPLE_RELEASE', 'PROCESSING_FOR_DISTRIBUTION', 'ACCEPTED', 'PROCESSING_FOR_APP_STORE', 'WAITING_FOR_EXPORT_COMPLIANCE'];

export const PLATFORMS = ['IOS', 'MAC_OS', 'TV_OS', 'VISION_OS'];

/** Resolve a name, bundle id or app id to one app. */
export async function findApp(api, query) {
  const apps = await api.get('/v1/apps?fields[apps]=name,bundleId&limit=200');
  const q = String(query || '').toLowerCase();
  const list = apps.data;
  if (!q) return list.length === 1 ? list[0] : null;
  return (
    list.find((a) => a.id === query || a.attributes.bundleId.toLowerCase() === q || a.attributes.name.toLowerCase() === q) ||
    list.find((a) => a.attributes.name.toLowerCase().includes(q)) ||
    null
  );
}

/** Compare dotted version strings numerically: 1.10 > 1.9. */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

/** The next marketing version after the highest one Apple has approved. */
export function nextVersion(versions) {
  const approved = versions.filter((v) => v.state === 'READY_FOR_DISTRIBUTION' || v.appStoreState === 'READY_FOR_SALE').map((v) => v.versionString);
  if (!approved.length) return null;
  const top = approved.sort(compareVersions).at(-1).split('.').map(Number);
  while (top.length < 3) top.push(0);
  top[2] += 1;
  return top.join('.');
}

/**
 * Fetch everything the readiness check needs, in one bundle of plain data.
 * Never carries the review demo-account password: the check only needs to
 * know whether one is set.
 */
export async function gatherRelease(api, app, { version, platform = 'IOS', buildNumber } = {}) {
  const vlist = await api.get(`/v1/apps/${app.id}/appStoreVersions?filter[platform]=${platform}&limit=20`);
  const versions = vlist.data.map((v) => ({ id: v.id, versionString: v.attributes.versionString, state: v.attributes.appVersionState, appStoreState: v.attributes.appStoreState, created: v.attributes.createdDate }));

  const target = version
    ? versions.find((v) => v.versionString === version)
    : versions.find((v) => !['READY_FOR_DISTRIBUTION', 'REPLACED_WITH_NEW_VERSION', 'REMOVED_FROM_SALE'].includes(v.state)) || null;

  const bundle = {
    app: { id: app.id, name: app.attributes.name, bundleId: app.attributes.bundleId },
    platform,
    requestedVersion: version || null,
    versions,
    suggestedNextVersion: nextVersion(versions),
    version: null,
    submissions: [],
    candidateBuild: null,
  };

  const subs = await api.get(`/v1/reviewSubmissions?filter[app]=${app.id}&filter[platform]=${platform}&filter[state]=${OPEN_SUBMISSION_STATES.join(',')}&limit=20`);
  for (const s of subs.data) {
    const items = await api.get(`/v1/reviewSubmissions/${s.id}/items?limit=50`);
    bundle.submissions.push({
      id: s.id,
      state: s.attributes.state,
      submittedDate: s.attributes.submittedDate || null,
      versionIds: items.data.map((i) => i.relationships?.appStoreVersion?.data?.id).filter(Boolean),
    });
  }

  if (!target) return bundle;

  const v = await api.get(`/v1/appStoreVersions/${target.id}?include=build,appStoreVersionLocalizations,appStoreReviewDetail`);
  const inc = v.included || [];
  const build = inc.find((i) => i.type === 'builds');
  const rd = inc.find((i) => i.type === 'appStoreReviewDetails');
  const locs = inc.filter((i) => i.type === 'appStoreVersionLocalizations');

  bundle.version = {
    id: target.id,
    versionString: target.versionString,
    state: target.state,
    appStoreState: target.appStoreState,
    copyright: v.data.attributes.copyright,
    releaseType: v.data.attributes.releaseType,
    earliestReleaseDate: v.data.attributes.earliestReleaseDate,
    isFirstVersion: versions.every((x) => x.id === target.id || !['READY_FOR_DISTRIBUTION', 'REPLACED_WITH_NEW_VERSION'].includes(x.state)),
    build: build ? summarizeBuild(build) : null,
    reviewDetail: rd
      ? {
          contactFirstName: rd.attributes.contactFirstName,
          contactLastName: rd.attributes.contactLastName,
          contactPhone: rd.attributes.contactPhone,
          contactEmail: rd.attributes.contactEmail,
          demoAccountRequired: rd.attributes.demoAccountRequired,
          demoAccountSet: !!(rd.attributes.demoAccountName && rd.attributes.demoAccountPassword),
          hasNotes: !!rd.attributes.notes,
        }
      : null,
    localizations: [],
  };

  for (const l of locs) {
    const sets = await api.get(`/v1/appStoreVersionLocalizations/${l.id}/appScreenshotSets?include=appScreenshots&limit=50`);
    const shots = new Map((sets.included || []).map((s) => [s.id, s.attributes]));
    bundle.version.localizations.push({
      locale: l.attributes.locale,
      description: !!l.attributes.description,
      keywords: !!l.attributes.keywords,
      supportUrl: !!l.attributes.supportUrl,
      whatsNew: l.attributes.whatsNew || '',
      screenshotSets: sets.data.map((s) => {
        const ids = (s.relationships.appScreenshots?.data || []).map((x) => x.id);
        return {
          displayType: s.attributes.screenshotDisplayType,
          count: ids.length,
          failed: ids.filter((id) => shots.get(id)?.assetDeliveryState?.state === 'FAILED').length,
        };
      }),
    });
  }

  if (buildNumber) {
    const b = await api.get(`/v1/builds?filter[app]=${app.id}&filter[version]=${encodeURIComponent(buildNumber)}&filter[preReleaseVersion.version]=${encodeURIComponent(target.versionString)}&filter[preReleaseVersion.platform]=${platform}&limit=1`);
    bundle.candidateBuild = b.data[0] ? summarizeBuild(b.data[0]) : { missing: true, number: String(buildNumber) };
  }
  return bundle;
}

function summarizeBuild(b) {
  const a = b.attributes;
  return {
    id: b.id,
    number: a.version,
    processingState: a.processingState,
    audience: a.buildAudienceType,
    usesNonExemptEncryption: a.usesNonExemptEncryption,
    expired: a.expired,
    uploaded: a.uploadedDate,
  };
}

/**
 * The readiness rules. Returns blockers (submission will fail), warnings
 * (it will go through but probably shouldn't), and manual checks the API
 * can't see. Pure: takes a gatherRelease bundle.
 */
export function checkReadiness(bundle) {
  const blockers = [];
  const warnings = [];
  const manual = [
    'App Privacy answers (not exposed by the API) are complete in App Store Connect.',
    'Every device family the app supports has screenshots (the API does not say which families the binary supports).',
  ];
  const v = bundle.version;

  if (!v) {
    if (bundle.requestedVersion) {
      const closed = bundle.versions.find((x) => x.versionString === bundle.requestedVersion);
      blockers.push(closed
        ? `Version ${bundle.requestedVersion} exists but is ${closed.state}; its train is closed. Use ${bundle.suggestedNextVersion || 'a higher version'} and bump MARKETING_VERSION to match.`
        : `No App Store version ${bundle.requestedVersion} exists yet. Create it (create_version).`);
    } else {
      blockers.push(`No editable App Store version. Create one (create_version)${bundle.suggestedNextVersion ? `; next after the live version is ${bundle.suggestedNextVersion}` : ''}.`);
    }
    return { ready: false, blockers, warnings, manual };
  }

  if (IN_FLIGHT.includes(v.state)) blockers.push(`Version ${v.versionString} is already ${v.state}; nothing to submit.`);
  else if (v.state === 'READY_FOR_DISTRIBUTION') blockers.push(`Version ${v.versionString} is already live; its train is closed. Next: ${bundle.suggestedNextVersion}.`);
  else if (!EDITABLE.includes(v.state)) warnings.push(`Version state ${v.state} is unusual for a submission.`);

  const b = bundle.candidateBuild && !bundle.candidateBuild.missing ? bundle.candidateBuild : v.build;
  if (bundle.candidateBuild?.missing) blockers.push(`Build ${bundle.candidateBuild.number} was not found under version ${v.versionString}. The build's CFBundleShortVersionString must equal the App Store version.`);
  if (!b) blockers.push('No build attached. Pass build_number to attach one.');
  else {
    if (b.expired) blockers.push(`Build ${b.number} has expired.`);
    if (b.processingState !== 'VALID') blockers.push(`Build ${b.number} is ${b.processingState}, not VALID${b.processingState === 'PROCESSING' ? ' (wait for processing to finish)' : ''}.`);
    if (b.audience === 'INTERNAL_ONLY') blockers.push(`Build ${b.number} is TestFlight-internal only. In Xcode Cloud: workflow → Archive action → Deployment Preparation → "TestFlight and App Store" (the API can't change this), then build again.`);
    if (b.usesNonExemptEncryption == null) blockers.push(`Build ${b.number} has no export-compliance answer. Add ITSAppUsesNonExemptEncryption to Info.plist, or answer it for this build.`);
  }

  if (!v.copyright) blockers.push('Copyright is empty (submission 409s without it), e.g. "2026 Your Name".');

  if (!v.localizations.length) blockers.push('No localizations.');
  for (const l of v.localizations) {
    const miss = [];
    if (!l.description) miss.push('description');
    if (!l.keywords) miss.push('keywords');
    if (!l.supportUrl) miss.push('support URL');
    if (!v.isFirstVersion && !l.whatsNew.trim()) miss.push("What's New");
    if (miss.length) blockers.push(`${l.locale}: missing ${miss.join(', ')}.`);
    const withShots = l.screenshotSets.filter((s) => s.count > 0);
    if (!withShots.length) blockers.push(`${l.locale}: no screenshots.`);
    const failed = l.screenshotSets.reduce((n, s) => n + s.failed, 0);
    if (failed) blockers.push(`${l.locale}: ${failed} screenshot(s) failed processing; re-upload them.`);
  }

  const rd = v.reviewDetail;
  if (!rd || !rd.contactFirstName || !rd.contactLastName || !rd.contactPhone || !rd.contactEmail) {
    blockers.push('App Review contact (name, phone, email) is incomplete.');
  }
  if (rd?.demoAccountRequired && !rd.demoAccountSet) blockers.push('App Review demo account is marked required but not filled in.');

  const stale = bundle.submissions.find((s) => s.state === 'UNRESOLVED_ISSUES' && s.versionIds.includes(v.id));
  if (stale) warnings.push(`A rejected submission (${stale.id.slice(0, 8)}…, UNRESOLVED_ISSUES) still holds this version. Submitting will cancel it first, or adding the version fails with a 409.`);
  const waiting = bundle.submissions.find((s) => ['WAITING_FOR_REVIEW', 'IN_REVIEW'].includes(s.state));
  if (waiting && !waiting.versionIds.includes(v.id)) warnings.push(`Another submission is already ${waiting.state} for this platform.`);

  if (v.releaseType === 'AFTER_APPROVAL') warnings.push('Release type is automatic: the app goes live the moment review approves it.');

  return { ready: blockers.length === 0, blockers, warnings, manual };
}

/**
 * The submission as a list of steps. Pure, and deterministic for a given
 * bundle, so its hash can serve as the confirmation token.
 */
export function planSubmission(bundle) {
  const v = bundle.version;
  const steps = [];
  if (!v) return steps;
  for (const s of bundle.submissions.filter((s) => s.state === 'UNRESOLVED_ISSUES' && s.versionIds.includes(v.id))) {
    steps.push({ op: 'cancel_submission', submissionId: s.id, why: 'rejected submission still holds this version' });
  }
  const cb = bundle.candidateBuild;
  if (cb && !cb.missing && cb.id !== v.build?.id) {
    steps.push({ op: 'attach_build', versionId: v.id, buildId: cb.id, build: cb.number, replaces: v.build?.number || null });
  }
  // READY_FOR_REVIEW is the reusable draft; it can't be canceled or deleted.
  const draft = bundle.submissions.find((s) => s.state === 'READY_FOR_REVIEW');
  if (draft) steps.push({ op: 'reuse_draft', submissionId: draft.id, alreadyHasVersion: draft.versionIds.includes(v.id) });
  else steps.push({ op: 'create_submission', appId: bundle.app.id, platform: bundle.platform });
  if (!draft?.versionIds.includes(v.id)) steps.push({ op: 'add_version', versionId: v.id, version: v.versionString });
  steps.push({ op: 'submit' });
  return steps;
}

/** Run a plan. Stops at the first failure and says which step and why. */
export async function executeSubmission(api, steps) {
  const log = [];
  let submissionId = null;
  for (const s of steps) {
    let r;
    switch (s.op) {
      case 'cancel_submission':
        r = await api('PATCH', `/v1/reviewSubmissions/${s.submissionId}`, { data: { type: 'reviewSubmissions', id: s.submissionId, attributes: { canceled: true } } });
        break;
      case 'attach_build':
        r = await api('PATCH', `/v1/appStoreVersions/${s.versionId}/relationships/build`, { data: { type: 'builds', id: s.buildId } });
        break;
      case 'reuse_draft':
        submissionId = s.submissionId;
        log.push({ step: s.op, ok: true });
        continue;
      case 'create_submission':
        r = await api('POST', '/v1/reviewSubmissions', { data: { type: 'reviewSubmissions', attributes: { platform: s.platform }, relationships: { app: { data: { type: 'apps', id: s.appId } } } } });
        if (r.ok) submissionId = r.json.data.id;
        break;
      case 'add_version':
        r = await api('POST', '/v1/reviewSubmissionItems', { data: { type: 'reviewSubmissionItems', relationships: { reviewSubmission: { data: { type: 'reviewSubmissions', id: submissionId } }, appStoreVersion: { data: { type: 'appStoreVersions', id: s.versionId } } } } });
        break;
      case 'submit':
        r = await api('PATCH', `/v1/reviewSubmissions/${submissionId}`, { data: { type: 'reviewSubmissions', id: submissionId, attributes: { submitted: true } } });
        break;
      default:
        throw new Error(`unknown step ${s.op}`);
    }
    if (!r.ok) {
      log.push({ step: s.op, ok: false, error: describeErrors(r) });
      return { ok: false, log, submissionId };
    }
    log.push({ step: s.op, ok: true });
  }
  return { ok: true, log, submissionId };
}
