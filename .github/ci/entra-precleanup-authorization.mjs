import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { installHash, installJson, validateInstallGrant } from './ci-install-grant.mjs';
import { selection } from './normal-cleanup-session.mjs';

export const previousReadySha256 = '101cb3f2aa936bfd4820221cb397dc3ac9d376202dc760512af804d44155fcf1';
const recoveryKind = 'ENTRA_PRE_CLEANUP_RECOVERY';
const lifetime = 45 * 60_000;
const expectedSelection = Object.freeze({
  source: '3b3f94ccdc7bc6e3396caf0db2d103244413b291',
  installId: 'b682ac51-b1b3-47e6-847c-669828231075',
  buildRecordId: '7a7558fb-7fac-44e4-9383-f6303f7fc29f',
  nextBuildId: '1AQBdvV3AEeCFPHC7c6M5',
  authorizationSha256: 'e17416d4fd5e5a61552df0d059d7e3a5e7be1e0b31ab455f228742f9ccf8442b',
});
const expectedLease = Object.freeze({
  batch: '89ea71ad-5a80-42af-9da2-25f60b5c3dd2',
  epoch: '36',
});

export function issueEntraRecoveryAuthorization({ grant, lease, evidence, now = Date.now() }) {
  const certificate = {
    kind: recoveryKind,
    selection: selection(grant),
    lease,
    previousReadySha256,
    evidenceSha256: installHash(installJson(evidence)),
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + lifetime).toISOString(),
  };
  return assertEntraRecoveryAuthorization(certificate, { grant, lease, evidence, now });
}

/** The expired grant identifies the installation. The active lease and fresh evidence authorize cleanup. */
export function assertEntraRecoveryAuthorization(certificate, { grant, lease, evidence, now = Date.now() }) {
  validateInstallGrant(grant, { allowExpired: true, now });
  assert(Date.parse(grant.expiresAt) <= now, 'Original installation grant must have expired');
  assert(isDeepStrictEqual(selection(grant), expectedSelection) && grant.runId === 41683594993,
    'Original Entra installation differs');
  assert(isDeepStrictEqual(lease, expectedLease), 'Exact replacement Entra staging lease required');
  assert(evidence?.sha === expectedSelection.source && Number(evidence.runId) === grant.runId &&
    evidence.result === 'PASS' && evidence.fingerprint === grant.witnessFingerprint,
    'Authenticated original gate evidence required');
  const checkedAt = Date.parse(evidence.verifiedAt);
  assert(Number.isFinite(checkedAt) && checkedAt <= now && now - checkedAt < lifetime,
    'Fresh original gate verification required');
  const issuedAt = Date.parse(certificate?.issuedAt);
  assert(Number.isFinite(issuedAt) && issuedAt >= checkedAt && issuedAt <= now && now - issuedAt < lifetime,
    'Fresh cleanup authorization required');
  assert(isDeepStrictEqual(certificate, {
    kind: recoveryKind,
    selection: expectedSelection,
    lease: expectedLease,
    previousReadySha256,
    evidenceSha256: installHash(installJson(evidence)),
    issuedAt: new Date(issuedAt).toISOString(),
    expiresAt: new Date(issuedAt + lifetime).toISOString(),
  }), 'Cleanup authorization binding differs');
  return certificate;
}
