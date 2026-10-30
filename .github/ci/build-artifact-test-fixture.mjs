/** Tiny synthetic integrity data; these are never real build/test/release receipts. */
import {createHash} from 'node:crypto';
import {BUILD_CAPACITY_PROFILE} from './build-production.mjs';
export const fixtureHash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function buildPacketFixture(expected={}){
 const source=expected.candidate??'a'.repeat(40),controller=expected.controller??'c'.repeat(40),runId=expected.runId??123,branch=expected.controllerBranch??'main';
 const prepared={format:1,identity:{sourceRef:source,buildRecordId:'00000000-0000-4000-8000-000000000001',catalogueHash:'c'.repeat(64),contentHash:'d'.repeat(64)},sourceHashRecord:[],activeServiceVerified:false};
 const preparedBytes=Buffer.from(JSON.stringify(prepared)+'\n'),archive=Buffer.from('synthetic-not-a-build-archive');
 const startedAt=expected.producerStartedAt??'2026-10-26T00:00:00.000Z',completedAt=expected.producerCompletedAt??'2026-10-26T00:01:00.000Z';
 const manifest={format:2,capacityProfile:{...BUILD_CAPACITY_PROFILE},kind:'next-build-byte-bundle',platform:'linux',nextBuildId:'fixture-build',archiveBytes:archive.length,archiveSha256:fixtureHash(archive)};
 const observation={format:1,kind:'successful-system-testing-build',identity:prepared.identity,preparedRecordSha256:fixtureHash(preparedBytes),nextBuildId:'fixture-build',buildStartedAt:startedAt,observedAt:completedAt,platform:'linux',arch:'x64',activeServiceVerified:false,manualExecutionVerified:false};
 const manifestBytes=Buffer.from(JSON.stringify(manifest)+'\n'),observationBytes=Buffer.from(JSON.stringify(observation)+'\n');
 const lockBytes=Buffer.from('synthetic-lock'),packageBytes=Buffer.from('synthetic-package');
 const provenance={format:2,capacityProfile:{...BUILD_CAPACITY_PROFILE},kind:'ci-system-testing-build-candidate',source,controller,repository:'StradaverseHub/ai-hr',repositoryId:1333414856,runId,runAttempt:1,
 workflowRef:'StradaverseHub/ai-hr/.github/workflows/alpha-staging.yml@refs/heads/'+branch,runtime:{node:'22.23.3',abi:'127',platform:'linux',arch:'x64',glibc:'2.39',next:'16.3.8'},
 buildRecordId:prepared.identity.buildRecordId,nextBuildId:manifest.nextBuildId,buildSourcePath:'/home/runner/work/ai-hr/ai-hr/source',releaseAuthorized:false,
 lockSha256:fixtureHash(lockBytes),packageSha256:fixtureHash(packageBytes),preparedSha256:fixtureHash(preparedBytes),successfulObservationSha256:fixtureHash(observationBytes),
 manifestSha256:fixtureHash(manifestBytes),archiveSha256:manifest.archiveSha256,archiveBytes:archive.length};
 return {entries:{'build-provenance.json':Buffer.from(JSON.stringify(provenance)+'\n'),'system-testing.json':preparedBytes,'successful-build.json':observationBytes,
 'bytes/build-bundle-files.json':manifestBytes,'bytes/build-bundle.tar.gz':archive},
 expected:{candidate:source,controller,runId,controllerBranch:branch,producerStartedAt:startedAt,producerCompletedAt:completedAt},provenance,
 source:{lockBytes,packageBytes,preparedBytes}};
}
