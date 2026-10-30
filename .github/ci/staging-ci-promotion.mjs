/** Shared promotion sequence. Production callers supply actual authenticated evidence and candidate helpers. */
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {createInstallGrant,validateInstallGrant,installJson,installHash} from './ci-install-grant.mjs';
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
export function stagingInstallerCommand(mode,sourceRef,installId,buildRecordId){
 assert(['initialize','status','cleanup','cleanup-session'].includes(mode),'Operator may initialize or inspect; deploy spine owns stage/activation');
 if(mode==='initialize')return 'cd /opt/ai-hr && /opt/node22/bin/node .github/ci/staging-build-install.mjs initialize';
 assert(/^[a-f0-9]{40}$/.test(sourceRef)&&uuid(installId)&&uuid(buildRecordId),'Exact frozen installer selection required');
 return 'cd /opt/ai-hr && /opt/node22/bin/node --env-file=.env.production --import tsx .github/ci/staging-build-install.mjs '+mode+' '+sourceRef+' '+installId+' '+buildRecordId;
}
export function validateInstallAcknowledgement(reply,grant){
 validateInstallGrant(grant);
 assert(reply&&Object.keys(reply).sort().join(',')==='authorizationSha256,installId,packetDirectory,releaseAuthorized'
  &&reply.installId===grant.installId&&reply.releaseAuthorized===false
  &&reply.authorizationSha256===installHash(Buffer.from(installJson(grant)+'\n')),'Private installation acknowledgement differs');
 const packet=reply.packetDirectory;
 assert(typeof packet==='string'&&/^\/[A-Za-z0-9_./-]+$/.test(packet)&&packet.split('/').every(p=>p!=='.'&&p!=='..')
  &&packet.endsWith('/.aihr-ci-builds/'+grant.installId+'/packet'),'Canonical owned installation packet destination required');
 return reply;
}
export function validatePrelaunchState(state,{baseline,baselineBuildId,candidate,announced=false}){
 assert(state.built_ref===baseline&&state.built_build_id===baselineBuildId&&state.build_id===baselineBuildId,'Baseline bytes or successful origin moved before launch');
 if(announced)assert(state.state==='incomplete'&&state.ref===candidate&&state.stale_build==='1','Expected source-pending state required before detached launch');
 else assert(state.state==='ok'&&state.ref===baseline&&state.stale_build==='0','Initially ready exact baseline required');
 return state;
}
export async function transferAndLaunchCiBuild({grant,evidence,official,ssh,transferSource,transferPacket,frozen,revalidate,save,pendingCommand}){
 validateInstallGrant(grant);
 assert(grant.source===evidence.sha&&grant.controller===evidence.controller&&grant.runId===evidence.runId&&evidence.build.canonicalCandidateInputsVerified===true,'Authenticated frozen evidence differs');
 frozen();await revalidate();frozen();
 ssh(pendingCommand,{stdio:'inherit'});
 transferSource();frozen();
 const acknowledgement=validateInstallAcknowledgement(JSON.parse(ssh(stagingInstallerCommand('initialize'),{input:installJson(grant)+'\n'})),grant);
 save('installation-grant.json',grant);save('installation-initialized.json',acknowledgement);
 transferPacket(join(evidence.evidenceDirectory,'production-build-v1'),acknowledgement.packetDirectory);
 frozen();await revalidate({announced:true});frozen();
 const command=official.buildLaunchCommand(grant.source,'/opt/ai-hr','/var/tmp/aihr-deploy',grant.build.buildRecordId,grant.installId);
 assert(command.split('--ci-build='+grant.installId).length===2&&command.split('--testing-build-record='+grant.build.buildRecordId).length===2,'Candidate launcher must select the CI installation and ORIGINAL baked record');
 const output=ssh(command);
 save('launch.json',{output,installId:grant.installId,testingBuildRecordId:grant.build.buildRecordId,nextBuildId:grant.build.nextBuildId});
 return {grant,acknowledgement,output};
}
export function validateInstalledArrival(status,grant,expectedLedger){
 assert(status?.authorizationSha256===installHash(Buffer.from(installJson(grant)+'\n'))&&status.releaseAuthorized===false,'Recipient installation grant differs');
 for(const record of [status.verified,status.activated,status.runtime]){
  assert(record?.source===grant.source&&record.installId===grant.installId&&record.buildRecordId===grant.build.buildRecordId&&record.nextBuildId===grant.build.nextBuildId&&record.authorizationSha256===status.authorizationSha256,'Recipient build tuple differs');
 }
 const runtime=status.runtime,observed=Date.parse(runtime.verifiedAt);
 assert(runtime.healthStatus===200&&/^[1-9][0-9]*$/.test(runtime.pid)&&Number.isSafeInteger(runtime.startedMonotonicUs)&&runtime.startedMonotonicUs>=status.activated.afterActivationMonotonicUs
  &&Number.isFinite(observed)&&observed<=Date.now()+60000&&Date.now()-observed<=60000,'Fresh post-activation runtime/health proof required');
 const inventory=runtime.compiledByteInventory;
 assert(inventory?.kind==='next-build-byte-bundle'&&inventory.releaseAuthorized===false&&inventory.runtimeCacheExcluded===true&&Number.isSafeInteger(inventory.files)&&inventory.files>0,'Actual complete immutable compiled-byte inventory required');
 const ledger=runtime.migrationLedger;
 assert(ledger?.kind==='READ_ONLY_EXACT_MIGRATION_LEDGER_NOT_RELEASE'&&ledger.releaseAuthorized===false&&ledger.rows===expectedLedger.length
  &&ledger.expectedSha256===installHash(installJson(expectedLedger))&&/^[a-f0-9]{64}$/.test(ledger.actualSha256),'Exact actual candidate migration ledger proof required');
 return {source:grant.source,installId:grant.installId,buildRecordId:grant.build.buildRecordId,nextBuildId:grant.build.nextBuildId,pid:runtime.pid,healthStatus:200,compiledByteInventory:inventory,migrationLedger:ledger,verifiedAt:runtime.verifiedAt};
}
export function validateFinalCleanup(reply,{grant,installed,expectedLedger}){
 assert(reply?.kind==='CI_INSTALL_OWNED_CLEANUP_AND_FINAL_RUNTIME_VERIFIED'&&reply.source===grant.source&&reply.installId===grant.installId&&reply.buildRecordId===grant.build.buildRecordId&&reply.nextBuildId===grant.build.nextBuildId
  &&reply.authorizationSha256===installed.authorizationSha256&&reply.ownedResourceCleanupVerified===true&&reply.releaseHandbackVerified===false,'Exact final owned-cleanup result required');
 const cleanup=reply.cleanup;
 assert(cleanup?.kind==='OWNED_INSTALL_BYTES_ABSENT_AUDIT_RETAINED'&&cleanup.installId===grant.installId&&cleanup.source===grant.source&&cleanup.nextBuildId===grant.build.nextBuildId&&cleanup.authorizationSha256===reply.authorizationSha256
  &&JSON.stringify(cleanup.verifiedAbsent)===JSON.stringify(['next','packet'])&&cleanup.auditEvidenceRetained===true&&installJson(cleanup.activeDirectory)===installJson(installed.activated.activation.activeDirectory),'Both owned resource trees must be absent with audit retained');
 return validateInstalledArrival({...installed,runtime:reply.runtime},grant,expectedLedger);
}
export function installationGrantFromVerifiedFiles({evidence,run,jobs,baselineBuildId,environmentSha256}){
 const producers=jobs.filter(j=>j.name==='build');assert(producers.length===1,'Unique authenticated original build job required');
 return createInstallGrant({evidence,run,producer:producers[0],baselineBuildId,environmentSha256});
}
