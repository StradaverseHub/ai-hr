/** Parent-operated, staging-only adapter. The candidate and its failed receipt are never edited. */
import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync,lstatSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual as equal} from 'node:util';
import {LOCAL_REPAIR as P,requireRepair,digest} from './local-environment-repair.mjs';
import {collectLocalEnvironmentRepair,loadFrozenModule,controllerDirectory,cleanRepairHead} from './local-environment-repair-evidence.mjs';

const STAGING=Object.freeze({alias:'aihr-staging',directory:'/opt/ai-hr',stateDirectory:'/var/tmp/aihr-deploy'});
function privateConfig(path){
 path=resolve(path);const stat=lstatSync(path);
 requireRepair(realpathSync(path)===path&&stat.isFile()&&!stat.isSymbolicLink()&&(stat.mode&0o077)===0,'SSH config must be a private canonical file');return path;
}
export function resolveStagingRepairAddress(sshConfig,run=execFileSync){
 sshConfig=privateConfig(sshConfig);
 const text=run('ssh',['-G','-F',sshConfig,STAGING.alias],{encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
 const get=key=>{const matches=text.split('\n').filter(line=>line.startsWith(key+' '));requireRepair(matches.length===1,'ambiguous SSH setting '+key);return matches[0].slice(key.length+1);};
 const address={hostname:get('hostname'),user:get('user'),port:get('port')};
 requireRepair(/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/.test(address.hostname)&&/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(address.user)&&/^\d+$/.test(address.port)&&+address.port>0&&+address.port<=65535,'invalid staging SSH address');
 return address;
}
export function stagingRepairTransport(official,sshConfig,run=execFileSync){
 sshConfig=privateConfig(sshConfig);
 const prefix=['-F',sshConfig,'-o','BatchMode=yes','-o','ConnectTimeout=12'];
 return {
  ssh:(command,options={})=>run('ssh',[...prefix,STAGING.alias,command],{encoding:'utf8',timeout:30000,maxBuffer:64*1024*1024,...options}),
  transfer:candidatePath=>{
   return run('rsync',official.deploymentRsyncArgs(candidatePath),{stdio:'inherit'});
  },
 };
}

/** Testable orchestration using the actual candidate command builders/follower and fixture I/O. */
export function deployRepairBuild({evidence,official,testingBuild,stableTestingJson,revalidate,assertBuildFrozen,transport,save,observation={}}){
 requireRepair(evidence.tier===P.tier&&evidence.policyVersion===P.version&&evidence.sha===P.candidate&&evidence.baseline===P.baseline&&evidence.originalResult==='FAIL','unverified local repair identity');
 revalidate('baseline');assertBuildFrozen();
 // Announcement failure is fatal. Do not transfer source after a failed pending record.
 transport.ssh(official.buildPendingCommand(evidence.sha),{stdio:'inherit'});
 revalidate('pending');assertBuildFrozen();
 transport.transfer(evidence.candidatePath);
 transport.ssh(official.buildTestingRecordCommand(evidence.sha,testingBuild.identity.buildRecordId),{input:stableTestingJson(testingBuild)+'\n',stdio:['pipe','inherit','inherit']});
 revalidate('pending');assertBuildFrozen();
 const launch=transport.ssh(official.buildLaunchCommand(evidence.sha,STAGING.directory,STAGING.stateDirectory,testingBuild.identity.buildRecordId));
 save('launch.json',{output:launch,testingBuildRecordId:testingBuild.identity.buildRecordId});
 const status=official.followDeploy({...observation,run:offset=>transport.ssh(official.buildFollowCommand(offset),{encoding:null,stdio:['ignore','pipe','inherit']})});
 save('remote-build-result.json',status);
 requireRepair(official.isSuccessState(status.state??'unknown')&&status.ref===evidence.sha&&status.built_ref===evidence.sha&&status.stale_build==='0'&&typeof status.built_build_id==='string'&&status.built_build_id.length>0,'remote build/migration failed, stale or wrong source');
 return status;
}

export async function operatorLocalEnvironmentRepair({candidatePath,originalDirectory,freshDirectory,sshConfig,execute=false}){
 candidatePath=resolve(candidatePath);
 sshConfig=privateConfig(sshConfig);
 requireRepair(!sshConfig.startsWith(candidatePath+'/'),'private SSH configuration must remain outside uploaded candidate');
 const address=resolveStagingRepairAddress(sshConfig);
 for(const [key,value] of Object.entries({IMPROVE_SSH_HOST:address.hostname,IMPROVE_SSH_USER:address.user,IMPROVE_SSH_PORT:address.port})){
  requireRepair(!process.env[key]||process.env[key]===value,'staging SSH override differs from selected private alias '+key);process.env[key]=value;
 }
 for(const [key,value] of Object.entries({IMPROVE_REMOTE_DIR:STAGING.directory,AIHR_DEPLOY_STATE_DIR:STAGING.stateDirectory})){
  requireRepair(!process.env[key]||process.env[key]===value,'unexpected release directory override '+key);process.env[key]=value;
 }
 const official=await loadFrozenModule(candidatePath,'scripts/improve/release.ts');
 const nativeRsync=official.deploymentRsyncArgs(candidatePath);
 requireRepair(nativeRsync.at(-1)===`${address.user}@${address.hostname}:${STAGING.directory}/`&&nativeRsync[nativeRsync.indexOf('-e')+1]===`ssh -p ${address.port} -o BatchMode=yes -o ConnectTimeout=12`,'frozen official rsync route differs from private staging alias');
 const baselineRules=await loadFrozenModule(candidatePath,'scripts/gate-impact-git.ts');
 const testing=await loadFrozenModule(candidatePath,'scripts/improve/system-testing-manifest.ts');
 const {stableTestingJson}=await loadFrozenModule(candidatePath,'lib/system-testing/hash.ts');
 const learning=await loadFrozenModule(candidatePath,'scripts/improve/release-learning.ts');
 const transport=stagingRepairTransport(official,sshConfig);
 const current=()=>official.parseDeployStatus(transport.ssh('cd /opt/ai-hr && deploy/deploy-state.sh status'));
 const baseline=baselineRules.readyProductionBaseline(current());
 requireRepair(baseline===P.baseline,'staging baseline moved');
 const alpha=()=>JSON.parse(execFileSync('gh',['api','repos/'+P.repository+'/git/ref/heads/alpha'],{encoding:'utf8',timeout:30000})).object?.sha;
 requireRepair([baseline,P.candidate].includes(alpha()),'alpha changed outside bounded release');
 const args={candidatePath,originalDirectory,freshDirectory,baseline};
 const evidence=await collectLocalEnvironmentRepair(args);
 const dir=join(controllerDirectory,'scratchpad','verified-local-port-repair-'+randomUUID());mkdirSync(dir,{recursive:true,mode:0o700});
 const save=(name,value)=>writeFileSync(join(dir,name),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
 save('verification.json',{...evidence,target:STAGING,execute,verifiedAt:new Date().toISOString()});
 if(!execute)return {...evidence,evidenceDirectory:dir};
 const prepared=testing.prepareSystemTestingBuild({worktree:candidatePath,candidate:evidence.sha,buildRecordId:randomUUID()});
 const buildDirectory=testing.systemTestingBuildDirectory('local');testing.ensurePrivateReleaseDirectory(buildDirectory);testing.publishSystemTestingBuild(prepared,buildDirectory);
 // Rebuild the complete source-derived proof once more immediately before entering the synchronous
 // announcement/transfer/launch sequence. Within it, all bound bytes are checked again without TS work.
 requireRepair(equal(await collectLocalEnvironmentRepair(args),evidence),'evidence changed after preparation');
 const revalidate=phase=>{
  requireRepair(cleanRepairHead(candidatePath)===evidence.sha&&cleanRepairHead(controllerDirectory)===evidence.controller,'source changed before deploy');
  for(const a of evidence.artifacts){const root={original:evidence.originalDirectory,fresh:evidence.freshDirectory,admission:evidence.admissionDirectory}[a.group];requireRepair(typeof root==='string','unknown archive group');const path=join(root,a.path),stat=lstatSync(path);requireRepair(stat.isFile()&&!stat.isSymbolicLink()&&realpathSync(path)===path&&stat.size===a.bytes&&digest(readFileSync(path))===a.sha256,'bound archive changed: '+a.group+'/'+a.path);}
  requireRepair(digest(readFileSync(join(candidatePath,'.gate-receipt.json')))===evidence.failedFullReceiptSha256,'original failed receipt changed');
  const status=current();
  if(phase==='baseline')requireRepair(baselineRules.readyProductionBaseline(status)===baseline,'staging baseline moved before announcement');
  else requireRepair(phase==='pending'&&status.state==='incomplete'&&status.ref===evidence.sha&&status.built_ref===baseline&&status.stale_build==='1','pending release/source identity changed before launch');
  requireRepair([baseline,evidence.sha].includes(alpha()),'alpha moved before launch');
 };
 const assertBuildFrozen=()=>requireRepair(stableTestingJson(testing.prepareSystemTestingBuild({worktree:candidatePath,candidate:evidence.sha,buildRecordId:prepared.identity.buildRecordId}))===stableTestingJson(prepared),'System Testing source changed');
 const status=deployRepairBuild({evidence,official,testingBuild:prepared,stableTestingJson,revalidate,assertBuildFrozen,transport,save});
 try{
  const record=learning.recordReleaseLearning({worktree:candidatePath,sha:evidence.sha,buildId:status.built_build_id,previousRef:baseline,receipt:{...evidence,result:'PASS'},status,
   mirror:value=>transport.ssh('cd /opt/ai-hr && AIHR_IMPACT_STATE_DIR=/var/tmp/aihr-deploy/impact-learning /opt/node20/bin/node --import tsx scripts/gate-learning-cli.ts record-release',{input:JSON.stringify(value)})});
  save('release-learning.json',record);
 }catch(error){save('release-learning-warning.json',{error:String(error)});console.warn('Build succeeded; release evidence mirror still needs attention: '+String(error));}
 // Completion remains with the release owner: restart, health, zero-diff arrival, migration ledger,
 // alpha reconciliation and truthful board writes. This adapter never marks an item deployed.
 return {...evidence,evidenceDirectory:dir,remoteBuild:status,testingBuildRecordId:prepared.identity.buildRecordId,arrivalVerified:false};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [mode,candidatePath,originalDirectory,freshDirectory,sshConfig]=process.argv.slice(2);
 requireRepair(['verify','deploy'].includes(mode)&&candidatePath&&originalDirectory&&freshDirectory&&sshConfig,'Usage: node --import <candidate-tsx-loader> local-environment-repair-operator.mjs <verify|deploy> <candidate> <original080> <fresh081> <private-ssh-config>');
 operatorLocalEnvironmentRepair({candidatePath,originalDirectory,freshDirectory,sshConfig,execute:mode==='deploy'}).then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(error);process.exitCode=1;});
}
