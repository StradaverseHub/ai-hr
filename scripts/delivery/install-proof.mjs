/** A separately named delivery-policy witness; never relabelled as the v17 full gate. */
import assert from 'node:assert/strict';
import {POLICY,exact,digest,sha,hash} from './protocol.mjs';
export const DELIVERY_INSTALL_KIND='OPERATOR_AUTHORIZED_DELIVERY_BUILD_INSTALL';
export function validateDeliveryGrantProof(proof,grant){
 exact(proof,['policy','candidate','policyDigest','planDigest','coverageDigest','checks','producersDigest','buildRunId','buildArtifactId','buildArtifactDigest','verifiedAt','fingerprint']);
 assert(proof.policy===POLICY&&proof.candidate===grant.source&&sha(proof.candidate));
 for(const k of ['policyDigest','planDigest','coverageDigest','producersDigest'])assert(digest(proof[k]));
 assert(Number.isSafeInteger(proof.checks)&&proof.checks>0&&proof.buildRunId===grant.runId&&proof.buildArtifactId===grant.artifact.id&&proof.buildArtifactDigest===grant.artifact.digest);
 const time=Date.parse(proof.verifiedAt);assert(Number.isFinite(time)&&time<=Date.parse(grant.issuedAt)&&Date.parse(grant.issuedAt)-time<=300000,'Fresh independently verified delivery evidence required');
 const {fingerprint,...body}=proof;assert(fingerprint===hash(body)&&fingerprint===grant.witnessFingerprint);return proof;
}
