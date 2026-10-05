import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePushCommands, destinationBranch, sourceRef, normalizeRemote, branchMatches } from '../lib/git.mjs';
import { matchPush, describeTriggers, describeDistribution } from '../lib/ci.mjs';

test('parsePushCommands finds pushes inside compound commands', () => {
  assert.deepEqual(parsePushCommands('git push'), [{ dir: undefined, remote: undefined, refspecs: [] }]);
  assert.deepEqual(parsePushCommands('cd app && git add . && git commit -m x && git push origin main'), [{ dir: undefined, remote: 'origin', refspecs: ['main'] }]);
  assert.deepEqual(parsePushCommands('git -C ../app push -u origin feat:main'), [{ dir: '../app', remote: 'origin', refspecs: ['feat:main'] }]);
  assert.deepEqual(parsePushCommands('git push -o ci.skip origin main'), [{ dir: undefined, remote: 'origin', refspecs: ['main'] }]);
});

test('parsePushCommands ignores dry runs, deletes, tags and non-pushes', () => {
  assert.deepEqual(parsePushCommands('git push --dry-run'), []);
  assert.deepEqual(parsePushCommands('git push origin --delete old'), []);
  assert.deepEqual(parsePushCommands('git push --tags'), []);
  assert.deepEqual(parsePushCommands('git status && echo push'), []);
  assert.deepEqual(parsePushCommands('git stash push'), []);
});

test('destinationBranch and sourceRef read refspecs', () => {
  assert.equal(destinationBranch(undefined, 'main'), 'main');
  assert.equal(destinationBranch('HEAD', 'dev'), 'dev');
  assert.equal(destinationBranch('feat:master', 'feat'), 'master');
  assert.equal(destinationBranch('+HEAD:refs/heads/release', 'x'), 'release');
  assert.equal(destinationBranch('v1.0:refs/tags/v1.0', 'x'), null);
  assert.equal(sourceRef('feat:master'), 'feat');
  assert.equal(sourceRef(undefined), 'HEAD');
  assert.equal(sourceRef('+main'), 'main');
});

test('normalizeRemote equates https, ssh and scp-style remotes', () => {
  const want = 'github.com/acme/app';
  for (const u of ['https://github.com/acme/app.git', 'git@github.com:acme/app.git', 'ssh://git@github.com/acme/app.git', 'https://github.com/Acme/App/', 'ssh://git@github.com:22/acme/app.git']) {
    assert.equal(normalizeRemote(u), want, u);
  }
});

test('branchMatches follows Apple start-condition patterns', () => {
  assert.ok(branchMatches({ isAllMatch: true, patterns: [] }, 'anything'));
  const s = { isAllMatch: false, patterns: [{ pattern: 'master', isPrefix: false }, { pattern: 'release/', isPrefix: true }, { pattern: 'hotfix-*', isPrefix: false }] };
  assert.ok(branchMatches(s, 'master'));
  assert.ok(!branchMatches(s, 'master2'));
  assert.ok(branchMatches(s, 'release/1.2'));
  assert.ok(branchMatches(s, 'hotfix-login'));
  assert.ok(!branchMatches(s, 'feature'));
  assert.ok(!branchMatches(null, 'master'));
});

const wf = (over = {}) => ({
  id: 'wf1', name: 'Release', enabled: true, repositoryId: 'repo1',
  branch: { source: { isAllMatch: false, patterns: [{ pattern: 'main', isPrefix: false }] }, hasFileRule: false },
  tag: false, pullRequest: false, scheduled: false,
  actions: [{ name: 'Archive - iOS', type: 'ARCHIVE', platform: 'IOS', audience: 'APP_STORE_ELIGIBLE' }],
  ...over,
});
const index = {
  products: [{ id: 'p1', name: 'App', repos: [{ id: 'repo1', key: 'github.com/acme/app' }], workflows: [wf(), wf({ id: 'wf2', name: 'Off', enabled: false }), wf({ id: 'wf3', name: 'PRs', branch: null, pullRequest: true })] }],
};

test('matchPush finds enabled branch workflows for the pushed repo', () => {
  assert.deepEqual(matchPush(index, 'git@github.com:acme/app.git', 'main').map((h) => h.workflow.id), ['wf1']);
  assert.equal(matchPush(index, 'git@github.com:acme/app.git', 'dev').length, 0);
  assert.equal(matchPush(index, 'git@github.com:acme/other.git', 'main').length, 0);
});

test('workflow descriptions read like a person wrote them', () => {
  assert.equal(describeTriggers(wf()), 'push to main');
  assert.equal(describeTriggers(wf({ branch: null })), 'manual only');
  assert.equal(describeDistribution(wf()), 'IOS archive → TestFlight + App Store');
  assert.equal(describeDistribution(wf({ actions: [{ type: 'ARCHIVE', platform: 'IOS', audience: 'INTERNAL_ONLY' }] })), 'IOS archive → TestFlight internal only');
  assert.equal(describeDistribution(wf({ actions: [{ type: 'TEST', platform: 'IOS' }] })), 'no archive (build/test only)');
});
