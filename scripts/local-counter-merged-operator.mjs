/** Parent-operated staging build under one explicit owner exception; no fabricated full PASS. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,lstatSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual as equal} from 'node:util';
import {sha256} from './local-counter-exception.mjs';
import {MERGED_EXCEPTION as P} from './local-counter-merged-acceptance.mjs';
import {ACCEPTANCE_TIER,collectOwnerMergedAcceptance as collectOwnerCounterAcceptance} from './local-counter-merged-acceptance.mjs';
export const controllerDirectory=fileURLToPath(new URL('../',import.meta.url)).replace(/\/$/,'');
const TARGET=Object.freeze({alias:'aihr-staging',directory:'/opt/ai-hr',stateDirectory:'/var/tmp/aihr-deploy'});
const ALIGNED_BASE=P.aligned;
const requireProof=(v,why)=>assert(v,'Owner exception operator refused: '+why);
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',timeout:30000,maxBuffer:16*1024*1024}).trim();
const cleanHead=cwd=>{const head=git(cwd,'rev-parse','HEAD');requireProof(/^[a-f0-9]{40}$/.test(head)&&!git(cwd,'status','--porcelain'),'dirty or missing source');return head;};
const load=async(root,path)=>{const value=await import(pathToFileURL(join(root,path)).href);return {...(value.default??{}),...value};};
function privateConfig(path){path=resolve(path);const stat=lstatSync(path);requireProof(realpathSync(path)===path&&stat.isFile()&&!stat.isSymbolicLink()&&(stat.mode&0o077)===0,'SSH config must be a private canonical regular file');return path;}
export function counterExceptionFlow({evidence,official,testingBuild,stableTestingJson,revalidate,assertBuildFrozen,transport,save}) {
  requireProof(evidence.tier===ACCEPTANCE_TIER&&evidence.result==='ACCEPTED_WITH_OWNER_EXCEPTION'&&evidence.stagingBuildAuthorized===true&&(evidence.canonicalResult==='FAIL'||evidence.canonicalResult==='INCOMPLETE_CANCELLED'&&evidence.composedFromCancelledPrefix===true&&evidence.controller?.partialOriginalBatch9Excluded===true)
    &&evidence.originalCandidate===P.candidate&&evidence.rawVitestExit==='UNKNOWN_NOT_SEPARATELY_RECORDED'&&evidence.sourceBoundary.counterRepairApplied===true,'unvalidated exception');
  revalidate('baseline');assertBuildFrozen();
  transport.ssh(official.buildPendingCommand(evidence.candidate),{stdio:'inherit'});
  revalidate('pending');assertBuildFrozen();transport.transfer(evidence.candidatePath);
  transport.ssh(official.buildTestingRecordCommand(evidence.candidate,testingBuild.identity.buildRecordId),{input:stableTestingJson(testingBuild)+'\n',stdio:['pipe','inherit','inherit']});
  revalidate('pending');assertBuildFrozen();
  const launch=transport.ssh(official.buildLaunchCommand(evidence.candidate,TARGET.directory,TARGET.stateDirectory,testingBuild.identity.buildRecordId));
  save('launch.json',{output:launch,testingBuildRecordId:testingBuild.identity.buildRecordId});
  const status=official.followDeploy({run:offset=>transport.ssh(official.buildFollowCommand(offset),{encoding:null,stdio:['ignore','pipe','inherit']})});
  requireProof(official.isSuccessState(status.state??'unknown')&&status.ref===evidence.candidate&&status.built_ref===evidence.candidate&&status.stale_build==='0'&&typeof status.built_build_id==='string'&&status.built_build_id.length>0,'remote build/migration failed, stale or wrong source');
  save('remote-build-result.json',status);return status;
}
export const COUNTER_MIRROR_SCRIPT=String.raw`const fs=require('node:fs');const v=JSON.parse(fs.readFileSync(0,'utf8'));if(v.kind!=='OWNER_COUNTER_EXCEPTION_RELEASE_EVIDENCE'||!/^[a-f0-9]{40}$/.test(v.evidence.candidate))throw Error('Invalid exception envelope');const d='/var/tmp/aihr-deploy/owner-exceptions',p=d+'/'+v.evidence.candidate+'.json',text=JSON.stringify(v)+'\n';fs.mkdirSync(d,{recursive:true,mode:0o700});try{fs.writeFileSync(p,text,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST'||fs.readFileSync(p,'utf8')!==text)throw e;}`;
const shellQuote=value=>"'"+value.replaceAll("'","'\\''")+"'";
export function validateMergedLedger(rows,expected) {
  requireProof(Array.isArray(rows)&&Array.isArray(expected)&&rows.length===496&&expected.length===496
    &&rows.every((row,i)=>Number.isSafeInteger(row.id)&&row.id>0&&(i===0||rows[i-1].id<row.id)
      &&/^[a-f0-9]{64}$/.test(row.hash)&&/^\d+$/.test(row.created_at))&&equal(rows,expected),'staging migration ledger changed');
  return true;
}
export const counterMirrorCommand=()=>'/opt/node20/bin/node -e '+shellQuote(COUNTER_MIRROR_SCRIPT);
export function bindCounterTransfer(native,address,sshConfig,candidatePath) {
  const at=native.indexOf('-e');
  requireProof(at>=0&&native.lastIndexOf('-e')===at&&native[at+1]===`ssh -p ${address.port} -o BatchMode=yes -o ConnectTimeout=12`
    &&native.at(-1)===`${address.user}@${address.hostname}:${TARGET.directory}/`&&native.at(-2)===candidatePath.replace(/\/?$/,'/')
    &&native.includes('/scratchpad/'),'official transfer source/route/filter differs');
  const bound=[...native];bound[at+1]='ssh -F '+shellQuote(sshConfig)+' -o BatchMode=yes -o ConnectTimeout=12';
  bound[bound.length-1]=TARGET.alias+':'+TARGET.directory+'/';return bound;
}
export const COUNTER_TRANSFER_TIMEOUT_MS=300000;
export const counterTransport=(args,ssh,run=execFileSync)=>({ssh,transfer:()=>run('rsync',args,{stdio:'inherit',timeout:COUNTER_TRANSFER_TIMEOUT_MS,killSignal:'SIGTERM'})});
export async function operatorCounterException({candidatePath,runDirectory,counterRoot,sshConfig,execute=false}) {
  candidatePath=resolve(candidatePath);runDirectory=resolve(runDirectory);counterRoot=resolve(counterRoot);sshConfig=privateConfig(sshConfig);
  const controller=cleanHead(controllerDirectory);
  requireProof(!sshConfig.startsWith(candidatePath+'/'),'private SSH config inside upload candidate');
  const settings=execFileSync('ssh',['-G','-F',sshConfig,TARGET.alias],{encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
  const get=name=>{const rows=settings.split('\n').filter(l=>l.startsWith(name+' '));requireProof(rows.length===1,'ambiguous SSH '+name);return rows[0].slice(name.length+1);};
  const address={hostname:get('hostname'),user:get('user'),port:get('port')};
  requireProof(/^[A-Za-z0-9][A-Za-z0-9.:-]*$/.test(address.hostname)&&/^[A-Za-z_][A-Za-z0-9_-]*$/.test(address.user)&&/^\d+$/.test(address.port)&&+address.port>0&&+address.port<=65535,'invalid SSH address');
  for(const [key,value] of Object.entries({IMPROVE_SSH_HOST:address.hostname,IMPROVE_SSH_USER:address.user,IMPROVE_SSH_PORT:address.port,IMPROVE_REMOTE_DIR:TARGET.directory,AIHR_DEPLOY_STATE_DIR:TARGET.stateDirectory})) {
    requireProof(!process.env[key]||process.env[key]===value,'inherited target override differs');process.env[key]=value;
  }
  const official=await load(candidatePath,'scripts/improve/release.ts'),testing=await load(candidatePath,'scripts/improve/system-testing-manifest.ts');
  const {stableTestingJson}=await load(candidatePath,'lib/system-testing/hash.ts');
  const learning=await load(candidatePath,'scripts/improve/release-learning.ts'),baselineRules=await load(candidatePath,'scripts/gate-impact-git.ts');
  const rsync=bindCounterTransfer(official.deploymentRsyncArgs(candidatePath),address,sshConfig,candidatePath);
  const configHash=sha256(readFileSync(sshConfig));
  const assertTransportFrozen=()=>{requireProof(sha256(readFileSync(privateConfig(sshConfig)))===configHash,'private SSH configuration changed');const fresh=execFileSync('ssh',['-G','-F',sshConfig,TARGET.alias],{encoding:'utf8',timeout:10000,maxBuffer:1024*1024});requireProof(fresh===settings,'effective SSH route changed');};
  const ssh=(command,options={})=>execFileSync('ssh',['-F',sshConfig,'-o','BatchMode=yes','-o','ConnectTimeout=12',TARGET.alias,command],{encoding:'utf8',timeout:30000,maxBuffer:64*1024*1024,...options});
  const transport=counterTransport(rsync,ssh);
  const gh=(path)=>JSON.parse(execFileSync('gh',['api',path],{encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024}));
  requireProof(gh('repos/'+P.repository).id===1333414856,'unexpected company repository');
  const checkBranches=head=>{
    const main=gh('repos/'+P.repository+'/git/ref/heads/main').object?.sha,alpha=gh('repos/'+P.repository+'/git/ref/heads/alpha').object?.sha;
    requireProof(main===alpha&&[ALIGNED_BASE,head].includes(alpha),'main/alpha alignment changed outside bounded release');
  };
  const current=()=>official.parseDeployStatus(ssh('cd /opt/ai-hr && deploy/deploy-state.sh status'));
  assertTransportFrozen();
  requireProof(baselineRules.readyProductionBaseline(current())===P.baseline,'staging baseline moved');
  const args={candidatePath,runDirectory,counterRoot},evidence={...await collectOwnerCounterAcceptance(args),controller};checkBranches(evidence.candidate);
  const verifyLedger=()=>{
    const command="cd /opt/ai-hr && set -a && . ./.env.production && set +a && PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=15000' psql \"${MIGRATION_DATABASE_URL:-$DATABASE_URL}\" -XAt -v ON_ERROR_STOP=1 -c "+shellQuote("SELECT coalesce(json_agg(json_build_object('id', id, 'hash', hash, 'created_at', created_at::text) ORDER BY id), '[]'::json) FROM drizzle.__drizzle_migrations");
    validateMergedLedger(JSON.parse(ssh(command)),evidence.migrationLedger);
  };
  verifyLedger();
  const dir=join(controllerDirectory,'scratchpad','owner-counter-exception-'+randomUUID());mkdirSync(dir,{recursive:true,mode:0o700});
  const save=(name,value)=>writeFileSync(join(dir,name),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
  save('verified-exception.json',{...evidence,target:TARGET,execute,verifiedAt:new Date().toISOString()});
  if(!execute)return {...evidence,evidenceDirectory:dir};
  const prepared=testing.prepareSystemTestingBuild({worktree:candidatePath,candidate:evidence.candidate,buildRecordId:randomUUID()});
  const buildDirectory=testing.systemTestingBuildDirectory('local');testing.ensurePrivateReleaseDirectory(buildDirectory);testing.publishSystemTestingBuild(prepared,buildDirectory);
  requireProof(equal({...await collectOwnerCounterAcceptance(args),controller},evidence),'evidence changed after preparation');
  const roots={run:runDirectory,...(evidence.resumeDirectory?{resume:evidence.resumeDirectory}:{}),source:candidatePath,historicalSource:evidence.historicalSourcePath,peerCI:evidence.peerEvidenceRoot,runtime:join(candidatePath,'scratchpad'),counter:counterRoot,counterProof:join(counterRoot,'scratchpad/ai-counter-repair-20261026')};
  const revalidate=phase=>{
    assertTransportFrozen();
    requireProof(cleanHead(candidatePath)===evidence.candidate&&cleanHead(controllerDirectory)===controller,'candidate/controller changed');
    for(const artifact of evidence.artifacts){const root=roots[artifact.group];requireProof(root,'unknown evidence group');const path=join(root,artifact.path),stat=lstatSync(path);requireProof(stat.isFile()&&!stat.isSymbolicLink()&&realpathSync(path)===path&&stat.size===artifact.bytes&&sha256(readFileSync(path))===artifact.sha256,'bound evidence changed');}
    const status=current();
    if(phase==='baseline')requireProof(baselineRules.readyProductionBaseline(status)===P.baseline,'baseline moved');
    else requireProof(phase==='pending'&&status.state==='incomplete'&&status.ref===evidence.candidate&&status.built_ref===P.baseline&&status.stale_build==='1','pending source/build identity changed');
    checkBranches(evidence.candidate);verifyLedger();
  };
  const assertBuildFrozen=()=>requireProof(stableTestingJson(testing.prepareSystemTestingBuild({worktree:candidatePath,candidate:evidence.candidate,buildRecordId:prepared.identity.buildRecordId}))===stableTestingJson(prepared),'System Testing source changed');
  const status=counterExceptionFlow({evidence,official,testingBuild:prepared,stableTestingJson,revalidate,assertBuildFrozen,transport,save});
  requireProof(cleanHead(candidatePath)===evidence.candidate&&cleanHead(controllerDirectory)===controller,'source changed during remote build');assertBuildFrozen();
  const envelope=JSON.stringify({kind:'OWNER_COUNTER_EXCEPTION_RELEASE_EVIDENCE',policyVersion:3,evidence,remoteBuild:status,testingBuildRecordId:prepared.identity.buildRecordId})+'\n';
  requireProof(Buffer.byteLength(envelope)<=8*1024*1024,'release mirror budget');
  save('exception-envelope.json',JSON.parse(envelope));
  try { assertTransportFrozen();ssh(counterMirrorCommand(),{input:envelope}); }
  catch(error){save('mirror-warning.json',{error:String(error)});throw Error('Remote build succeeded; exception mirror failed. Retry the saved envelope without rebuilding.');}
  save('mirror-complete.json',{candidate:evidence.candidate,envelopeSha256:sha256(envelope)});
  try {
    const record=learning.recordReleaseLearning({worktree:candidatePath,sha:evidence.candidate,buildId:status.built_build_id,previousRef:P.baseline,
      receipt:{sha:evidence.candidate,tier:ACCEPTANCE_TIER,result:'ACCEPTED_WITH_OWNER_EXCEPTION'},status,
      mirror:value=>ssh('cd /opt/ai-hr && AIHR_IMPACT_STATE_DIR=/var/tmp/aihr-deploy/impact-learning /opt/node20/bin/node --import tsx scripts/gate-learning-cli.ts record-release',{input:JSON.stringify(value)})});
    save('release-learning.json',record);
  } catch(error){save('release-learning-warning.json',{error:String(error)});console.warn('Built source verified; release-learning mirror requires attention.');}
  return {...evidence,evidenceDirectory:dir,remoteBuild:status,testingBuildRecordId:prepared.identity.buildRecordId,arrivalVerified:false};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [mode,candidatePath,runDirectory,counterRoot,sshConfig]=process.argv.slice(2);
  requireProof(process.argv.length===7&&['verify','deploy'].includes(mode)&&candidatePath&&runDirectory&&counterRoot&&sshConfig,'usage: node --import <candidate-tsx-loader> local-counter-merged-operator.mjs <verify|deploy> <candidate> <terminal-run> <counter-root> <private-ssh-config>');
  operatorCounterException({candidatePath,runDirectory,counterRoot,sshConfig,execute:mode==='deploy'}).then(value=>console.log(JSON.stringify(value,null,2))).catch(error=>{console.error(error);process.exitCode=1;});
}
