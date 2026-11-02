/** Execute the actual candidate guard body with private fixture environment; no SSH or app runtime. */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,rmSync,constants} from 'node:fs';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import {customerEnvironmentErrors} from '../../deploy/check-customer-env.mjs';
import {STAGING_BUILD_RUNTIME as runtime} from './build-production.mjs';
import {stagingProfileProbeCommand,validateStagingProfile,DEPLOY_RUNTIME_SELECTION,validateCandidateRuntimeSelection,resolveBaselineNext,probeStagingProfile} from './staging-preflight.mjs';
const fixturePackageBytes=Buffer.from(JSON.stringify({dependencies:{next:runtime.next}})+'\n');
const fixturePackageSha256=createHash('sha256').update(fixturePackageBytes).digest('hex');
const packageHash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fixture={NODE_ENV:'production',AUTH_PROVIDER:'internal',ALLOW_DEMO_SESSION:'false',AUTH_PUBLIC_ORIGIN:'https://hr.customer.org',AUTH_SESSION_KEY:'a'.repeat(64),AI_CONFIG_SECRET:'private-fixture-config-value',AUDIT_HASH_CHAIN_ENABLED:'true',DATABASE_URL:'postgres://ai_hr_app:private-fixture-db@127.0.0.1/hr',MIGRATION_DATABASE_URL:'postgres://ai_hr_owner:private-fixture-owner@127.0.0.1/hr'};
function observe(changes={},observedRuntime=runtime,packageBytes=fixturePackageBytes){
 const command=stagingProfileProbeCommand(customerEnvironmentErrors),delimiter="<<'AIHR_PROFILE_PREFLIGHT_NODE'\n";
 assert.equal(command.split(delimiter).length,2);const source=command.split(delimiter)[1].split('\nAIHR_PROFILE_PREFLIGHT_NODE')[0];
 assert(source.startsWith("import {accessSync,constants,realpathSync,readFileSync} from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';\n"));
 let output;
 runInNewContext(source.slice(source.indexOf('\n')+1),{URL,path,constants,createHash,accessSync:()=>{const e=new Error('absent fixture file');e.code='ENOENT';throw e;},readFileSync:name=>name==='package.json'?packageBytes:JSON.stringify({version:observedRuntime.next}),process:{env:{...fixture,...changes},cwd:()=>'/private-fixture',platform:observedRuntime.platform,arch:observedRuntime.arch,versions:{node:observedRuntime.node,modules:observedRuntime.abi},report:{getReport:()=>({header:{glibcVersionRuntime:observedRuntime.glibc}})}},console:{log:value=>{assert.equal(output,undefined);output=value;}}});
 assert(typeof output==='string');return {command,report:JSON.parse(output),output};
}
test('actual Node20/customer gap is reproduced before artifact or source work',()=>{
 const {report,output}=observe({DEV_TENANT_ID:'fixture-tenant',DEV_USER_ID:'fixture-user',AUDIT_HASH_CHAIN_ENABLED:undefined},{...runtime,node:'20.20.2',abi:'115'});
 assert.equal(report.ok,false);assert.equal(report.profile,'customer');
 assert(report.errors.some(e=>e.includes('Node.js 22.13+')));assert(report.errors.some(e=>e.includes('DEV_TENANT_ID')));assert(report.errors.some(e=>e.includes('DEV_USER_ID')));assert(report.errors.some(e=>e.includes('AUDIT_HASH_CHAIN_ENABLED')));
 assert.throws(()=>validateStagingProfile(report,customerEnvironmentErrors,runtime.next,fixturePackageSha256),/before CI archive download\/source transfer/);
 for(const secret of [fixture.DATABASE_URL,fixture.MIGRATION_DATABASE_URL,fixture.AUTH_SESSION_KEY,fixture.AI_CONFIG_SECRET])assert(!output.includes(secret));
});
test('demo branch matches actual default deploy predicate and never grants release authority',()=>{
 const {command,report}=observe({ALLOW_DEMO_SESSION:'true'});assert.equal(report.profile,'demo');assert.equal(report.ok,true);assert.equal(report.releaseAuthorized,false);
 assert.equal(validateStagingProfile(report,customerEnvironmentErrors,runtime.next,fixturePackageSha256),report);
 assert(command.includes('set -a\n. ./.env.production\nset +a\nnode'));assert(command.includes(DEPLOY_RUNTIME_SELECTION));assert(command.startsWith("bash -s <<'AIHR_PROFILE_PREFLIGHT_SHELL'"));assert(!command.includes('--env-file'));assert(!command.includes('deploy-state.sh'));
});
for(const [name,change] of [['unknown field',r=>r.secret='bad'],['wrong checker',r=>r.checkerSha256='f'.repeat(64)],['wrong native runtime',r=>r.runtime.abi='115'],['invented pass',r=>{r.errors=['actual refusal'];r.ok=true;}],['invented release',r=>r.releaseAuthorized=true],['unknown profile',r=>r.profile='bypass']])test('refuse '+name,()=>{const {report}=observe({ALLOW_DEMO_SESSION:'true'});change(report);assert.throws(()=>validateStagingProfile(report,customerEnvironmentErrors,runtime.next,fixturePackageSha256));});
test('normal, unchanged-source, browser-capacity and repaired-source operators await profile before archives and repeat it before launch',()=>{
 const source=readFileSync(new URL('./operator-release.mjs',import.meta.url),'utf8');
 const early='const profilePreflight=await probeStagingProfile({candidatePath,baseline,ssh});',verify='const evidence=browserRecovery?await verifyBrowserRecoveredCi({...browserRecovery,candidatePath,runId,baseline}):repair?await verifyRepairedCi({...repair,candidatePath,runId,baseline}):recovering?await verifyRecoveredCi({candidatePath,runId,baseline,focusedRunIds:recoveryRunIds}):await verifyCi({candidatePath,runId,baseline});';
 assert.equal(source.split(early).length,2);assert.equal(source.split(verify).length,2);assert(source.indexOf(early)>=0&&source.indexOf(early)<source.indexOf(verify));
 const observedBaseline='const initial=current(),baseline=baselineRules.readyProductionBaseline(initial);';
 assert.equal(source.split(observedBaseline).length,2);assert(source.indexOf(observedBaseline)<source.indexOf(early));
 assert(source.includes('const revalidate=async({announced=false}={})=>{await probeStagingProfile({candidatePath,baseline,announced,ssh});await (browserRecovery?revalidateBrowserRecoveredCi(evidence):repair?revalidateRepairedCi(evidence):recovering?revalidateRecoveredCi(evidence):revalidateCi(evidence));'));
});

test('CI runtime branch is line-anchored and refuses a default-only substring match',()=>{const source=readFileSync(new URL('../../deploy/deploy.sh',import.meta.url),'utf8');assert.doesNotThrow(()=>validateCandidateRuntimeSelection(source));const marker='if [ -n "$AIHR_SELECTED_CI_BUILD_INSTALL" ]; then';assert(source.includes(marker));assert.throws(()=>validateCandidateRuntimeSelection(source.replace(marker,'elif [ -n "$AIHR_SELECTED_CI_BUILD_INSTALL" ]; then')));});
test('early probe mirrors the CI-specific pinned runtime branch, not the default runtime preference',()=>{const command=stagingProfileProbeCommand(customerEnvironmentErrors);assert(command.includes('CI build installation requires its pinned Node22 runtime'));});

test('valid customer fixture accepts only the exact future native target',()=>{const {report}=observe();assert.equal(report.profile,'customer');assert.equal(report.ok,true);assert.equal(validateStagingProfile(report,customerEnvironmentErrors,runtime.next,fixturePackageSha256),report);});


function baselineFixture(t,baselineNext='16.3.8',candidateNext=runtime.next){
 const directory=mkdtempSync(path.join(tmpdir(),'aihr-preflight-baseline-'));
 t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const git=(...args)=>execFileSync('git',['-C',directory,...args],{encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
 git('init','-q');git('config','user.name','Profile fixture');git('config','user.email','profile-fixture@example.test');git('config','commit.gpgsign','false');
 const packageBytes=next=>JSON.stringify({dependencies:{next}})+'\n';
 const baselineBytes=baselineNext===null?'{}\n':packageBytes(baselineNext);
 writeFileSync(path.join(directory,'package.json'),baselineBytes);git('add','package.json');git('commit','-qm','Accepted baseline fixture');
 const baseline=git('rev-parse','HEAD');
 writeFileSync(path.join(directory,'package.json'),packageBytes(candidateNext));git('add','package.json');git('commit','--allow-empty','-qm','Incoming dependency fixture');
 return {directory,baseline,baselineBytes,git};
}
test('resolve the installed Next version from the exact immutable ancestor package, retaining its byte identity',t=>{
 const f=baselineFixture(t),result=resolveBaselineNext(f.directory,f.baseline);
 assert.deepEqual(result,{baseline:f.baseline,baselineNext:'16.3.8',baselinePackageSha256:createHash('sha256').update(f.baselineBytes).digest('hex'),candidatePackageSha256:fixturePackageSha256});
 const {report}=observe({},{...runtime,next:result.baselineNext},Buffer.from(f.baselineBytes));
 assert.equal(validateStagingProfile(report,customerEnvironmentErrors,result.baselineNext,result.baselinePackageSha256),report);
 assert.throws(()=>validateStagingProfile(report,customerEnvironmentErrors,runtime.next,fixturePackageSha256),/installed baseline Next/);
});
test('same-version installations still require the exact pinned toolchain and Git baseline',t=>{
 const f=baselineFixture(t,runtime.next),result=resolveBaselineNext(f.directory,f.baseline);
 assert.equal(result.baselineNext,runtime.next);
 assert.equal(validateStagingProfile(observe().report,customerEnvironmentErrors,result.baselineNext,result.baselinePackageSha256).runtime.next,runtime.next);
});
for(const value of [null,'latest','^16.3.8','16.3.8 || 16.4.1'])test('refuse a missing or ranged baseline Next: '+String(value),t=>{
 const f=baselineFixture(t,value);assert.throws(()=>resolveBaselineNext(f.directory,f.baseline),/exact pinned release/);
});
test('refuse an incoming candidate that differs from the pinned CI framework runtime',t=>{
 const f=baselineFixture(t,'16.3.8','16.3.8');assert.throws(()=>resolveBaselineNext(f.directory,f.baseline),/Candidate Next/);
});
test('refuse an available but unrelated baseline commit',t=>{
 const f=baselineFixture(t),tree=f.git('rev-parse',f.baseline+'^{tree}');
 const unrelated=execFileSync('git',['-C',f.directory,'commit-tree',tree],{input:'Unrelated baseline fixture\n',encoding:'utf8'}).trim();
 assert.throws(()=>resolveBaselineNext(f.directory,unrelated),/ancestor/);
});
test('refuse a dirty candidate before resolving baseline inputs',t=>{
 const f=baselineFixture(t);writeFileSync(path.join(f.directory,'unreviewed'),'not frozen');
 assert.throws(()=>resolveBaselineNext(f.directory,f.baseline),/exact clean source/);
});
test('require a full available baseline identity, never a mutable branch or fallback',t=>{
 const f=baselineFixture(t);
 for(const value of [undefined,'','HEAD',f.baseline.slice(0,12),'f'.repeat(40)])assert.throws(()=>resolveBaselineNext(f.directory,value));
});
test('invalid baseline refuses before any remote environment probe',async t=>{
 const f=baselineFixture(t);let calls=0;
 await assert.rejects(probeStagingProfile({candidatePath:f.directory,baseline:'HEAD',ssh:()=>{calls++;throw Error('must not probe');}}),/full staging baseline/);
 assert.equal(calls,0);
});
for(const [name,change] of [['Node',{node:'24.0.0'}],['ABI',{abi:'115'}],['OS',{platform:'darwin'}],['architecture',{arch:'arm64'}],['glibc',{glibc:'2.40'}],['installed framework',{next:'16.0.0'}]])test('baseline-aware upgrade still refuses incorrect '+name,()=>{
 const bytes=Buffer.from(JSON.stringify({dependencies:{next:'16.3.8'}})+'\n');
 const {report}=observe({},{...runtime,next:'16.3.8',...change},bytes);
 assert.throws(()=>validateStagingProfile(report,customerEnvironmentErrors,'16.3.8',packageHash(bytes)));
});
test('observed incoming Next is not substituted for the current accepted baseline',()=>{
 const {report}=observe();assert.throws(()=>validateStagingProfile(report,customerEnvironmentErrors,'16.3.8',fixturePackageSha256),/installed baseline Next/);
 for(const value of [undefined,'latest','^16.3.8'])assert.throws(()=>validateStagingProfile(report,customerEnvironmentErrors,value,fixturePackageSha256),/pinned baseline Next/);
});


test('same-version package tampering is rejected by observed remote bytes',()=>{
 const bytes=Buffer.from(JSON.stringify({dependencies:{next:runtime.next},description:'unreviewed change'})+'\n');
 const {report}=observe({},runtime,bytes);
 assert.equal(report.runtime.next,runtime.next);
 assert.notEqual(report.observedPackageSha256,fixturePackageSha256);
 assert.throws(()=>validateStagingProfile(report,customerEnvironmentErrors,runtime.next,fixturePackageSha256),/Observed staging package bytes/);
});
test('an expected package hash is mandatory and missing or forged observations refuse',()=>{
 const {report}=observe();
 for(const value of [undefined,'','not-a-hash'])assert.throws(()=>validateStagingProfile(report,customerEnvironmentErrors,runtime.next,value),/expected source package hash/);
 assert.throws(()=>validateStagingProfile({...report,observedPackageSha256:'f'.repeat(64)},customerEnvironmentErrors,runtime.next,fixturePackageSha256),/Observed staging package bytes/);
 const {observedPackageSha256,...missing}=report;
 assert.throws(()=>validateStagingProfile(missing,customerEnvironmentErrors,runtime.next,fixturePackageSha256),/Unexpected profile report/);
});
function probeFixture(t){
 const f=baselineFixture(t);mkdirSync(path.join(f.directory,'deploy'));
 for(const file of ['check-customer-env.mjs','deploy.sh'])writeFileSync(path.join(f.directory,'deploy',file),readFileSync(new URL('../../deploy/'+file,import.meta.url)));
 f.git('add','deploy');f.git('commit','-qm','Exact deployment probe fixture');return f;
}
test('real probe compares baseline bytes before transfer and candidate bytes only in the guarded announced phase',async t=>{
 const f=probeFixture(t),oldRuntime={...runtime,next:'16.3.8'};
 const old=observe({},oldRuntime,Buffer.from(f.baselineBytes)).output;
 const incoming=observe({},oldRuntime,fixturePackageBytes).output;
 const pre=await probeStagingProfile({candidatePath:f.directory,baseline:f.baseline,ssh:()=>old});
 assert.equal(pre.sourcePhase,'baseline');assert.equal(pre.observedPackageSha256,pre.baselinePackageSha256);
 assert.equal(pre.expectedPackageSha256,pre.baselinePackageSha256);assert.equal(pre.runtime.next,'16.3.8');assert.equal(pre.releaseAuthorized,false);
 const post=await probeStagingProfile({candidatePath:f.directory,baseline:f.baseline,announced:true,ssh:()=>incoming});
 assert.equal(post.sourcePhase,'candidate');assert.equal(post.observedPackageSha256,post.candidatePackageSha256);
 assert.equal(post.expectedPackageSha256,post.candidatePackageSha256);assert.equal(post.runtime.next,'16.3.8');assert.equal(post.releaseAuthorized,false);
 await assert.rejects(probeStagingProfile({candidatePath:f.directory,baseline:f.baseline,announced:true,ssh:()=>old}),/Observed staging package bytes/);
 await assert.rejects(probeStagingProfile({candidatePath:f.directory,baseline:f.baseline,ssh:()=>incoming}),/Observed staging package bytes/);
});
test('real pre-transfer probe rejects same-version package tampering',async t=>{
 const f=probeFixture(t),bytes=Buffer.from(JSON.stringify({dependencies:{next:'16.3.8'},description:'unreviewed baseline bytes'})+'\n');
 const tampered=observe({},{...runtime,next:'16.3.8'},bytes).output;
 await assert.rejects(probeStagingProfile({candidatePath:f.directory,baseline:f.baseline,ssh:()=>tampered}),/Observed staging package bytes/);
});
test('source phase must be a boolean before any remote read',async t=>{
 const f=baselineFixture(t);let calls=0;
 await assert.rejects(probeStagingProfile({candidatePath:f.directory,baseline:f.baseline,announced:'true',ssh:()=>{calls++;}}),/boolean source phase/);
 assert.equal(calls,0);
});
