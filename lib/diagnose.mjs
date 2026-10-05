// Pure helpers that turn Xcode Cloud symptoms into causes. No network: the
// callers fetch, these decide, and the tests feed them real log lines.

// Version states in which Apple has approved a version. Once a version is in
// one of these, its TestFlight train is closed: no more builds on it.
export const APPROVED_STATES = ['PENDING_DEVELOPER_RELEASE', 'PENDING_APPLE_RELEASE', 'PROCESSING_FOR_DISTRIBUTION', 'READY_FOR_DISTRIBUTION', 'ACCEPTED', 'REPLACED_WITH_NEW_VERSION'];

/** 1.11 → 1.11.1, 1.2.3 → 1.2.4. */
export function bumpPatch(v) {
  const p = String(v).split('.').map(Number);
  while (p.length < 3) p.push(0);
  p[2] += 1;
  return p.join('.');
}

/**
 * Xcode's provisioning chatter is full of "error:" that isn't an error: ObjC
 * selectors like `userAction:error:` and "due to error:" from a harmless
 * missing Capabilities directory. Keep compiler/tool diagnostics and failure
 * banners; drop the rest.
 */
const NOISE = /Failed to create Capabilities directory|IDEProvisioningRepair|DVTPortal|_evaluateCertificates|DVTServices:/;
const SIGNAL = /(?:^|[\s\]:])(?:error|fatal error):\s|\*\* (?:BUILD|ARCHIVE|TEST|EXPORT) FAILED|Command \S+ failed|exit code [1-9]|ITMS-\d+|closed for new build|must be higher than the previously|STATE_ERROR|ENTITY_ERROR/i;
export const isSignalLine = (line) => SIGNAL.test(line) && !NOISE.test(line);

/** "Exorcise 1.11 app-store.zip" → "1.11": the version an archive was stamped with. */
export function archiveVersion(artifactNames) {
  for (const n of artifactNames) {
    const m = n.match(/\s(\d+(?:\.\d+)+)\s+(?:app-store|ad-hoc|development|developer-id)\.zip$/);
    if (m) return m[1];
  }
  return null;
}

/**
 * Why an archive that built fine failed to reach App Store Connect.
 * @param {{ version: string|null, versionState: string|null }} facts
 */
export function diagnosePrepareFailure({ version, versionState }) {
  if (version && versionState && APPROVED_STATES.includes(versionState)) {
    return {
      cause: 'closed_train',
      summary: `Version ${version} is already approved (${versionState}), so its TestFlight train is closed and Apple refuses new builds on it. The archive built fine; the upload was rejected.`,
      fix: `Bump MARKETING_VERSION to ${bumpPatch(version)} in every target and push again.`,
    };
  }
  return {
    cause: 'upload_rejected',
    summary: 'The archive built, but App Store Connect rejected the upload.',
    fix: 'Usual causes: the build number is not above the last uploaded build, the version is not higher than the last approved one, or signing/entitlements changed. Check the version with review_status; run triage_run with log_excerpt for details.',
  };
}

/** MARKETING_VERSION values in a project.pbxproj, deduplicated. */
export function marketingVersions(pbxproj) {
  return [...new Set([...pbxproj.matchAll(/MARKETING_VERSION = "?([\d.]+)"?;/g)].map((m) => m[1]))];
}
