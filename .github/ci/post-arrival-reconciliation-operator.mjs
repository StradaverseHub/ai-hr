/** Explicit post-arrival recovery. Authenticates original CI; never installs or restarts an app. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {cleanHead} from './release-ci.mjs';
import {stagingTransport} from './staging-transport.mjs';
import {expectedMigrationLedger} from './staging-migration-ledger.mjs';
import {validateInstalledArrival,validateFinalCleanup} from './staging-ci-promotion.mjs';
import {validateInstallGrant,installJson,installHash} from './ci-install-grant.mjs';
import {readLease,guardCommand,leasePhase,redactLeaseError} from '../../scripts/staging/lease.mjs';
import {controllerInventoryEntry,controllerLaunchCheck} from './reconciliation-controller-inventory.mjs';
import {createReconciliationAuthority,validateReconciliationReady,createReconciliationCommit,RESULT_KIND} from './post-arrival-reconciliation-policy.mjs';
import {openNormalCleanupChannel,waitForRealReadyClock} from './normal-cleanup-operator.mjs';
const ROOT=fileURLToPath(new URL('../../',import.meta.url)),quote=v=>"'"+v.replaceAll("'","'\"'\"'")+"'";
const ALLOWED=['.github/ci/staging-build-install.mjs','.github/ci/post-arrival-reconciliation-policy.mjs','.github/ci/reconciliation-controller-inventory.mjs','.github/ci/post-arrival-reconciliation-server.mjs','.github/ci/post-arrival-reconciliation-operator.mjs','.github/ci/post-arrival-reconciliation.test.mjs','.github/workflows/alpha-staging.yml','docs/CI-POST-ARRIVAL-RECONCILIATION.md'];
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',maxBuffer:64*1024**2}).trim();
const api=path=>JSON.parse(execFileSync('gh',['api','repos/StradaverseHub/ai-hr/'+path],{encoding:'utf8',maxBuffer:16*1024**2,timeout:60000}));
export function validateReconciliationDiagnostics(run,jobs,controller){
 assert(run?.repository?.id===1333414856&&run.head_repository?.id===1333414856&&run.head_sha===controller&&run.event==='workflow_dispatch'&&run.run_attempt===1&&run.status==='completed'&&run.conclusion==='success'&&run.path==='.github/workflows/alpha-staging.yml','Successful authenticated reconciliation controller workflow required');
 assert(Date.now()-Date.parse(run.created_at)<=86400000,'Fresh reconciliation diagnostics required');
 const resolve=jobs.filter(j=>j.name==='resolve');assert(resolve.length===1&&resolve[0].head_sha===controller&&resolve[0].run_id===run.id&&resolve[0].run_attempt===1&&resolve[0].conclusion==='success','Actual hosted controller resolve job required');
 assert(resolve[0].steps?.some(s=>s.name==='Post-arrival reconciliation refusal checks'&&s.conclusion==='success')&&resolve[0].steps.some(s=>s.name==='CI integrity regression checks'&&s.conclusion==='success'),'Actual reconciliation and unchanged controller refusal regressions required');
 const hold=jobs.filter(j=>j.name==='deployment-hold');
 assert(hold.length===1&&hold[0].head_sha===controller&&hold[0].run_id===run.id&&hold[0].run_attempt===1&&hold[0].conclusion==='success'&&hold[0].steps?.some(s=>s.name==='Deployment remains disabled'&&s.conclusion==='success'),'Hosted deployment hold must confirm disabled switches');
 assert(jobs.every(j=>j.name==='resolve'||j.name==='deployment-hold'||j.conclusion==='skipped'),'Controller-only diagnostic must not masquerade as an application witness');return true;
}
export async function reconcilePostArrival({candidatePath,trustedControllerPath,runId,diagnosticsRunId,originalGrantPath,initializationPath}){
 try{return await reconcile({candidatePath:resolve(candidatePath),trustedControllerPath:resolve(trustedControllerPath),runId:Number(runId),diagnosticsRunId:Number(diagnosticsRunId),originalGrantPath,initializationPath});}catch(error){throw redactLeaseError(error);}
}
async function reconcile({candidatePath,trustedControllerPath,runId,diagnosticsRunId,originalGrantPath,initializationPath}){
 const controller=cleanHead(ROOT),candidate=cleanHead(candidatePath),grant=validateInstallGrant(JSON.parse(readFileSync(originalGrantPath)),{allowExpired:true});
 assert(process.env.AIHR_RECONCILIATION_REVIEWED_CONTROLLER===controller,'Exact independently reviewed recovery controller required');
 assert(candidate===grant.source&&cleanHead(trustedControllerPath)===grant.controller&&runId===grant.runId,'Exact original source and trusted CI controller required');
 const changed=git(ROOT,'diff','--name-only',grant.controller,controller).split('\n').filter(Boolean);assert(changed.length>0&&changed.every(p=>ALLOWED.includes(p)),'Recovery controller changes exceed the reviewed finite scope');
 assert(git(ROOT,'merge-base',grant.controller,controller)===grant.controller,'Recovery controller must preserve trusted controller ancestry');
 const jobsReply=api(`actions/runs/${diagnosticsRunId}/jobs?filter=all&per_page=100`);assert(jobsReply.total_count===jobsReply.jobs.length,'Complete bounded diagnostic job inventory required');
 validateReconciliationDiagnostics(api(`actions/runs/${diagnosticsRunId}`),jobsReply.jobs,controller);
 const trusted=await import(pathToFileURL(join(trustedControllerPath,'.github/ci/release-ci.mjs')).href);
 const evidence=await trusted.verifyCi({candidatePath,runId,baseline:grant.baseline});
 assert(evidence.fingerprint===grant.witnessFingerprint,'Original full-CI witness differs');
 const lease=readLease(candidate),transport=stagingTransport(candidatePath),dir=join(ROOT,'scratchpad','post-arrival-reconciliation-'+randomUUID());mkdirSync(dir,{recursive:true,mode:0o700});
 const save=(name,data)=>writeFileSync(join(dir,name),JSON.stringify(data,null,2)+'\n',{mode:0o600,flag:'wx'});
 const sshRaw=(command,options={})=>execFileSync('ssh',transport.sshArgs(command),{encoding:'utf8',timeout:30000,maxBuffer:4*1024**2,stdio:['pipe','pipe','pipe'],...options});
 const ssh=(command,options={})=>sshRaw(guardCommand(lease,command),options);
 const imported=await import(pathToFileURL(join(candidatePath,'scripts/improve/release.ts')).href),official={...(imported.default??{}),...imported};
 const current=()=>official.parseDeployStatus(ssh('cd /opt/ai-hr && deploy/deploy-state.sh status'));
 const healthy=state=>assert(state.state==='ok'&&state.ref===candidate&&state.built_ref===candidate&&state.build_id===grant.build.nextBuildId&&state.built_build_id===grant.build.nextBuildId&&state.stale_build==='0','Exact completed healthy original installation required');healthy(current());
 const initialized=JSON.parse(readFileSync(initializationPath));assert(initialized.installId===grant.installId&&initialized.authorizationSha256===installHash(installJson(grant)+'\n'),'Original private initialization differs');
 const remoteInstall=initialized.packetDirectory?.replace(/\/packet$/,'');assert(typeof remoteInstall==='string'&&/^\/[A-Za-z0-9_./-]+\/\.aihr-ci-builds\/[a-f0-9-]{36}$/.test(remoteInstall)&&remoteInstall.endsWith('/'+grant.installId)&&!remoteInstall.split('/').some(v=>v==='.'||v==='..'),'Exact original private installation path required');
 const remote=remoteInstall+'/reconciliation-controller-'+controller+'-'+randomUUID();
 const bundle=execFileSync('git',['archive','--format=tar',controller,'.github/ci','scripts/staging'],{cwd:ROOT,maxBuffer:64*1024**2});
 const marker=installJson({source:controller,kind:'PRIVATE_REVIEWED_RECONCILIATION_CONTROLLER'})+'\n';
 const tree=git(ROOT,'ls-tree','-r','--format=%(objectmode) %(path)',controller,'--','.github/ci','scripts/staging').split('\n').map(line=>{const at=line.indexOf(' '),mode=line.slice(0,at),path=line.slice(at+1);assert(['100644','100755'].includes(mode),'Controller archive symlinks refused');return controllerInventoryEntry(path,readFileSync(join(ROOT,path)),mode==='100755'?0o755:0o644);});
 const inventory={format:1,kind:'REVIEWED_PRIVATE_RECONCILIATION_EXECUTABLE_INVENTORY',controller,entries:[...tree,controllerInventoryEntry('controller.tar',bundle,0o600),controllerInventoryEntry('reconciliation-controller.json',Buffer.from(marker),0o600)]};
 const controllerInventorySha256=installHash(installJson(inventory));save('controller-executable-inventory.json',inventory);
 const bundleHash=installHash(bundle);save('controller-bundle.json',{controller,sha256:bundleHash,bytes:bundle.length,remote});
 const setup='set -eu; umask 077; mkdir '+quote(remote)+'; cat > '+quote(remote+'/controller.tar')+'; test "$(sha256sum '+quote(remote+'/controller.tar')+' | cut -d " " -f 1)" = '+quote(bundleHash)+'; umask 022; tar -xf '+quote(remote+'/controller.tar')+' -C '+quote(remote)+'; umask 077; printf %s '+quote(marker)+' > '+quote(remote+'/reconciliation-controller.json');
 ssh(setup,{input:bundle,timeout:120000});
 ssh('set -eu; umask 077; set -C; cat > '+quote(remote+'/controller-inventory.json'),{input:installJson(inventory)+'\n'});
 const command=mode=>'set -eu; '+controllerLaunchCheck(remote,controllerInventorySha256)+'cd /opt/ai-hr && /opt/node22/bin/node --env-file=.env.production --import tsx '+quote(remote+'/.github/ci/post-arrival-reconciliation-server.mjs')+' '+mode+' '+candidate+' '+grant.installId+' '+grant.build.buildRecordId;
 const installed=JSON.parse(ssh(command('inspect'),{timeout:900000}));save('installed-before-cleanup.json',installed);
 const expectedLedger=expectedMigrationLedger(candidatePath),arrival=validateInstalledArrival(installed,grant,expectedLedger);
 const checksum=()=>execFileSync('rsync',['--dry-run','--checksum','--itemize-changes',...transport.rsyncArgs(official,candidatePath)],{encoding:'utf8',timeout:180000,maxBuffer:16*1024**2});
 await trusted.revalidateCi(evidence);const ciRevalidatedAt=new Date().toISOString();
 const output=checksum(),checkedAt=new Date().toISOString();save('source-arrival-before-authority.json',{source:candidate,output,checkedAt});
 const authority=createReconciliationAuthority({grant,evidence,controller,diagnosticsRunId,controllerInventorySha256,lease,installed,output,checkedAt,ciRevalidatedAt});save('cleanup-only-authority.json',authority);
 const authorityPath=remoteInstall+'/post-arrival-reconciliation-authority.json';
 const published=JSON.parse(ssh(command('publish'),{input:installJson(authority)+'\n'}));assert(published.published===true&&published.authoritySha256===installHash(installJson(authority)),'Durable owned authority publication required');save('authority-published.json',published);
 const channel=openNormalCleanupChannel(transport.sshArgs(guardCommand(lease,command('cleanup')+' '+quote(authorityPath))),{terminalTimeout:3600000});
 let reply;
 try{
  const raw=await channel.frames.next();await waitForRealReadyClock(raw);const ready=validateReconciliationReady(raw,authority,grant);save('cleanup-ready.json',ready);
  assert(cleanHead(ROOT)===controller&&cleanHead(candidatePath)===candidate,'Frozen recovery source moved');await trusted.revalidateCi(evidence);
  const fresh=checksum(),at=new Date().toISOString();save('source-arrival-after-ready.json',{source:candidate,output:fresh,checkedAt:at});
  const commit=createReconciliationCommit(ready,authority,grant,{output:fresh,checkedAt:at});save('cleanup-commit.json',commit);channel.stdin.end(installJson(commit)+'\n');
  const frame=await channel.frames.next();assert(frame?.format===1&&frame.kind===RESULT_KIND&&Object.keys(frame).sort().join(',')==='format,kind,result','Exact reconciliation terminal result required');
  await channel.success();reply=frame.result;save('owned-cleanup.json',reply);
 }catch(error){channel.stdin.end();save('incomplete.json',{retainLease:true,reconcileBeforeRetry:true,error:String(error)});throw error;}
 const finalArrival=validateFinalCleanup(reply,{grant,installed,expectedLedger});const finalChecksum=checksum();assert(finalChecksum==='','Final canonical source checksum differs');save('final-source-arrival.json',{source:candidate,output:finalChecksum,checkedAt:new Date().toISOString()});
 const state=current();healthy(state);assert(cleanHead(ROOT)===controller&&cleanHead(candidatePath)===candidate,'Frozen recovery source moved');
 leasePhase(lease,sshRaw,'arrived',grant.build.nextBuildId);
 const result={...evidence,remoteBuild:state,installId:grant.installId,testingBuildRecordId:grant.build.buildRecordId,arrival:finalArrival,arrivalVerified:true,ownedResourceCleanupVerified:true,releaseHandbackVerified:false,
  reconciliation:{policy:authority.policy,controller,diagnosticsRunId,originalGrantExpiresAt:grant.expiresAt,authoritySha256:installHash(installJson(authority)),evidenceDirectory:dir}};
 save('reconciliation-result.json',result);return result;
}
