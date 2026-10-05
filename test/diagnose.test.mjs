import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSignalLine, archiveVersion, diagnosePrepareFailure, marketingVersions, bumpPatch } from '../lib/diagnose.mjs';

// Shapes taken from a real Xcode Cloud log bundle (paths shortened).
const noise = [
  '2026-10-05T19:28:02.914Z\txcodebuild[3184:16180]  DVTServices: Failed to create Capabilities directory in user data at "/Users/local/Library/Developer/Xcode/UserData/Capabilities" due to error: "Error Domain=NSCocoaErrorDomain Code=4"',
  '2026-10-05 19:28:03 +0000 IDEProvisioningRepair(App.app): -[IDEProvisioningRepairStepGenerator_Automatic _evaluateCertificatesWithSession:context:repairable:steps:userAction:error:]: 1 certificates on portal',
];
const signal = [
  '/Volumes/workspace/repository/App/Foo.swift:12:5: error: cannot find \'bar\' in scope',
  '** ARCHIVE FAILED **',
  'ERROR ITMS-90062: This bundle is invalid. The value for key CFBundleShortVersionString [1.11] must contain a higher version than that of the previously approved version [1.11].',
];

test('isSignalLine drops provisioning chatter, keeps real failures', () => {
  for (const l of noise) assert.equal(isSignalLine(l), false, l.slice(0, 60));
  for (const l of signal) assert.equal(isSignalLine(l), true, l.slice(0, 60));
});

test('archiveVersion reads the version from export artifact names', () => {
  assert.equal(archiveVersion(['App Build 113 Archive for App on iOS.xcarchive.zip', 'App 1.11 app-store.zip']), '1.11');
  assert.equal(archiveVersion(['My App 2.4.1 ad-hoc.zip']), '2.4.1');
  assert.equal(archiveVersion(['logs.zip']), null);
});

test('an approved version diagnoses as a closed train with the next version', () => {
  const d = diagnosePrepareFailure({ version: '1.11', versionState: 'READY_FOR_DISTRIBUTION' });
  assert.equal(d.cause, 'closed_train');
  assert.match(d.fix, /1\.11\.1/);
  assert.equal(diagnosePrepareFailure({ version: '1.12', versionState: 'PREPARE_FOR_SUBMISSION' }).cause, 'upload_rejected');
  assert.equal(diagnosePrepareFailure({ version: null, versionState: null }).cause, 'upload_rejected');
});

test('marketingVersions dedupes pbxproj values, quoted or not', () => {
  const pbx = 'MARKETING_VERSION = 1.11;\nMARKETING_VERSION = 1.11;\nMARKETING_VERSION = "2.0";';
  assert.deepEqual(marketingVersions(pbx), ['1.11', '2.0']);
  assert.equal(bumpPatch('1.11'), '1.11.1');
  assert.equal(bumpPatch('2.4.9'), '2.4.10');
});
