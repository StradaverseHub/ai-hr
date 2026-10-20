import { execFileSync,spawnSync } from 'node:child_process';
import { mkdirSync,readFileSync,writeFileSync,openSync,closeSync } from 'node:fs';
import { join } from 'node:path';
import { createHash,randomUUID } from 'node:crypto';
import { impactFor,git,environmentHash,reusableFullBaseline,readyProductionBaseline } from './gate-impact-git';
import { planImpact,type ImpactPlan } from './gate-impact';
import { sourceFiles } from './gate-impact-git';
import { collectChanges } from './gate-tier-git';
import { coverageBody,coverageId,coveragesFor,describeMismatch,existingCheckpoints,runAttempt,unitsFor,type CoverageBody,type Execution,type Unit } from './gate-checkpoint';
import { saveGate,gateHistory,releaseHistory,fullRegressionDue } from './gate-learning';

const sha=git(['rev-parse','HEAD']),started=Date.now(),out=process.env.GATE_OUT??'/tmp/aihr-gate-impact';mkdirSync(out,{recursive:true});
const frozen=()=>{if(git(['rev-parse','HEAD'])!==sha||git(['status','--porcelain']))throw Error('Candidate changed during verification; no PASS receipt may be issued');};frozen();
const args=process.argv.slice(2),forced=args.includes('--full')||args.includes('--shadow'),explicit=args.find(a=>!a.startsWith('--'));
let deployed=explicit,baseFailure:string|undefined;
if(!deployed){try{
 const status=execFileSync('ssh',['-p',process.env.IMPROVE_SSH_PORT??'8288','-o','BatchMode=yes','-o','ConnectTimeout=12',`${process.env.IMPROVE_SSH_USER??'ubuntu'}@${process.env.IMPROVE_SSH_HOST??'203.142.6.241'}`,'cd /opt/ai-hr && deploy/deploy-state.sh status'],{encoding:'utf8',timeout:30000});
 deployed=readyProductionBaseline(Object.fromEntries(status.split('\n').filter(line=>line.includes('=')).map(line=>{const at=line.indexOf('=');return [line.slice(0,at),line.slice(at+1)];})));
}catch(e){baseFailure='Production baseline unavailable: '+String(e);deployed=git(['rev-parse','main']);}}
const deployedSha=git(['rev-parse',deployed!]),env=environmentHash();let base=deployedSha,baselineFull:ReturnType<typeof reusableFullBaseline>=null,plan:ImpactPlan;
try{
 baselineFull=reusableFullBaseline(deployedSha,sha);
 if(baselineFull&&baselineFull.sha!==sha)base=baselineFull.sha;
 plan=impactFor(base);
 baseFailure??=fullRegressionDue(gateHistory(),releaseHistory(),env)??undefined;
}catch(e){baseFailure='Unknown impact/evidence: '+String(e);base=deployedSha;baselineFull=null;plan=planImpact(collectChanges(base),sourceFiles());}
if(baseFailure||forced){plan.tier='full';plan.reasons.push(baseFailure??'Full/shadow verification requested');const {fingerprint:_,...body}=plan;plan.fingerprint=createHash('sha256').update(JSON.stringify(body)).digest('hex');}
const planBytes=JSON.stringify({sha,base,deployed:deployedSha,environmentHash:env,baselineFull,plan},null,2),planHash=createHash('sha256').update(planBytes).digest('hex');writeFileSync(join(out,'plan.json'),planBytes);
console.log(`▸ ${plan.tier} gate; risk=${plan.risk}; ${plan.run.length} selected tests; baseline=${base.slice(0,12)}`);
for(const reason of plan.reasons)console.log('  '+reason);
const resume=args.includes('--resume');let body:CoverageBody|undefined;
if(plan.tier==='impact'){
 const browserFiles=git(['ls-files','test']).split('\n').filter(p=>p.endsWith('.browser.test.tsx'));
 body=coverageBody({sha,base,deployed:deployedSha,environmentHash:env,policyVersion:plan.policyVersion,tier:plan.tier,run:plan.run,browser:plan.browser,
  units:unitsFor(plan,p=>{try{return readFileSync(p,'utf8');}catch{return null;}},browserFiles)});
 console.log(`▸ coverage ${coverageId(body).slice(0,12)}: ${body.units.map(u=>u.id+'('+u.files.length+')').join(' ')}`);
}
if(args.includes('--plan-only'))process.exit(0);
if(resume){
 // ADR-0133: resume only the exact coverage it checkpointed; anything else is a new verification.
 if(!body){console.log('✗ --resume refused: this plan is tier=full, which runs uninterrupted. Run without --resume.');process.exit(2);}
 if(!existingCheckpoints(body).length){
  console.log('✗ --resume refused: no checkpoints exist for this exact commit, selection, partition, environment and policy.');
  for(const other of coveragesFor(sha))console.log(`  earlier coverage ${coverageId(other).slice(0,12)} differs: ${describeMismatch(body,other).join('; ')||'identity'}`);
  console.log('  Run bash scripts/gate.sh without --resume.');process.exit(2);
 }
}
// A failed/incomplete new attempt must not leave an older same-SHA PASS usable.
writeFileSync('.gate-receipt.json',JSON.stringify({sha,result:'FAIL',tier:'impact',reason:'Verification in progress',at:new Date().toISOString()},null,2)+'\n');
function run(command:string[],name:string,extra:Partial<NodeJS.ProcessEnv>={}){
 const fd=openSync(join(out,name),'w');console.log('START '+name);
 try{const r=spawnSync(command[0],command.slice(1),{stdio:['ignore',fd,fd],env:{...process.env,...extra},timeout:7200000});if(r.error)throw r.error;frozen();console.log('END '+name+' exit='+r.status);return r.status??1;}finally{closeSync(fd);}
}
let failed=false,files=0,receipt:Record<string,unknown>,executed:string[]=[];const written:string[]=[];
if(plan.tier==='full'){
 const result=run(['bash','scripts/gate-chunked.sh'],'full-controller.log',{CHUNKS:process.env.CHUNKS??'8',GATE_OUT:out});failed=result!==0;
 if(failed){
  receipt={sha,result:'FAIL',tier:'full',at:new Date().toISOString()};
  writeFileSync('.gate-receipt.json',JSON.stringify(receipt,null,2)+'\n');
 }else{
  receipt=JSON.parse(readFileSync('.gate-receipt.json','utf8'));
  if(receipt.sha!==sha||receipt.result!=='PASS'||receipt.tier!=='full'||typeof receipt.files!=='number'||receipt.files<1||receipt.files!==receipt.suiteFiles)throw Error('No complete authentic full receipt');
 }
}else{
 const counts={files:0,nodb:0,db:0,browserFiles:0};
 for(const unit of body!.units){if(unit.kind==='browser')counts.browserFiles=unit.files.length;else{counts.files+=unit.files.length;counts[unit.kind]+=unit.files.length;}}
 if(counts.files!==plan.run.length)throw Error('Incomplete selected suite');
 const closed='postgres://nobody:nothing@127.0.0.1:1/no_database';
 // Each unit is independent evidence (ADR-0133): DB batches rebuild and migrate their own cluster.
 const execute=(unit:Unit):Execution=>{
  const startedAt=new Date().toISOString();let name:string,exitCode:number;
  if(unit.kind==='nodb'){name='nodb.log';exitCode=run(['pnpm','exec','vitest','run','--config','vitest.nodb.config.ts',...unit.files],name,{DATABASE_URL:closed,MIGRATION_DATABASE_URL:closed,TEST_DATABASE_URL:closed,TEST_MIGRATION_DATABASE_URL:closed,VITEST_MAX_WORKERS_NODB:process.env.VITEST_MAX_WORKERS_NODB??'3'});}
  else if(unit.kind==='db'){const n=Number(unit.id.slice(3));name=`impact-db-${n}.log`;
   if(run(['bash','scripts/dev-db-rebuild.sh'],`rebuild-${n}.log`)!==0)throw Error('Disposable cluster rebuild failed');
   if(run(['pnpm','db:migrate'],`migrate-${n}.log`)!==0)throw Error('Migration failed');
   exitCode=run(['pnpm','exec','vitest','run',...unit.files],name,{VITEST_MAX_WORKERS:process.env.VITEST_MAX_WORKERS??'2'});}
  else{name='browser.log';exitCode=run(['pnpm','test:browser'],name);}
  written.push(join(out,name));
  return {exitCode,logBytes:readFileSync(join(out,name)),startedAt,endedAt:new Date().toISOString()};
 };
 const attempt=runAttempt({body:body!,resume,attempt:randomUUID(),planFingerprint:plan.fingerprint,planHash,execute,log:line=>console.log(line)});
 failed=!attempt.passed;files=counts.files;executed=attempt.executed.filter(u=>u.kind!=='browser').flatMap(u=>u.files);
 frozen();
 receipt={sha,result:failed?'FAIL':'PASS',tier:'impact',base,deployedBase:deployedSha,environmentHash:env,policyVersion:plan.policyVersion,plan,baselineFull,run:plan.run,counts,checkpoints:attempt.checkpoints,resumed:resume,wallSeconds:(Date.now()-started)/1000,at:new Date().toISOString()};
 for(const a of attempt.checkpoints.attempts)console.log(`  checkpoint ${a.id}: ${a.passed?'green':'RED'}`);
 if(attempt.checkpoints.assembled)console.log(`▸ receipt assembled from ${new Set(attempt.checkpoints.units.map(r=>r.id.slice(r.id.indexOf('.')+1))).size} attempts of the same coverage`);
 writeFileSync('.gate-receipt.json',JSON.stringify(receipt,null,2)+'\n');
}
const logs=plan.tier==='full'?execFileSync('find',[out,'-maxdepth','1','-name','*.log','-type','f'],{encoding:'utf8'}).trim().split('\n').filter(Boolean):written;
const failures=[...new Set(logs.flatMap(p=>[...readFileSync(p,'utf8').matchAll(/^\s*FAIL\s+(?:\|[^|]+\|\s+)?(test\/[^\s]+\.(?:ts|tsx))/gm)].map(m=>m[1])))].sort();
const observation=saveGate({sha,base,environmentHash:env,result:failed?'FAIL':'PASS',tier:plan.tier,plan,failed:failures,executed:plan.tier==='full'?(failed?[]:[...sourceFiles().keys()].filter(p=>/^test\/.+\.test\.ts$/.test(p)||/^test\/.+\.dom\.test\.tsx$/.test(p)).sort()):executed,wallSeconds:(Date.now()-started)/1000,...(plan.tier==='full'?{fullReceipt:receipt}:{})});
writeFileSync(join(out,'learning.json'),JSON.stringify(observation,null,2));
console.log(`GATE ${failed?'RED':'GREEN'}; risk=${plan.risk}; learning saved as ${observation.id}`);process.exit(failed?1:0);
