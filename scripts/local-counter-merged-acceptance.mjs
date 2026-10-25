/** One pinned H/login composition. Historical passes keep their actual origins. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {isDeepStrictEqual as equal} from 'node:util';
import {pathToFileURL} from 'node:url';
import {sha256} from './local-counter-exception.mjs';
import {collectCounterException,boundedReader,COUNTER_REPAIR} from './local-counter-exception-evidence.mjs';
import {validateCounterRepairProof,validateWalkthrough} from './local-counter-exception-acceptance.mjs';
import {verifyReports} from '../.github/ci/verify-shards.mjs';
import {verifyFocusedResult} from '../.github/ci/focused-checks.mjs';
import {buildUnits,hash,requiredEvidence,CI_EXECUTION} from '../.github/ci/manifest.mjs';

export const MERGED_EXCEPTION=Object.freeze({
  version:3,repository:'StradaverseHub/ai-hr',candidate:'3c51317ea43ded103e782c37b55eccf9fdeae05c',
  counterChild:'4d89d52005121d25f2b1cb5801cd04df32dfd32e',
  final:'fbef89f0c806c4e5f26ff0e58d788228b4dcb760',
  baseline:'ac7169589ee377d5d50427565dc695c038fb7d9c',aligned:'7aa5e169a0a94f90cffb000cf5d99093fe442d91',
  common:'1a45bbe0ee2dc68fd4ac62a0c362b6d189b7ef7c',peerRun:40211894222,
  migrationBase:'c98bfed60f6330b57f5a67d959ce6e3757df3b53',
  buildId:'WTZfAR4DhZ-wiLGGNG7Mm',manifest:'23bd34ec834a5a9098648c9d576d2efa3ce8da24323eb6716fc11089d99de333',
});
export const ACCEPTANCE_TIER='owner-counter-login-composition-v3';
export const HISTORICAL_SOURCE='/Users/zenlam/Projects/ai-hr/.claude/worktrees/h-counter-origin-4d89-20261026';
export const PEER_EVIDENCE='/Users/zenlam/.codex/visualizations/2026/10/25/01a17397-0f2f-7223-af6e-9ba43c94d62b/login-atelier/approved-staging-release';
const P=MERGED_EXCEPTION,need=(v,why)=>assert(v,'Merged owner exception refused: '+why);
const git=(cwd,...args)=>execFileSync('git',args,{cwd,timeout:30000,maxBuffer:128*1024**2});
const text=(cwd,...args)=>git(cwd,...args).toString().trim();
const gh=path=>JSON.parse(execFileSync('gh',['api','repos/'+P.repository+'/'+path],{timeout:30000,maxBuffer:4*1024**2,encoding:'utf8'}));
export function verifyFreshMergedResult(result,files,cwd,expectedCases){
  need((result.numPendingTests??0)===0&&(result.numPendingTestSuites??0)===0&&(result.numTodoTests??0)===0,'pending/todo merged result');
  need(verifyFocusedResult(result,files,cwd)===expectedCases,'merged assertion inventory differs');return expectedCases;
}
const leaves=(value,prefix='',out=new Map())=>{if(value&&typeof value==='object'&&!Array.isArray(value))for(const [k,v]of Object.entries(value))leaves(v,prefix?prefix+'.'+k:k,out);else out.set(prefix,JSON.stringify(value));return out;};
/** Preserve both parents' disjoint locale edits, including deletions; reject collisions. */
export function verifyLocaleComposition(base,h,peer,merged){
  const maps=[base,h,peer,merged].map(v=>leaves(v)),[b,a,p,m]=maps;
  const changed=x=>[...new Set([...b.keys(),...x.keys()])].filter(k=>b.get(k)!==x.get(k)).sort();
  const hc=changed(a),pc=changed(p);need(hc.length===17&&pc.length===43&&!hc.some(k=>pc.includes(k)),'locale edit boundaries differ');
  const expected=new Map(b);for(const [source,keys]of [[a,hc],[p,pc]])for(const k of keys)source.has(k)?expected.set(k,source.get(k)):expected.delete(k);
  need(equal([...expected].sort(),[...m].sort()),'merged locale changed an unrelated value');
  return {hChangedLeaves:hc,peerChangedLeaves:pc,disjoint:true,allOtherValuesPreserved:true};
}
/** Frozen refs and exact parents are authority; this is not a general merge/reuse policy. */
export function mergedSourceBoundary(candidatePath){
  need(text(candidatePath,'rev-parse','HEAD')===P.final&&!text(candidatePath,'status','--porcelain'),'wrong or dirty merged candidate');
  need(text(candidatePath,'show','-s','--format=%P',P.final)===P.counterChild+' '+P.aligned,'merged parents differ');
  need(text(candidatePath,'show','-s','--format=%P',P.counterChild)===P.candidate,'counter child differs');
  need(text(candidatePath,'merge-base',P.counterChild,P.aligned)===P.common,'merge base differs');
  need(text(candidatePath,'diff','--name-only',P.baseline,P.aligned)==='docs/HANDOFF-HISTORY.md','published baseline changes product');
  need(equal(text(candidatePath,'diff','--name-only',P.candidate,P.counterChild).split('\n').sort(),Object.keys(COUNTER_REPAIR.files).sort()),'counter changed unrelated source');
  for(const [file,hash]of Object.entries(COUNTER_REPAIR.files))need(sha256(git(candidatePath,'show',P.final+':'+file))===hash&&sha256(git(candidatePath,'show',P.counterChild+':'+file))===hash,'counter bytes differ');
  const rows=git(candidatePath,'ls-tree','-r','-z',P.final).toString().split('\0').filter(Boolean),paths=rows.map(r=>r.slice(r.indexOf('\t')+1));
  const blob=(ref,path)=>{const row=text(candidatePath,'ls-tree',ref,'--',path);return row?row.split(/\s+/)[2]:null;};
  const changed=text(candidatePath,'diff','--name-only',P.common,P.final).split('\n');
  const localeProof=[];
  for(const path of changed){
    if(/^messages\/(?:en|ms|ta|th|vi|zh)\.json$/.test(path)){
      const values=[P.common,P.counterChild,P.baseline,P.final].map(ref=>JSON.parse(git(candidatePath,'show',ref+':'+path)));
      localeProof.push({path,...verifyLocaleComposition(...values)});continue;
    }
    if(path==='docs/HANDOFF-HISTORY.md')continue;
    const b=blob(P.common,path),h=blob(P.counterChild,path),p=blob(P.baseline,path),m=blob(P.final,path);
    // The attendance conflict deliberately retains H's stronger historical fixture/refusal controls.
    const explained=path==='test/attendance-policy-storage.test.ts'||h===b||p===b||h===p;
    const expected=path==='test/attendance-policy-storage.test.ts'?h:h===b?p:p===b?h:h;
    need(explained&&m===expected,'unexplained merged source: '+path);
  }
  need(localeProof.length===6,'incomplete locale composition');
  const browsers=paths.filter(p=>p.startsWith('test/')&&p.endsWith('.browser.test.tsx')).sort();need(browsers.length===16,'browser inventory changed');
  for(const path of [...browsers,'vitest.browser.config.ts','test/browser-setup.ts','app/globals.css','postcss.config.mjs','package.json','pnpm-lock.yaml','tsconfig.json'])need(blob(P.final,path)===blob(P.baseline,path),'browser/tool input changed: '+path);
  const retainedRewardClosure=["lib/notice-upload-policy.ts", "lib/profile-photo-limits.ts", "lib/system-testing/hash.ts", "lib/system-testing/model.ts", "next.config.ts", "package.json", "packs/rewards/document-reader.ts", "pnpm-lock.yaml", "postcss.config.mjs", "scripts/improve/system-testing-manifest.ts", "scripts/improve/system-testing-next-config.ts", "test/browser-setup.ts", "test/rewards-documents.browser.test.tsx", "tsconfig.json", "vitest.browser.config.ts"];
  for(const path of retainedRewardClosure)need(blob(P.final,path)===blob(P.baseline,path),'retained rewards browser closure changed: '+path);
  return {original:P.candidate,counterChild:P.counterChild,final:P.final,counterRepairApplied:true,parents:[P.counterChild,P.aligned],publishedBaseline:P.aligned,actualBaseline:P.baseline,localeProof,browsers,retainedRewardClosure};
}

/** Independent immutable source reader for the already executed CI inventory. */
async function reconstructPeerPlan(candidatePath,plan){
  const rows=git(candidatePath,'ls-tree','-r','-z',P.baseline).toString().split('\0').filter(Boolean);
  const entries=rows.map(row=>{const m=/^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(row);return m?{id:m[2],path:m[3]}:null;}).filter(Boolean);
  const sourceEntries=entries.filter(e=>/\.(?:[cm]?[jt]sx?|json|css)$/.test(e.path));
  const ids=[...new Set(sourceEntries.map(e=>e.id))],raw=execFileSync('git',['cat-file','--batch'],{cwd:candidatePath,input:ids.join('\n')+'\n',timeout:30000,maxBuffer:128*1024**2});
  const blobs=new Map();let at=0;
  for(const id of ids){const end=raw.indexOf(10,at),[actual,kind,size]=raw.subarray(at,end).toString().split(' ');need(actual===id&&kind==='blob'&&Number.isSafeInteger(+size)&&+size>=0,'bad source blob');at=end+1;need(at+ +size<raw.length&&raw[at+ +size]===10,'truncated source blob');blobs.set(id,raw.subarray(at,at+ +size).toString());at+= +size+1;}need(at===raw.length,'source blob suffix');
  const files=new Map(sourceEntries.map(e=>[e.path,blobs.get(e.id)]));
  need(sha256(readFileSync(join(HISTORICAL_SOURCE,'scripts/gate-db-classify.ts')))===sha256(git(candidatePath,'show',P.baseline+':scripts/gate-db-classify.ts')),'classifier source differs');
  const module=await import(pathToFileURL(join(HISTORICAL_SOURCE,'scripts/gate-db-classify.ts')).href),classify=module.classifyTestFiles??module.default?.classifyTestFiles;
  const suite=entries.map(e=>e.path).filter(p=>/^test\/.+\.(?:test\.ts|dom\.test\.tsx)$/.test(p)).sort();
  const groups=classify(suite,p=>files.get(p)??null),browsers=entries.map(e=>e.path).filter(p=>p.startsWith('test/')&&p.endsWith('.browser.test.tsx')).sort();
  const body={schemaVersion:2,policyVersion:'aihr-staging-ci/v2',sha:P.baseline,controller:P.common,migrationBase:P.migrationBase,runtime:{node:'22.23.3',platform:'linux',arch:'x64'},execution:CI_EXECUTION,suite,units:buildUnits(suite,groups,browsers)};
  need(equal({...body,fingerprint:hash(body)},plan),'historical CI manifest differs from immutable source');return body;
}

async function collectPeerEvidence(candidatePath,artifacts){
  const root=realpathSync(PEER_EVIDENCE),read=boundedReader(root,'peerCI',artifacts),json=p=>JSON.parse(read(p));
  const run=gh('actions/runs/'+P.peerRun),inventory=gh('actions/runs/'+P.peerRun+'/artifacts?per_page=100');
  need(run.id===P.peerRun&&run.repository?.id===1333414856&&run.head_repository?.id===1333414856&&run.repository?.full_name===P.repository&&run.workflow_id===395777276&&run.path==='.github/workflows/alpha-staging.yml'&&run.head_sha===P.common&&run.head_branch==='main'&&run.status==='completed'&&run.conclusion==='success'&&run.run_attempt===2,'historical CI run changed');
  const plan=json('gate-plan/ci-plan.json');await reconstructPeerPlan(candidatePath,plan);
  const expected=requiredEvidence(plan),items=inventory.artifacts;need(inventory.total_count===25&&items?.length===25&&equal(items.map(a=>a.name).sort(),expected.artifacts.slice().sort()),'historical artifact set changed');
  for(const item of items){const w=item.workflow_run;need(item.expired===false&&Number.isSafeInteger(item.id)&&item.size_in_bytes>0&&item.size_in_bytes<=64*1024**2&&/^sha256:[a-f0-9]{64}$/.test(item.digest??'')&&w?.id===P.peerRun&&w.repository_id===1333414856&&w.head_repository_id===1333414856&&w.head_sha===P.common&&w.head_branch==='main','foreign artifact');}
  const bound=JSON.parse(execFileSync('python3',[join(new URL('.',import.meta.url).pathname,'local-counter-peer-archive.py'),root],{input:JSON.stringify(items),encoding:'utf8',timeout:30000,maxBuffer:2*1024**2}));
  artifacts.push(...bound.map(x=>({group:'peerCI',...x})));
  const reports=plan.units.map(u=>json('unit-'+u.id+'/unit-'+u.id+'.json')),receipt=json('gate-evidence/ci-receipt.json');need(equal(verifyReports(plan,reports),receipt)&&receipt.suiteFiles===1948&&receipt.tests===27869,'historical raw coverage differs');
  for(const report of reports.filter(r=>r.id.startsWith('browser-'))){const raw=report.batches.flatMap(b=>b.result.testResults),reward=raw.filter(r=>r.name.endsWith('/test/rewards-documents.browser.test.tsx'));need(raw.length===16&&raw.reduce((n,r)=>n+r.assertionResults.length,0)===251&&reward.length===1&&reward[0].assertionResults.length===4,'retained historical browser cases differ');}
  const attempts=[];for(const attempt of [1,2]){const j=gh('actions/runs/'+P.peerRun+'/attempts/'+attempt+'/jobs?per_page=100');need(j.total_count===j.jobs.length,'paginated jobs');for(const job of j.jobs)need(job.run_id===P.peerRun&&job.run_attempt===attempt&&job.head_sha===P.common,'foreign job');attempts.push(j.jobs);}
  const origins=[];for(const name of expected.jobs){const pool=attempts.flat().filter(j=>j.name===name&&j.status==='completed'&&j.conclusion==='success');need(pool.length>0,'missing historical job '+name);const j=pool[0];origins.push({name,id:j.id,attempt:j.run_attempt,startedAt:j.started_at,completedAt:j.completed_at});}
  const approval=json('owner-exception.json');need(approval.candidate===P.baseline&&approval.controller===P.common&&approval.runId===P.peerRun&&approval.runAttempt===2&&approval.humanApproval==='Yes approve','peer exception identity differs');
  need(attempts[0].find(j=>j.name==='browser (webkit)')?.conclusion==='cancelled'&&attempts[0].find(j=>j.name==='verify')?.conclusion==='failure','historical failed attempt changed');
  const ledger=json('migration-ledger-after.json').ledger;need(Array.isArray(ledger)&&ledger.length===496,'historical ledger missing');
  return {observedSource:P.baseline,controller:P.common,runId:P.peerRun,runAttempt:2,rawReports:23,suiteFiles:1948,browserFiles:16,tests:27869,origins,attemptHistory:attempts.map(jobs=>jobs.map(j=>({name:j.name,id:j.id,attempt:j.run_attempt,result:j.conclusion,startedAt:j.started_at,completedAt:j.completed_at}))),originalAttemptReclassified:false,artifacts:items.map(a=>({id:a.id,name:a.name,digest:a.digest})),ledger,exceptionAppliesOnlyToHistoricalRelease:true};
}

export async function collectOwnerMergedAcceptance({candidatePath,runDirectory,counterRoot,now=Date.now()}){
  candidatePath=resolve(candidatePath);runDirectory=resolve(runDirectory);counterRoot=resolve(counterRoot);
  const boundary=mergedSourceBoundary(candidatePath);
  need(realpathSync(HISTORICAL_SOURCE)===HISTORICAL_SOURCE&&text(HISTORICAL_SOURCE,'rev-parse','HEAD')===P.counterChild&&!text(HISTORICAL_SOURCE,'status','--porcelain'),'historical source view differs');
  for(const file of ['.env.local','.gate-receipt.json'])need(sha256(readFileSync(join(HISTORICAL_SOURCE,file)))===sha256(readFileSync(join(candidatePath,file))),'historical private snapshot differs from retained execution-origin file');
  const original=await collectCounterException({candidatePath:HISTORICAL_SOURCE,runDirectory,historicalResumeDirectory:join(candidatePath,'scratchpad','ai-local-20261026-resume-03'),now});
  const artifacts=original.artifacts.map(a=>a.group==='source'?{...a,group:'historicalSource'}:a);
  const originRead=boundedReader(candidatePath,'source',artifacts);for(const file of ['.env.local','.gate-receipt.json'])need(sha256(originRead(file))===sha256(readFileSync(join(HISTORICAL_SOURCE,file))),'retained execution-origin file changed');
  const peer=await collectPeerEvidence(candidatePath,artifacts);
  need(text(counterRoot,'rev-parse','HEAD')===COUNTER_REPAIR.source&&!text(counterRoot,'status','--porcelain'),'counter root differs');
  const counter=boundedReader(counterRoot,'counter',artifacts),proof=boundedReader(join(counterRoot,'scratchpad/ai-counter-repair-20261026'),'counterProof',artifacts);
  for(const [file,hash]of Object.entries(COUNTER_REPAIR.files))need(sha256(counter(file))===hash,'counter proof source changed');
  const counterProof=validateCounterRepairProof(JSON.parse(proof('proof.json')),proof('checks.log'),{candidatePath,runDirectory,counterRoot});
  const runtime=boundedReader(join(candidatePath,'scratchpad'),'runtime',artifacts),json=p=>JSON.parse(runtime(p)),source=boundedReader(candidatePath,'source',artifacts);
  const typecheck=json('ai-local-login-20261026-build-02/typecheck.json');need(typecheck.source===P.final&&typecheck.wholeRepositoryTypecheck===true&&typecheck.exitCode===0&&typecheck.databaseConnectionsAllowed===false&&typecheck.seconds>0,'merged compiler differs');need(!runtime('ai-local-login-20261026-build-02/tsc.log').trim(),'merged compiler diagnostics');
  const build=json('ai-local-login-20261026-build-02/completed.json');need(build.source===P.final&&build.kind==='LOCAL_PRODUCTION_BUILD_NOT_RELEASE_GATE'&&build.passed===true&&build.exitCode===0&&build.buildId===P.buildId&&build.appPathsHash===P.manifest,'merged build differs');
  const buildLog=runtime('ai-local-login-20261026-build-02/production-build.log');need(buildLog.includes('Compiled successfully')&&buildLog.includes('Running TypeScript'),'merged build log incomplete');need(source('.next/BUILD_ID').trim()===P.buildId&&sha256(source('.next/server/app-paths-manifest.json'))===P.manifest,'merged build changed');
  const seam=json('ai-local-login-20261026-db-seam/completed.json'),cleanup=json('ai-local-login-20261026-db-seam/cleanup.json');
  need(seam.source===P.final&&seam.kind==='LOCAL_FOCUSED_DEVELOPMENT_NOT_RELEASE'&&equal(seam.phases.map(p=>[p.phase,p.exitCode]),[['focused-db',0]])&&seam.sharedClusterCommandsExecuted===0&&cleanup.privateClusterStopped===true&&cleanup.privateDirectoryRemoved===true&&cleanup.sharedClusterCommandsExecuted===0,'merged DB seam or cleanup differs');
  const dbResult=json('ai-local-login-20261026-db-seam/focused-db.json');verifyFreshMergedResult(dbResult,['test/hr-orchestrator.test.ts'],candidatePath,16);runtime('ai-local-login-20261026-db-seam/focused-db.log');
  const dbIdentity=json('ai-local-login-20261026-db-seam/postgres-identity.json');need(dbIdentity.port==='55487'&&dbIdentity.version==='160014'&&dbIdentity.jit==='on'&&dbIdentity.localNative===true,'merged private DB identity differs');need(runtime('ai-local-login-20261026-db-seam/classifier.txt').split('\t').slice(0,2).join('\t').trim()==='DB\ttest/hr-orchestrator.test.ts','merged seam classifier differs');
  const css=json('ai-local-login-20261026-browser-css/completed.json'),cssFiles=boundary.browsers.filter(p=>p!=='test/rewards-documents.browser.test.tsx');
  need(css.source===P.final&&css.kind==='LOCAL_CHANGED_CSS_BROWSER_ONLY_NOT_FULL_GATE'&&css.passed===true&&equal(css.browserFiles,cssFiles)&&equal(css.engines,['chromium','firefox','webkit'])&&equal(css.phases.map(p=>[p.phase,p.exitCode]),css.engines.map(e=>['browser-'+e,0])),'merged CSS browser provenance differs');
  const browserEvidence={};for(const engine of css.engines){const raw=json('ai-local-login-20261026-browser-css/'+engine+'.json');verifyFreshMergedResult(raw,cssFiles,candidatePath,247);runtime('ai-local-login-20261026-browser-css/browser-'+engine+'.log');browserEvidence[engine]={observedSource:P.final,files:15,cases:247,retainedPeerUnchangedFiles:['test/rewards-documents.browser.test.tsx'],retainedPeerCases:4};}
  const adapter=counter('scratchpad/ai-local-login-controller-20261026/orchestrator-browser-local.mjs'),adapterBoundary=JSON.parse(counter('scratchpad/ai-local-login-controller-20261026/source-boundary.json'));
  need(sha256(adapter)==='260dfc6ab120f031c91cd1e35e81b15da5d52f266e18127a908491be0e6726b7'&&adapterBoundary.sourceController===COUNTER_REPAIR.source&&adapterBoundary.localAdapterSha256===sha256(adapter)&&adapterBoundary.browserAndAssertionRegionSha256==='552e97fde13e5fd8b40d630b59c3986c759958cc7300366e01d539db3bd99f9d'&&adapterBoundary.browserAndAssertionRegionByteIdentical===true,'merged walkthrough adapter differs');
  const walkthroughs=[];for(const journey of ['queue','correction']){const prefix='ai-local-login-20261026-'+journey+'/',record=json(prefix+'walkthrough.json');walkthroughs.push(validateWalkthrough(record,journey,{source:P.final,controller:COUNTER_REPAIR.source,buildId:P.buildId}));need(record.localAdapterSha256===sha256(adapter)&&equal(record.productionBuild,build)&&sha256(runtime(prefix+'server.log'))===record.serverLogHash,'merged walkthrough source/build/log differs');const pg=json(prefix+'postgres-evidence.json');need(pg.systemIdentifier==='7700576020832388449'&&pg.database==='ai_hr_orchestrator_browser'&&pg.version==='160014'&&pg.jit==='on'&&pg.localNative===true&&pg.memoryCapBytes===null,'merged walkthrough DB differs');for(const image of journey==='queue'?[...record.visits.map(v=>v.image),...['legacy','malformed','unsupported','failed','current'].map(s=>'receipt-'+s+'.png')]:record.correction.images)runtime(prefix+image);}
  const ledger=json('ai-login-baseline-integration-20261026/staging-ledger-before-h.json');need(ledger.kind==='READ_ONLY_STAGING_LEDGER_PRE_H'&&ledger.expectedBaseline===P.baseline&&ledger.count===496&&ledger.exactPeerLedgerPreserved===true&&equal(ledger.ledger,peer.ledger),'pre-H ledger differs');
  need(equal(mergedSourceBoundary(candidatePath),boundary),'candidate changed during collection');
  return {...original,policyVersion:3,tier:ACCEPTANCE_TIER,result:'ACCEPTED_WITH_OWNER_EXCEPTION',candidate:P.final,candidatePath,baseline:P.baseline,sourceBoundary:boundary,historicalSourcePath:HISTORICAL_SOURCE,
    historicalView:{kind:'POST_RUN_IMMUTABLE_SOURCE_VIEW_NOT_NEW_EXECUTION',source:P.counterChild,executionOriginPath:candidatePath,privateConfigAndReceiptCopied:true},peerEvidenceRoot:PEER_EVIDENCE,peer,counterRoot,counterProof,
    requiredClaims:{wholeTypecheck:{observedSource:P.final,exitCode:0},localBuild:{observedSource:P.final,buildId:P.buildId,exitCode:0},dbSeam:{observedSource:P.final,cases:16,exitCode:0},browserEvidence,walkthroughs},
    migrationLedger:peer.ledger,stagingBuildAuthorized:true,releaseAuthorized:false,arrivalVerified:false,newFullPassBaseline:false,
    limitations:['Original cancelled gate and overwritten Vitest process exits remain INCOMPLETE_CANCELLED/UNKNOWN.','Peer same-commit CI retry exception remains historical; it is not expanded into a generic rerun policy.','Historical source view/configuration snapshots and controller source copies are retrospective, not new application execution.','Fresh seam evidence covers changed combined inputs; it does not relabel old tests as newly executed on merged source.'],artifacts};
}
