import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkReadiness, planSubmission, compareVersions, nextVersion } from '../lib/release.mjs';
import { planToken, gate } from '../lib/confirm.mjs';
import { describeErrors } from '../lib/asc.mjs';

// Synthetic, in the shape gatherRelease returns. No real account data.
const ready = () => ({
  app: { id: 'app1', name: 'App', bundleId: 'com.example.app' },
  platform: 'IOS',
  requestedVersion: null,
  versions: [
    { id: 'v2', versionString: '1.3', state: 'PREPARE_FOR_SUBMISSION' },
    { id: 'v1', versionString: '1.2', state: 'READY_FOR_DISTRIBUTION', appStoreState: 'READY_FOR_SALE' },
  ],
  suggestedNextVersion: '1.2.1',
  submissions: [],
  candidateBuild: null,
  version: {
    id: 'v2', versionString: '1.3', state: 'PREPARE_FOR_SUBMISSION', copyright: '2026 Example', releaseType: 'MANUAL', isFirstVersion: false,
    build: { id: 'b9', number: '9', processingState: 'VALID', audience: 'APP_STORE_ELIGIBLE', usesNonExemptEncryption: false, expired: false },
    reviewDetail: { contactFirstName: 'A', contactLastName: 'B', contactPhone: '+1 555 0100', contactEmail: 'a@example.com', demoAccountRequired: false, demoAccountSet: false },
    localizations: [{ locale: 'en-US', description: true, keywords: true, supportUrl: true, whatsNew: 'Fixes', screenshotSets: [{ displayType: 'APP_IPHONE_67', count: 3, failed: 0 }] }],
  },
});

test('a complete version is ready, with only manual checks left', () => {
  const r = checkReadiness(ready());
  assert.equal(r.ready, true, r.blockers.join('\n'));
  assert.equal(r.blockers.length, 0);
  assert.ok(r.manual.length > 0);
});

test('each gap blocks with an actionable reason', () => {
  const b = ready();
  b.version.copyright = '';
  b.version.build.usesNonExemptEncryption = null;
  b.version.build.audience = 'INTERNAL_ONLY';
  b.version.localizations[0].whatsNew = '';
  b.version.localizations[0].screenshotSets = [];
  b.version.reviewDetail.contactPhone = '';
  const r = checkReadiness(b);
  assert.equal(r.ready, false);
  const all = r.blockers.join('\n');
  for (const s of ['Copyright', 'export-compliance', 'Deployment Preparation', "What's New", 'no screenshots', 'App Review contact']) assert.match(all, new RegExp(s), s);
});

test("What's New is not required on a first version", () => {
  const b = ready();
  b.version.isFirstVersion = true;
  b.version.localizations[0].whatsNew = '';
  assert.equal(checkReadiness(b).ready, true);
});

test('a closed train points at the next version', () => {
  const b = ready();
  b.version = null;
  b.requestedVersion = '1.2';
  const r = checkReadiness(b);
  assert.match(r.blockers[0], /train is closed.*1\.2\.1/);
});

test('a processing or missing build blocks', () => {
  const b = ready();
  b.version.build.processingState = 'PROCESSING';
  assert.match(checkReadiness(b).blockers.join(), /PROCESSING/);
  b.candidateBuild = { missing: true, number: '12' };
  assert.match(checkReadiness(b).blockers.join(), /Build 12 was not found/);
});

test('plain submission creates, adds and submits', () => {
  assert.deepEqual(planSubmission(ready()).map((s) => s.op), ['create_submission', 'add_version', 'submit']);
});

test('resubmit after rejection cancels the stale submission and reuses the draft', () => {
  const b = ready();
  b.version.state = 'REJECTED';
  b.candidateBuild = { id: 'b10', number: '10', processingState: 'VALID', audience: 'APP_STORE_ELIGIBLE', usesNonExemptEncryption: false };
  b.submissions = [
    { id: 'stale-sub', state: 'UNRESOLVED_ISSUES', versionIds: ['v2'] },
    { id: 'draft-sub', state: 'READY_FOR_REVIEW', versionIds: [] },
  ];
  const steps = planSubmission(b);
  assert.deepEqual(steps.map((s) => s.op), ['cancel_submission', 'attach_build', 'reuse_draft', 'add_version', 'submit']);
  assert.equal(steps[1].replaces, '9');
  assert.match(checkReadiness(b).warnings.join(), /UNRESOLVED_ISSUES/);
});

test('a draft that already holds the version skips add_version', () => {
  const b = ready();
  b.submissions = [{ id: 'd', state: 'READY_FOR_REVIEW', versionIds: ['v2'] }];
  assert.deepEqual(planSubmission(b).map((s) => s.op), ['reuse_draft', 'submit']);
});

test('versions compare numerically and the next one bumps the patch', () => {
  assert.equal(compareVersions('1.10', '1.9'), 1);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  assert.equal(nextVersion(ready().versions), '1.2.1');
  assert.equal(nextVersion([{ versionString: '1.0', state: 'PREPARE_FOR_SUBMISSION' }]), null);
});

test('confirm tokens are stable, key-order independent, and change with the plan', () => {
  const a = planToken('submit_for_review', [{ op: 'submit', x: 1, y: 2 }]);
  assert.equal(a, planToken('submit_for_review', [{ y: 2, op: 'submit', x: 1 }]));
  assert.notEqual(a, planToken('submit_for_review', [{ op: 'submit', x: 1, y: 3 }]));
  assert.notEqual(a, planToken('start_build', [{ op: 'submit', x: 1, y: 2 }]));
});

test('gate returns a plan without a token, runs only with the matching one', () => {
  const plan = [{ op: 'submit' }];
  const first = gate('submit_for_review', plan, undefined, 'desc');
  assert.equal(first.run, false);
  assert.equal(first.response.confirmation_required, true);
  assert.equal(gate('submit_for_review', plan, first.response.confirm).run, true);
  const stale = gate('submit_for_review', [{ op: 'submit', extra: 1 }], first.response.confirm, 'desc');
  assert.equal(stale.run, false);
  assert.match(stale.response.note, /plan changed/);
});

test('describeErrors surfaces associatedErrors from a 409', () => {
  const res = { status: 409, json: { errors: [{ title: 'The request entity is not valid', detail: 'appStoreVersion is not in valid state', meta: { associatedErrors: { '/v1/appStoreVersions/v2': [{ detail: 'You must provide a copyright.' }] } } }] } };
  assert.match(describeErrors(res), /↳ \/v1\/appStoreVersions\/v2: You must provide a copyright\./);
});

test('resolveCreds reads only plugin settings and repairs a flattened .p8', async () => {
  const { resolveCreds } = await import('../lib/asc.mjs');
  const { generateKeyPairSync } = await import('node:crypto');
  const pem = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  // Other tools' variables are ignored, and so are unfilled placeholders.
  assert.match(resolveCreds({ ASC_KEY_ID: 'K', ASC_ISSUER_ID: 'I', SHIPWRIGHT_KEY_ID: '${user_config.key_id}' }).error, /not configured/);
  const flat = pem.replace(/\n/g, ' ');
  const r = resolveCreds({ CLAUDE_PLUGIN_OPTION_KEY_ID: 'K', CLAUDE_PLUGIN_OPTION_ISSUER_ID: 'I', CLAUDE_PLUGIN_OPTION_PRIVATE_KEY: flat });
  assert.equal(r.error, undefined);
  assert.equal(r.privateKey, pem);
  assert.match(resolveCreds({ SHIPWRIGHT_KEY_ID: 'K', SHIPWRIGHT_ISSUER_ID: 'I', SHIPWRIGHT_PRIVATE_KEY: 'not a key' }).error, /not a valid/);
});

test('redactSecrets masks token-shaped strings in log lines', async () => {
  const { redactSecrets } = await import('../lib/ci.mjs');
  const fake = 'ghp_' + 'a'.repeat(36);
  assert.equal(redactSecrets(`error: push failed with ${fake}`), 'error: push failed with [redacted]');
  assert.equal(redactSecrets('error: API_KEY=abc123 rejected'), 'error: API_KEY=[redacted] rejected');
  assert.equal(redactSecrets('fatal: https://user:pw@github.com/x'), 'fatal: https://[redacted]@github.com/x');
  assert.equal(redactSecrets('error: no such module Foo'), 'error: no such module Foo');
});

test('the API client refuses absolute URLs so the token stays with Apple', async () => {
  const { ascClient } = await import('../lib/asc.mjs');
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const api = ascClient({ keyId: 'K', issuer: 'I', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
  await assert.rejects(api('GET', 'https://evil.example/v1/apps'), /refusing non-path/);
});
