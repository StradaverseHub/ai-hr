/** Same disposable VM, source-equivalent cases; diagnostic only, never a release receipt. */
import assert from 'node:assert/strict';
import {spawn,spawnSync,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdirSync,readFileSync,writeFileSync,openSync,closeSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual as equal} from 'node:util';
import {verifyFocusedResult} from '../focused-checks.mjs';
import {capturePostgresEvidence,validatePostgresEvidence,postgresProfileFromEnv} from '../postgres-evidence.mjs';
const BASE='3c51317ea43ded103e782c37b55eccf9fdeae05c';
const ORIGINAL_HASH='95272f90e5684476686231bc16efe1a5895b0c7d8afa580139b693fea270b9a6';
export const FILES=Object.freeze(['test/attendance-policy-storage.test.ts','test/attendance-policy-storage-pricing.test.ts','test/attendance-policy-storage-settlement.test.ts','test/attendance-policy-storage-unclocked.test.ts']);
const HELPER='test/attendance-policy-storage-fixture.ts';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024}).trim();
const postgres=fileURLToPath(new URL('../postgres.sh',import.meta.url));
export function compareCases(a,b){
 const titles=r=>r.testResults.flatMap(s=>s.assertionResults.map(a=>a.fullName)).sort();
 assert(equal(titles(a),titles(b)),'Expanded test identities changed');return true;
}
export function sourceProof(original,contents,helper,ts){
 assert.equal(hash(original),ORIGINAL_HASH,'Unreviewed original source');
 assert.equal(hash(helper),'322b512b76cc5eada88b4ab3ef24f32a88e7830f85a62cdbaa075aeb7e3c9079','Unreviewed shared fixture factory');
 const parse=(text,name)=>{const s=ts.createSourceFile(name,text,ts.ScriptTarget.Latest,true);assert.equal(s.parseDiagnostics.length,0);return s;};
 const source=parse(original,FILES[0]),splits=FILES.map(f=>parse(contents[f],f)),shared=parse(helper,HELPER);
 const expr=(n,s)=>ts.isExpressionStatement(n)&&ts.isCallExpression(n.expression)?n.expression.expression.getText(s):'';
 const body=s=>s.statements.find(n=>expr(n,s)==='describe').expression.arguments[1].body.statements;
 const expected=[...body(source)].map(n=>n.getText(source));assert.equal(expected.length,47);
 assert.deepEqual(splits.flatMap(s=>[...body(s)].map(n=>n.getText(s))),expected,'Changed registration/body/data/timeout');
 const hooks=s=>s.statements.filter(n=>['beforeAll','beforeEach','afterAll'].includes(expr(n,s))).map(n=>n.getText(s));
 for(const s of splits)assert.deepEqual(hooks(s),hooks(source),'Changed per-case fixture hooks');
 const originalFunctions=source.statements.filter(ts.isFunctionDeclaration),factory=shared.statements.find(ts.isFunctionDeclaration),functions=factory.body.statements.filter(ts.isFunctionDeclaration);
 assert.equal(originalFunctions.length,4);assert.equal(functions.length,4);
 for(const fn of originalFunctions){
  const edits=[];function walk(n){if(ts.isIdentifier(n)&&['b','ctx'].includes(n.text)){
   const p=n.parent;if((ts.isPropertyAccessExpression(p)&&p.name===n)||(ts.isPropertyAssignment(p)&&p.name===n))return;
   assert(!ts.isVariableDeclaration(p)&&!ts.isParameter(p)&&!ts.isBindingElement(p),'Shadowed fixture binding');
   edits.push({from:n.getStart(source)-fn.getStart(source),to:n.end-fn.getStart(source),value:ts.isShorthandPropertyAssignment(p)?`${n.text}: state.${n.text}`:`state.${n.text}`});
  }ts.forEachChild(n,walk);}walk(fn);
  let adapted=fn.getText(source);for(const e of edits.sort((a,b)=>b.from-a.from))adapted=adapted.slice(0,e.from)+e.value+adapted.slice(e.to);
  assert.equal(functions.find(n=>n.name.text===fn.name.text)?.getText(shared),adapted,'Shared fixture differs: '+fn.name.text);
 }
 return {kind:'EXACT_REGISTRATION_AND_LIVE_GETTER_SOURCE_PROOF',originalTestSource:BASE,originalSha256:hash(original),registrations:47,originalExpandedCases:100,callbacksAndHooksUnchanged:true,helperGetterOnlyAdaptation:true,hashes:Object.fromEntries([...FILES.map(f=>[f,hash(contents[f])]),[HELPER,hash(helper)]])};
}
/** A timed-out phase stops only its own group and never begins the next phase. */
export async function ownedCommand(command,args,{cwd,env,log,timeoutMs=720000,graceMs=15000}){
 const fd=openSync(log,'wx',0o600),child=spawn(command,args,{cwd,env,stdio:['ignore',fd,fd],detached:true});
 let timedOut=false,killDone=Promise.resolve();const timer=setTimeout(()=>{timedOut=true;try{process.kill(-child.pid,'SIGTERM');}catch{}killDone=new Promise(done=>setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}done();},graceMs));},timeoutMs);
 const result=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>done({code,signal}));}).finally(async()=>{clearTimeout(timer);await killDone;closeSync(fd);});
 assert(!timedOut&&result.code===0&&result.signal===null,'Owned command failed/timed out; no next phase');return result;
}
export async function benchmark(){
 assert(process.platform==='linux'&&process.env.GITHUB_ACTIONS==='true'&&process.env.CI==='true'&&process.env.RUNNER_ENVIRONMENT==='github-hosted'&&process.env.GITHUB_REPOSITORY==='StradaverseHub/ai-hr');
 const cwd=realpathSync(process.cwd()),sha=git(cwd,'rev-parse','HEAD');assert.equal(sha,process.env.AIHR_CI_HEAD);assert.equal(git(cwd,'status','--porcelain'),'');
 assert.equal(process.env.AIHR_CI_PG_MEMORY_GIB,'2');assert.equal(process.env.AIHR_CI_PG_JIT,'on');
 const postgresProfile=postgresProfileFromEnv(process.env);assert.equal(postgresProfile.profileVersion,1);assert.equal(postgresProfile.profileId,'legacy-2g');
 const original=execFileSync('git',['show',BASE+':'+FILES[0]],{cwd,encoding:'utf8',maxBuffer:1024*1024});
 const contents=Object.fromEntries(FILES.map(f=>[f,readFileSync(join(cwd,f),'utf8')])),helper=readFileSync(join(cwd,HELPER),'utf8');
 const ts=createRequire(join(cwd,'package.json'))('typescript'),proof=sourceProof(original,contents,helper,ts);
 const out=join(realpathSync(process.env.RUNNER_TEMP),'diagnostic-attendance-split');mkdirSync(out,{mode:0o700});
 const report={kind:'PAIRED_ATTENDANCE_DIAGNOSTIC_NOT_RELEASE_EVIDENCE',sha,controller:process.env.AIHR_CI_CONTROL_HEAD,runId:process.env.GITHUB_RUN_ID,attempt:process.env.GITHUB_RUN_ATTEMPT,sourceProof:proof,execution:{workers:2,postgres:postgresProfile},releaseAuthorized:false,order:['split','monolith'],orderCaveat:'Split runs first; later monolith can benefit from warm OS/dependency caches. Both use fresh containers. One pair is not a statistical benchmark.',runtime:{node:process.versions.node,platform:process.platform,arch:process.arch},startedAt:new Date().toISOString(),phases:[],exitCode:1};
 const env={...process.env,AIHR_CI_UNIT:'db-3',VITEST_MAX_WORKERS:'2',VITEST_MAX_WORKERS_NODB:'2',TEST_DB_NAMESPACE:'attendance_pair',DATABASE_URL:'postgres://ai_hr_app@127.0.0.1:5433/ai_hr_dev',MIGRATION_DATABASE_URL:'postgres://postgres@127.0.0.1:5433/ai_hr_dev',TEST_DATABASE_URL:'postgres://ai_hr_app@127.0.0.1:5433/ai_hr_test',TEST_MIGRATION_DATABASE_URL:'postgres://postgres@127.0.0.1:5433/ai_hr_test'};
 const control=(action)=>{const result=spawnSync('bash',[postgres,action],{env,encoding:'utf8',timeout:180000,maxBuffer:1024*1024});assert.equal(result.status,0,'Owned PostgreSQL '+action+' failed');return result;};
 const results=[];let changed=false;
 try{
  for(const mode of report.order){
   assert.equal(git(cwd,'rev-parse','HEAD'),sha);assert.equal(git(cwd,'status','--porcelain'),'');
   const phase={mode,startedAt:new Date().toISOString(),files:mode==='split'?[...FILES]:[FILES[0]],processExitCode:null};report.phases.push(phase);
   const directory=join(out,mode);mkdirSync(directory,{mode:0o700});
   if(mode==='monolith'){
    writeFileSync(join(cwd,FILES[0]),original);changed=true;
    assert.equal(hash(readFileSync(join(cwd,FILES[0]))),ORIGINAL_HASH);assert.equal(git(cwd,'diff','--name-only'),FILES[0]);
    writeFileSync(join(directory,'original-test-source.diff'),execFileSync('git',['diff','--',FILES[0]],{cwd}),{flag:'wx',mode:0o600});
   }
   control('reset');phase.afterDatabaseReset=new Date().toISOString();
   const e={...env,AIHR_TEST_PROFILE_DIR:join(directory,'harness-profile'),AIHR_TEST_PROFILE_LABEL:mode};
   await ownedCommand('pnpm',['db:migrate'],{cwd,env:e,log:join(directory,'migrate.log'),timeoutMs:300000});phase.afterMigration=new Date().toISOString();
   const resultPath=join(directory,'vitest.json');
   await ownedCommand('pnpm',['exec','vitest','run',...phase.files,'--reporter=default','--reporter=json','--outputFile.json='+resultPath],{cwd,env:e,log:join(directory,'vitest.log')});phase.processExitCode=0;phase.afterTests=new Date().toISOString();
   const result=JSON.parse(readFileSync(resultPath,'utf8'));phase.cases=verifyFocusedResult(result,[...phase.files].sort(),cwd);assert.equal(phase.cases,100);results.push(result);
   phase.databaseEvidence=capturePostgresEvidence('db-3',postgresProfile);validatePostgresEvidence(phase.databaseEvidence,report.execution);
   control('stop');phase.databaseRemoved=true;phase.endedAt=new Date().toISOString();
   if(changed){writeFileSync(join(cwd,FILES[0]),contents[FILES[0]]);changed=false;}
   assert.equal(git(cwd,'status','--porcelain'),'');
  }
  compareCases(...results);assert.equal(report.phases[0].databaseEvidence.settings.serverVersionNum,report.phases[1].databaseEvidence.settings.serverVersionNum);
  report.sameExpandedCaseIdentities=true;report.exitCode=0;
 }catch(error){report.error=String(error);throw error;}
 finally{
  if(changed)writeFileSync(join(cwd,FILES[0]),contents[FILES[0]]);
  try{control('stop');report.ownedContainerRemoved=true;}catch(error){report.cleanupError=String(error);report.exitCode=1;}
  report.sourceRestored=git(cwd,'rev-parse','HEAD')===sha&&git(cwd,'status','--porcelain')==='';if(!report.sourceRestored)report.exitCode=1;
  report.endedAt=new Date().toISOString();writeFileSync(join(out,'comparison.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
 }
 assert.equal(report.exitCode,0);return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))benchmark().then(v=>console.log(JSON.stringify(v))).catch(error=>{console.error(error);process.exitCode=1;});
