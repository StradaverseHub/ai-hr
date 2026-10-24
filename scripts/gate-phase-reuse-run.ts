import {execFileSync,spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,openSync,closeSync,copyFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {git,environmentHash,readyProductionBaseline} from './gate-impact-git';
import {saveGate} from './gate-learning';
import {passedPhase,PHASE_REUSE_POLICY_VERSION} from './gate-phase-reuse';
import {BASELINE_ARTIFACTS,artifactManifest,readArtifacts,validateBaseline,phaseReusePlan,validatePhaseReuse,proof,type PhaseReuseReceipt,type PhaseRun} from './gate-phase-reuse-evidence';

const args=process.argv.slice(2),finalize=args.includes('--finalize'),positional=args.filter(a=>!a.startsWith('--'));
proof(positional.length===2,'usage: gate.sh --reuse-db BASELINE_OUT FRESH_OUT [--finalize]');
const [baseline,out]=positional.map(p=>resolve(p)),cwd=process.cwd(),head=git(['rev-parse','HEAD']),started=Date.now(),archive=join(out,'archive');
const frozen=()=>proof(git(['rev-parse','HEAD'])===head&&!git(['status','--porcelain']),'candidate changed');frozen();
writeFileSync('.gate-receipt.json',JSON.stringify({sha:head,result:'FAIL',tier:'phase-reuse',reason:'Fresh verification and fixture restoration pending'})+'\n');
function production(){
 const text=execFileSync('ssh',['-p',process.env.IMPROVE_SSH_PORT??'8288','-o','BatchMode=yes','-o','ConnectTimeout=12',`${process.env.IMPROVE_SSH_USER??'ubuntu'}@${process.env.IMPROVE_SSH_HOST??'203.142.6.241'}`,'cd /opt/ai-hr && deploy/deploy-state.sh status'],{encoding:'utf8',timeout:30000});
 return readyProductionBaseline(Object.fromEntries(text.split('\n').filter(l=>l.includes('=')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1)];})));
}
const deployed=production();
function write(name:string,value:unknown){writeFileSync(join(out,name),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});}
if(finalize){
 const pending=JSON.parse(readFileSync(join(out,'pending.json'),'utf8')) as PhaseReuseReceipt;
 proof(pending.sha===head&&pending.result==='FAIL'&&pending.deployedBase===deployed&&pending.archive===archive,'pending identity/production');
 readArtifacts(archive,pending.artifacts); // Verify pinned hashes BEFORE adding restoration artifacts.
 for(const name of ['port-handover-result.json','fixture-5433-before.json','fixture-5433-after.json'])copyFileSync(join(out,name),join(archive,'fresh-'+name),2);
 const receipt:PhaseReuseReceipt={...pending,result:'PASS',at:new Date().toISOString(),artifacts:artifactManifest(archive,[...pending.artifacts.map(x=>x.path),'fresh-port-handover-result.json','fresh-fixture-5433-before.json','fresh-fixture-5433-after.json'])};
 const verified=validatePhaseReuse(receipt,{head,deployedRef:deployed,worktree:cwd});frozen();
 const observation=saveGate({sha:head,base:receipt.base,environmentHash:receipt.environmentHash,result:'PASS',tier:'phase-reuse',plan:verified.plan.impact,failed:[],executed:[...receipt.nodb.files,...receipt.database.flatMap(r=>r.files)],wallSeconds:(Date.now()-started)/1000,phaseReuse:receipt});
 write('learning.json',observation);write('receipt.json',receipt);
 writeFileSync('.gate-receipt.json',JSON.stringify(receipt,null,2)+'\n');
 console.log(`PASS tier=phase-reuse: reused ${verified.base.counted.files} DB files/${verified.base.counted.tests} tests from ${receipt.base}; freshly ran ${receipt.nodb.files.length} no-DB files and ${receipt.database.flatMap(r=>r.files).length} affected DB files. Original full attempt remains FAIL.`);
}else{
 mkdirSync(out,{recursive:true,mode:0o700});mkdirSync(archive,{mode:0o700});
 for(const name of BASELINE_ARTIFACTS){
  const source=['port-handover-result.json','fixture-5433-before.json','fixture-5433-after.json','verify-local-fullgate-5433.py','impact-gate-5433.log'].includes(name)?join(baseline,name):join(baseline,'fullgate',name);
  copyFileSync(source,join(archive,name),2);
 }
 const manifest=artifactManifest(archive,BASELINE_ARTIFACTS),artifacts=readArtifacts(archive,manifest);
 const baselineSha=JSON.parse(artifacts.get('plan.json')!).sha;
 const witness=validateBaseline(artifacts,baselineSha,cwd),plan=phaseReusePlan(baselineSha,head,cwd),env=environmentHash();
 proof(witness.plan.deployed===deployed&&witness.plan.environmentHash===env,'original environment or deployed base changed');
 proof(JSON.stringify(witness.db)===JSON.stringify(plan.db),'DB inventory changed');
 write('plan.json',{head,base:baselineSha,deployed,environmentHash:env,...plan});
 console.log(`Phase reuse: ${witness.counted.files} original DB files; fresh ${plan.nodb.length} no-DB files + ${plan.affected.length} affected DB files`);
 const logs:string[]=[],run=(command:string[],name:string,extra:Partial<NodeJS.ProcessEnv>={})=>{
  const fd=openSync(join(archive,name),'wx',0o600);let status:number|null;
  try{const r=spawnSync(command[0],command.slice(1),{cwd,stdio:['ignore',fd,fd],env:{...process.env,...extra},timeout:7200000});if(r.error)throw r.error;status=r.status;}finally{closeSync(fd);}
  frozen();proof(status===0,'failed or interrupted '+name);logs.push(name);return status;
 };
 const closed='postgres://nobody:nothing@127.0.0.1:1/no_database';
 const nodb:PhaseRun={files:plan.nodb,log:'fresh-nodb.log',exit:run(['pnpm','exec','vitest','run','--config','vitest.nodb.config.ts',...plan.nodb],'fresh-nodb.log',{DATABASE_URL:closed,MIGRATION_DATABASE_URL:closed,TEST_DATABASE_URL:closed,TEST_MIGRATION_DATABASE_URL:closed,VITEST_MAX_WORKERS_NODB:'1'})};
 passedPhase(readFileSync(join(archive,nodb.log),'utf8'),nodb.files.length);
 const database:PhaseRun[]=[];
 for(let offset=0;offset<plan.affected.length;offset+=64){
  // The surrounding preservation wrapper owns this isolated PGDATA and restores the fixture.
  proof(process.env.PGDATA_AIHR?.startsWith('/private/tmp/aihr-board1-phase-reuse-')&&process.env.PGPORT_AIHR==='5433','isolated preservation wrapper is required for DB refresh');
  const n=offset/64+1,files=plan.affected.slice(offset,offset+64),log=`fresh-db-${n}.log`;
  run(['bash','scripts/dev-db-rebuild.sh'],`fresh-rebuild-${n}.log`);run(['pnpm','db:migrate'],`fresh-migrate-${n}.log`);
  const exit=run(['pnpm','exec','vitest','run',...files],log,{VITEST_MAX_WORKERS:'1'});passedPhase(readFileSync(join(archive,log),'utf8'),files.length);database.push({files,log,exit});
 }
 const pending:PhaseReuseReceipt={sha:head,result:'FAIL',tier:'phase-reuse',base:baselineSha,deployedBase:deployed,environmentHash:env,policyVersion:PHASE_REUSE_POLICY_VERSION,at:new Date().toISOString(),archive,artifacts:artifactManifest(archive,[...BASELINE_ARTIFACTS,...logs]),nodb,database,planFingerprint:plan.impact.fingerprint};
 frozen();write('pending.json',pending);console.log('Fresh phases passed; receipt remains FAIL until the wrapper restores and compares the fixture, then --finalize validates all evidence.');
}
