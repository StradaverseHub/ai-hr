import {operatorSsh} from './operator-ssh.mjs';
import { execFileSync,spawnSync } from 'node:child_process';
import { mkdirSync,readFileSync,writeFileSync,openSync,closeSync,existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { impactFor,git,environmentHash,reusableFullBaseline,readyProductionBaseline } from './gate-impact-git';
import { planImpact,type ImpactPlan } from './gate-impact';
import { sourceFiles } from './gate-impact-git';
import { collectChanges } from './gate-tier-git';
import { classifyTestFiles } from './gate-db-classify';
import { saveGate,gateHistory,releaseHistory,fullRegressionDue } from './gate-learning';

const sha=git(['rev-parse','HEAD']),started=Date.now(),out=process.env.GATE_OUT??'/tmp/aihr-gate-impact';mkdirSync(out,{recursive:true});
const frozen=()=>{if(git(['rev-parse','HEAD'])!==sha||git(['status','--porcelain']))throw Error('Candidate changed during verification; no PASS receipt may be issued');};frozen();
const args=process.argv.slice(2),forced=args.includes('--full')||args.includes('--shadow'),explicit=args.find(a=>!a.startsWith('--'));
let deployed=explicit,baseFailure:string|undefined;
if(!deployed){try{
 const status=execFileSync('ssh',[...operatorSsh().options,operatorSsh().target,'cd /opt/ai-hr && deploy/deploy-state.sh status'],{encoding:'utf8',timeout:30000});
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
writeFileSync(join(out,'plan.json'),JSON.stringify({sha,base,deployed:deployedSha,environmentHash:env,baselineFull,plan},null,2));
console.log(`▸ ${plan.tier} gate; risk=${plan.risk}; ${plan.run.length} selected tests; baseline=${base.slice(0,12)}`);
for(const reason of plan.reasons)console.log('  '+reason);
if(args.includes('--plan-only'))process.exit(0);
// A failed/incomplete new attempt must not leave an older same-SHA PASS usable.
writeFileSync('.gate-receipt.json',JSON.stringify({sha,result:'FAIL',tier:'impact',reason:'Verification in progress',at:new Date().toISOString()},null,2)+'\n');
function run(command:string[],name:string,extra:Partial<NodeJS.ProcessEnv>={},timeoutMs=7200000){
 const fd=openSync(join(out,name),'w');console.log('START '+name);
 try{const r=spawnSync(command[0],command.slice(1),{stdio:['ignore',fd,fd],env:{...process.env,...extra},timeout:timeoutMs});if(r.error)throw r.error;frozen();console.log('END '+name+' exit='+r.status);return r.status??1;}finally{closeSync(fd);}
}
function counted(name:string,asked:number){const s=readFileSync(join(out,name),'utf8'),line=s.match(/^\s*Test Files[^\n]*\((\d+)\)\s*$/gm)?.at(-1);const n=Number(line?.match(/\((\d+)\)\s*$/)?.[1]);if(n!==asked)throw Error(`Asked ${asked} files, counted ${n}: ${name}`);return n;}
let failed=false,files=0,receipt:Record<string,unknown>;
if(plan.tier==='full'){
 // The full controller serializes all chunks; its combined wall time is not a per-phase limit.
 // Keep bounded selected phases below, while allowing the complete official inventory to close.
 const result=run(['bash','scripts/gate-chunked.sh'],'full-controller.log',{CHUNKS:process.env.CHUNKS??'8',GATE_OUT:out},0);failed=result!==0;
 if(failed){
  receipt={sha,result:'FAIL',tier:'full',at:new Date().toISOString()};
  writeFileSync('.gate-receipt.json',JSON.stringify(receipt,null,2)+'\n');
 }else{
  receipt=JSON.parse(readFileSync('.gate-receipt.json','utf8'));
  if(receipt.sha!==sha||receipt.result!=='PASS'||receipt.tier!=='full'||typeof receipt.files!=='number'||receipt.files<1||receipt.files!==receipt.suiteFiles)throw Error('No complete authentic full receipt');
 }
}else{
 const {db,nodb}=classifyTestFiles(plan.run,p=>{try{return readFileSync(p,'utf8');}catch{return null;}});
 if(nodb.length){const closed='postgres://nobody:nothing@127.0.0.1:1/no_database';failed=run(['pnpm','exec','vitest','run','--config','vitest.nodb.config.ts',...nodb],'nodb.log',{DATABASE_URL:closed,MIGRATION_DATABASE_URL:closed,TEST_DATABASE_URL:closed,TEST_MIGRATION_DATABASE_URL:closed,VITEST_MAX_WORKERS_NODB:process.env.VITEST_MAX_WORKERS_NODB??'3'})!==0;files+=counted('nodb.log',nodb.length);}
 // Bound WAL/memory even when selection grows: the selected tier must never become a bare huge run.
 for(let offset=0;offset<db.length;offset+=64){const batch=db.slice(offset,offset+64),name=`impact-db-${offset/64+1}.log`;
  if(run(['bash','scripts/dev-db-rebuild.sh'],`rebuild-${offset/64+1}.log`)!==0)throw Error('Disposable cluster rebuild failed');
  if(run(['pnpm','db:migrate'],`migrate-${offset/64+1}.log`)!==0)throw Error('Migration failed');
  failed=run(['pnpm','exec','vitest','run',...batch],name,{VITEST_MAX_WORKERS:process.env.VITEST_MAX_WORKERS??'2'})!==0||failed;files+=counted(name,batch.length);
 }
 let browserFiles=0;
 if(plan.browser){const asked=git(['ls-files','test']).split('\n').filter(p=>p.endsWith('.browser.test.tsx')).length;failed=run(['pnpm','test:browser'],'browser.log')!==0||failed;browserFiles=counted('browser.log',asked);}
 if(files!==plan.run.length)throw Error('Incomplete selected suite');
 receipt={sha,result:failed?'FAIL':'PASS',tier:'impact',base,deployedBase:deployedSha,environmentHash:env,policyVersion:plan.policyVersion,plan,baselineFull,run:plan.run,counts:{files,nodb:nodb.length,db:db.length,browserFiles},wallSeconds:(Date.now()-started)/1000,at:new Date().toISOString()};
 frozen();writeFileSync('.gate-receipt.json',JSON.stringify(receipt,null,2)+'\n');
}
const logs=execFileSync('find',[out,'-maxdepth','1','-name','*.log','-type','f'],{encoding:'utf8'}).trim().split('\n').filter(Boolean);
const failures=[...new Set(logs.flatMap(p=>[...readFileSync(p,'utf8').matchAll(/^\s*FAIL\s+(?:\|[^|]+\|\s+)?(test\/[^\s]+\.(?:ts|tsx))/gm)].map(m=>m[1])))].sort();
const observation=saveGate({sha,base,environmentHash:env,result:failed?'FAIL':'PASS',tier:plan.tier,plan,failed:failures,executed:plan.tier==='full'?(failed?[]:[...sourceFiles().keys()].filter(p=>/^test\/.+\.test\.ts$/.test(p)||/^test\/.+\.dom\.test\.tsx$/.test(p)).sort()):plan.run,wallSeconds:(Date.now()-started)/1000,...(plan.tier==='full'?{fullReceipt:receipt}:{})});
writeFileSync(join(out,'learning.json'),JSON.stringify(observation,null,2));
console.log(`GATE ${failed?'RED':'GREEN'}; risk=${plan.risk}; learning saved as ${observation.id}`);process.exit(failed?1:0);
