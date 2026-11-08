/** Pure original-metadata/grammar models. NOT authenticated API/native receipts. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {directChildren} from './direct-children.mjs';
import {CONTRACT,validateOriginalMetadata,originalReconstructionEnvironment,publicFailure,publishPublicFailure,validatePublicComparison} from './policy.mjs';
const clone=value=>structuredClone(value);
function metadata(){return{run:{...clone(CONTRACT.run),repository:{...CONTRACT.repository,private:false},head_repository:clone(CONTRACT.repository)},jobs:{total_count:14,jobs:clone(CONTRACT.jobs)},artifacts:{total_count:4,artifacts:CONTRACT.artifacts.map(({members,...row})=>clone(row))},workflow:{...CONTRACT.workflow,state:'active'}};}
function comparison(){return{kind:'VERIFIED_ORIGINAL_CATALOGUE_PAIR_NOT_PROFILE',originalRun:String(CONTRACT.run.id),originalCandidate:CONTRACT.originalCandidate,originalController:CONTRACT.originalController,originalPlanFingerprint:CONTRACT.originalPlanFingerprint,originalPlanReconstructed:true,units:CONTRACT.pairs.map(p=>({id:p.unit,tests:1,files:[p.file],sourceMembers:1738})),members:CONTRACT.pairs.flatMap(p=>['notification-canonical-source.json','notification-canonical-raw.json','notification-canonical-normalized.json','notification-canonical-report.json',`personnel-dd-full-role-${p.unit}-offset-0.json`].map(name=>({mode:p.mode,name,bytes:10,sha256:'a'.repeat(64)}))),comparison:{functionCount:2308,defaultFunctions:7,shiftedFunctions:100,exactRawDefaultsEqual:true},expectedProfileAuthorized:false,releaseAuthorized:false,completeSuite:false};}
test('accepts exact complete metadata while preserving intentional skipped jobs and no authentication capability',()=>{
 const value=metadata(),validated=validateOriginalMetadata(value);assert.equal(validated.jobs.length,14);assert(validated.jobs.some(j=>j.conclusion==='skipped'));assert.equal(validated.artifacts.length,4);assert(!Object.hasOwn(validated,'authenticated'));assert(!Object.hasOwn(validated,'releaseAuthorized'));
});
test('foreign run, workflow, repository, source, attempt, event or incomplete status cannot qualify',()=>{
 for(const change of [v=>v.run.id++,v=>v.run.head_sha='f'.repeat(40),v=>v.run.head_branch='main',v=>v.run.event='push',v=>v.run.run_attempt=2,v=>v.run.status='in_progress',v=>v.run.conclusion='failure',v=>v.run.workflow_id++,v=>v.run.path='.github/workflows/foreign.yml',v=>v.run.repository.id++,v=>v.run.head_repository.id++,v=>v.run.repository.private=true,v=>v.workflow.id++,v=>v.workflow.path='foreign',v=>v.workflow.state='disabled_manually']){const value=metadata();change(value);assert.throws(()=>validateOriginalMetadata(value));}
});
test('all14 exact job IDs/statuses are required without missing, duplicate, extra, failed or rerun rows',()=>{
 for(const change of [v=>v.jobs.jobs.pop(),v=>v.jobs.total_count--,v=>v.jobs.jobs.push(clone(v.jobs.jobs[0])),v=>v.jobs.jobs[1]=clone(v.jobs.jobs[0]),v=>v.jobs.jobs[0].id++,v=>v.jobs.jobs[0].name='foreign',v=>v.jobs.jobs[0].conclusion='failure',v=>v.jobs.jobs[0].status='in_progress',v=>v.jobs.jobs[0].run_attempt=2,v=>v.jobs.jobs[0].run_id++,v=>v.jobs.jobs[0].head_sha='f'.repeat(40),v=>v.jobs.jobs[0].labels=['self-hosted']]){const value=metadata();change(value);assert.throws(()=>validateOriginalMetadata(value));}
});
test('all4 exact artifact IDs/names/size/digests/original run and repository are required before download',()=>{
 for(const change of [v=>v.artifacts.artifacts.pop(),v=>v.artifacts.total_count++,v=>v.artifacts.artifacts[1]=clone(v.artifacts.artifacts[0]),v=>v.artifacts.artifacts[0].id++,v=>v.artifacts.artifacts[0].name='foreign',v=>v.artifacts.artifacts[0].size_in_bytes++,v=>v.artifacts.artifacts[0].digest='sha256:'+'f'.repeat(64),v=>v.artifacts.artifacts[0].expired=true,v=>v.artifacts.artifacts[0].workflow_run.id++,v=>v.artifacts.artifacts[0].workflow_run.repository_id++,v=>v.artifacts.artifacts[0].workflow_run.head_repository_id++,v=>v.artifacts.artifacts[0].workflow_run.head_sha='f'.repeat(40)]){const value=metadata();change(value);assert.throws(()=>validateOriginalMetadata(value));}
});
test('the frozen source-owned contract cannot be renewed or mutated by a caller flag',()=>{
 assert(Object.isFrozen(CONTRACT)&&Object.isFrozen(CONTRACT.jobs)&&Object.isFrozen(CONTRACT.jobs[0]));assert(Object.isFrozen(CONTRACT.artifacts[0].members));
 assert.throws(()=>{CONTRACT.run.run_attempt=2;});assert.throws(()=>{CONTRACT.artifacts[0].digest='sha256:'+'f'.repeat(64);});assert.throws(()=>{CONTRACT.jobs.push({});});
});
test('original reconstruction has only a fixed tokenless environment and cannot masquerade current workflow identity',()=>{
 const marker='FICTIONAL_PRIVATE_NEVER_PUBLISH',value=originalReconstructionEnvironment({PATH:'/hostile',RUNNER_TEMP:'/tmp/reviewed',GH_TOKEN:marker,GITHUB_TOKEN:marker,ACTIONS_RUNTIME_TOKEN:marker,OPENAI_API_KEY:marker,SSH_AUTH_SOCK:marker,PGPASSWORD:marker,NODE_OPTIONS:'--require '+marker,PLATFORM_DATABASE_URL:marker,ALTERNATE_OWNER_DATABASE_URL:marker,GITHUB_RUN_ID:'new-consumer-run',GITHUB_WORKFLOW:'new-consumer'});
 assert.equal(value.PATH,'/usr/bin:/bin');assert(!JSON.stringify(value).includes(marker));assert.equal(value.AIHR_CI_HEAD,CONTRACT.originalCandidate);assert.equal(value.AIHR_CI_MIGRATION_BASE,CONTRACT.originalMigrationBase);assert.equal(value.AIHR_ORIGINAL_REPLAY_SCOPE,'old-plan-comparison-only');
 assert(!Object.hasOwn(value,'GITHUB_RUN_ID'));assert(!Object.hasOwn(value,'GITHUB_WORKFLOW'));for(const key of ['DATABASE_URL','MIGRATION_DATABASE_URL','TEST_DATABASE_URL','TEST_MIGRATION_DATABASE_URL'])assert.equal(value[key],'postgres://nobody:nothing@127.0.0.1:1/no_database');
});
test('public failure output uses only closed phases and never reflects raw error, path or metadata content',()=>{
 for(const phase of ['admission','api-before','download','extract','api-after','comparison','api-final','publish'])assert.deepEqual(publicFailure(phase),{kind:'ORIGINAL_CATALOGUE_REPLAY_DIAGNOSTIC',complete:false,phase,expectedProfileAuthorized:false,releaseAuthorized:false});assert.throws(()=>publicFailure('FICTIONAL_PRIVATE_PATH'));assert(!JSON.stringify(publicFailure('comparison')).includes('FICTIONAL'));
 let actual;assert.equal(publishPublicFailure('comparison',bytes=>{actual=bytes;}),true);assert.deepEqual(JSON.parse(actual),publicFailure('comparison'));
 assert.equal(publishPublicFailure('publish',()=>{throw Error('FICTIONAL_PRIVATE_PATH_ENOSPC');}),false);
});
test('public comparison grammar preserves ORIGINAL scope, observed2308 and false profile/release/full-suite claims',()=>{
 const value=comparison();assert.equal(validatePublicComparison(value),value);for(const change of [v=>v.originalRun='foreign',v=>v.originalCandidate='f'.repeat(40),v=>v.originalController='f'.repeat(40),v=>v.originalPlanReconstructed=false,v=>v.originalPlanFingerprint='f'.repeat(64),v=>v.expectedProfileAuthorized=true,v=>v.releaseAuthorized=true,v=>v.completeSuite=true,v=>v.comparison.functionCount=2300,v=>v.comparison.exactRawDefaultsEqual=false,v=>v.comparison.shiftedFunctions=0,v=>v.extra='FICTIONAL_PRIVATE']){const bad=comparison();change(bad);assert.throws(()=>validatePublicComparison(bad));}
});
test('public membership and actual member IO refuse foreign entries, oversized receipts, links and noncanonical hashes',async()=>{
 for(const change of [v=>v.members.pop(),v=>v.members[1]=clone(v.members[0]),v=>v.members[0].mode='foreign',v=>v.members[0].name='private',v=>v.members[0].sha256+='\n',v=>v.members[0].bytes=16*1024**2+1,v=>v.members.find(r=>r.name.startsWith('personnel-')).bytes=32769,v=>v.units[0].sourceMembers--,v=>v.units[0].tests=0,v=>v.units[0].extra='private',v=>v.members[0].extra='private']){const value=comparison();change(value);assert.throws(()=>validatePublicComparison(value));}
 const{mkdtempSync,writeFileSync,symlinkSync,linkSync,unlinkSync,rmSync,realpathSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{readOriginalMember}=await import('./worker.mjs');
 const directory=realpathSync(mkdtempSync(join(tmpdir(),'original-replay-member-'))),member=join(directory,'member.json'),alias=join(directory,'alias.json');
 try{
  writeFileSync(member,'{}\n');assert.equal(readOriginalMember(member).toString('utf8'),'{}\n');
  symlinkSync(member,alias);assert.throws(()=>readOriginalMember(alias));unlinkSync(alias);
  linkSync(member,alias);assert.throws(()=>readOriginalMember(member));unlinkSync(alias);
  writeFileSync(member,Buffer.alloc(32769));assert.throws(()=>readOriginalMember(member,32768));
  writeFileSync(member,'');assert.throws(()=>readOriginalMember(member));assert.throws(()=>readOriginalMember(directory));
 }finally{rmSync(directory,{recursive:true,force:true});}
});
test('manual workflow has no arbitrary origin inputs, mutable actions, deployment or secret/provider inputs',async()=>{
 const{readFileSync}=await import('node:fs'),text=readFileSync(new URL('../../../workflows/notification-original-catalogue-replay.yml',import.meta.url),'utf8');
 assert(text.includes('  workflow_dispatch:'));assert(!/^\s+inputs:/m.test(text));assert(text.includes('  contents: read')&&text.includes('  actions: read'));assert(!/permissions:\s*write|contents:\s*write|actions:\s*write|secrets\.|ssh|deploy\b/i.test(text));
 const actions=[...text.matchAll(/uses: ([^\s]+)/g)].map(m=>m[1]);assert(actions.length>=4&&actions.every(a=>/@[a-f0-9]{40}$/.test(a)));assert(text.includes('ref: '+CONTRACT.originalCandidate));assert(text.includes('node-version: 22.23.3'));assert(text.includes('version: 10.33.2'));assert(text.includes('--frozen-lockfile --ignore-scripts'));
});
test('token-bearing API owner imports no original comparator or candidate modules and has no numeric group fallback',async()=>{
 const{readFileSync}=await import('node:fs'),parent=readFileSync(new URL('parent.mjs',import.meta.url),'utf8'),worker=readFileSync(new URL('worker.mjs',import.meta.url),'utf8');
 assert(!parent.includes('compareCanonicalReplayMembers'));assert(!/await import\(|import\(/.test(parent));assert(!/process\.kill\(-|detached\s*:/.test(parent));assert(parent.includes('child.stdin.end()'));assert(parent.includes('Qualified shared process owner not integrated'));
 assert(worker.includes('createPlan(original)'));assert(worker.includes('verifyUnitReport(local,report,{runId:String(CONTRACT.run.id),attempt:\'1\'})'));assert(worker.includes('compareCanonicalReplayMembers(modes[0],modes[1]'));assert(worker.includes('COMPLETE original source-owned plan reconstruction differs'));
});
test('artifact publication is restricted to result and filtered API provenance, never any raw private capture path',async()=>{
 const{readFileSync}=await import('node:fs'),text=readFileSync(new URL('../../../workflows/notification-original-catalogue-replay.yml',import.meta.url),'utf8');
 const block=text.slice(text.indexOf('          path: |'));assert(block.includes('original-catalogue-replay-public/result.json'));assert(block.includes('original-catalogue-replay-public/api-proof.json'));assert(!/original-catalogue-replay-private|canonical-raw|canonical-source|\.zip|\/\*|\.\*\//.test(block));
});
test('parent cancellation closes admission and drains each actual handle including the EOF-only adapter',async()=>{
 const owner=directChildren(),api=new EventEmitter(),adapter=new EventEmitter(),stops=[];
 api.kill=signal=>{stops.push(['api',signal]);};
 owner.start(()=>api);owner.start(()=>adapter,child=>{assert.equal(child,adapter);stops.push(['adapter','EOF']);});
 owner.cancel();owner.cancel();assert.deepEqual(stops,[['api','SIGKILL'],['adapter','EOF']]);let admitted=false;
 assert.throws(()=>owner.start(()=>{admitted=true;return new EventEmitter();}));assert.equal(admitted,false);
 let settled=false;const draining=owner.finish().then(result=>{settled=true;return result;});await Promise.resolve();assert.equal(settled,false);
 api.emit('close',null,'SIGKILL');await Promise.resolve();assert.equal(settled,false);adapter.emit('close',1,null);
 assert.deepEqual(await draining,{cancelled:true,stopFailed:false});
});
test('a failed stop cannot skip another owned stop or permit early finish before both close events',async()=>{
 const owner=directChildren(),a=new EventEmitter(),b=new EventEmitter();let stoppedB=false;
 owner.start(()=>a,()=>{throw Error('FICTIONAL_PRIVATE_STOP');});owner.start(()=>b,()=>{stoppedB=true;});owner.cancel();assert.equal(stoppedB,true);
 let settled=false;const draining=owner.finish().then(result=>{settled=true;return result;});a.emit('close',1,null);await Promise.resolve();assert.equal(settled,false);b.emit('close',1,null);
 assert.deepEqual(await draining,{cancelled:true,stopFailed:true});assert.throws(()=>owner.start(()=>new EventEmitter()));
});

test('the registered manual diagnostic route is byte-identical to the reviewed closed replay workflow',async()=>{
 const{readFileSync}=await import('node:fs');
 const reviewed=readFileSync(new URL('../../../workflows/notification-original-catalogue-replay.yml',import.meta.url));
 const registered=readFileSync(new URL('../../../workflows/alpha-staging-diagnostics.yml',import.meta.url));
 assert(reviewed.equals(registered));assert(!/inputs:|push:|pull_request:/.test(registered.toString('utf8')));
});
