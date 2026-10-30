import {expect,it} from 'vitest';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,readdirSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fixture as originalFixture,put} from '../.github/ci/resume-test-fixtures.mjs';
import {assessResumeSource} from '../.github/ci/resume-source.mjs';
import {buildPacketFixture} from '../.github/ci/build-artifact-test-fixture.mjs';
import {inspectCiBuildPacket,bindCiBuildSource} from '../.github/ci/build-artifact.mjs';
import {fileURLToPath} from 'node:url';
import {V9_DB_CASE as pin,caseInventory,validateFreshDb,checkHistory,collectPages,assessV9DbResource,validateOriginalPrerequisites,validateRetainedReports,assertStableSnapshot} from '../.github/ci/v9-db-resource-policy.mjs';
import {hash,CI_EXECUTION} from '../.github/ci/manifest.mjs';
import {REPOSITORY,REPOSITORY_ID,WORKFLOW_ID,verifyArtifactBytes,digest} from '../.github/ci/release-policy.mjs';
const inventory:Record<string,string[]>=JSON.parse(readFileSync(new URL('../.github/ci/fixtures/v9-db-resource-cases.json',import.meta.url),'utf8'));
const epoch=Date.parse('2026-10-30T12:00:00Z'),at=(s:number)=>new Date(epoch+s*1000).toISOString(),cwd='/home/runner/work/ai-hr/ai-hr/source';
function fixture():any{
 const files=Object.keys(inventory).sort(),entries=Object.entries(inventory).sort(([a],[b])=>a.localeCompare(b));
 const runtime={node:'22.23.3',platform:'linux',arch:'x64'},state={Running:true,OOMKilled:false,Dead:false,Pid:1234,StartedAt:at(65)};
 const run={id:321,repository:{id:REPOSITORY_ID,full_name:REPOSITORY},head_repository:{id:REPOSITORY_ID},workflow_id:12345,path:'.github/workflows/alpha-focused-checks.yml',event:'workflow_dispatch',head_branch:'main',head_sha:pin.controller,status:'completed',conclusion:'success',run_attempt:1,created_at:at(60),updated_at:at(150),display_title:`Focused only · ${pin.branch}`};
 const jobs=['resolve','selected-tests','typecheck','linux-build','native-typecheck','native-swift-models','native-bundle'].map((name,i)=>({id:1000+i,name,run_id:321,run_attempt:1,head_sha:pin.controller,head_branch:'main',status:'completed',conclusion:['resolve','selected-tests'].includes(name)?'success':'skipped',started_at:at(60),completed_at:at(140),steps:[{name:'Ensure owned database cleanup after interrupted checks',conclusion:'success'}]}));
 const artifact={id:555,name:'focused-development-evidence',expired:false,size_in_bytes:500,digest:'sha256:'+'a'.repeat(64),created_at:at(135),expires_at:at(5000),workflow_run:{id:321,repository_id:REPOSITORY_ID,head_repository_id:REPOSITORY_ID,head_sha:pin.controller,head_branch:'main'}};
 const result={success:true,numFailedTests:0,numFailedTestSuites:0,numPendingTests:0,numTodoTests:0,numTotalTests:435,numPassedTests:435,testResults:files.map(path=>({name:cwd+'/'+path,status:'passed',assertionResults:inventory[path].map(fullName=>({fullName,status:'passed'}))}))};
 const resource={schemaVersion:1,name:'aihr-ci-321-1-db-1',errors:{},memoryLimit:2147483648,memoryMax:2147483648,memoryPeak:1073741824,memoryEvents:{oom:0,oom_kill:0,max:0},state,settings:{jit:'on',jitAvailable:true,serverVersionNum:'160015'},capturedAt:at(125)};
 const report={kind:'FOCUSED_ONLY',releaseEligible:false,schemaVersion:1,sha:pin.candidate,controller:pin.controller,runId:'321',attempt:'1',exitCode:0,runtime,files,groups:{NODB:[],DB:files},manifestHash:hash(JSON.stringify(files)),classifierHash:'c'.repeat(64),healthBefore:{ok:true},healthAfter:{ok:true},startedAt:at(70),endedAt:at(130),databaseTerminalEvidence:resource,batches:[{kind:'DB',files,exitCode:0,processExitCode:0,signal:null,assertions:435,startedAt:at(80),endedAt:at(120)}]};
 return {plan:{runtime:structuredClone(runtime),execution:structuredClone(CI_EXECUTION)},unit:{files},source:{run:{id:pin.runId,updated_at:at(0)}},focused:{run,jobs,artifacts:[artifact],report,result,state:structuredClone(state)},classifierHash:'c'.repeat(64),selectedLog:'AIHR_CI_PG_MEMORY_GIB: 2\nAIHR_CI_PG_JIT: on\nAIHR_TEST_DURATION_ORDER: true\n',focusedWorkflowId:12345,oldCases:{entries,total:435},now:epoch+200000};
}
it('checks all 435 original case identities and the complete fresh DB unit with unchanged profile',()=>{const f=fixture();expect(hash(f.oldCases.entries)).toBe(pin.cases);expect(validateFreshDb(f).replacement.total).toBe(435);});
it.each([
 ['other source',(f:any)=>{f.focused.report.sha='f'.repeat(40);}],
 ['other controller',(f:any)=>{f.focused.run.head_sha='f'.repeat(40);}],
 ['native rerun',(f:any)=>{f.focused.run.run_attempt=2;}],
 ['rerun job',(f:any)=>{f.focused.jobs[1].run_attempt=2;}],
 ['before source completion',(f:any)=>{f.focused.run.created_at=at(-1);}],
 ['foreign artifact',(f:any)=>{f.focused.artifacts[0].workflow_run.id=999;}],
 ['unknown artifact',(f:any)=>{f.focused.artifacts.push({...f.focused.artifacts[0],id:556});}],
 ['artifact outside producer',(f:any)=>{f.focused.artifacts[0].created_at=at(50);}],
 ['different runtime',(f:any)=>{f.focused.report.runtime.node='22.1.0';}],
 ['partial original unit',(f:any)=>{f.focused.report.files=f.focused.report.files.slice(1);}],
 ['mixed classification',(f:any)=>{f.focused.report.groups.NODB=['test/extra.test.ts'];}],
 ['changed classifier',(f:any)=>{f.focused.report.classifierHash='d'.repeat(64);}],
 ['failed process',(f:any)=>{f.focused.report.batches[0].processExitCode=1;}],
 ['unhealthy runner',(f:any)=>{f.focused.report.healthAfter.ok=false;}],
 ['larger DB budget',(f:any)=>{f.focused.report.databaseTerminalEvidence.memoryLimit*=2;}],
 ['8KiB waiver',(f:any)=>{f.focused.report.databaseTerminalEvidence.memoryPeak=2147491840;}],
 ['OOM',(f:any)=>{f.focused.report.databaseTerminalEvidence.memoryEvents.oom_kill=1;}],
 ['foreign DB owner',(f:any)=>{f.focused.report.databaseTerminalEvidence.name='aihr-ci-999-1-db-1';}],
 ['changed PG patch',(f:any)=>{f.focused.report.databaseTerminalEvidence.settings.serverVersionNum='160014';}],
 ['JIT off',(f:any)=>{f.focused.report.databaseTerminalEvidence.settings.jit='off';}],
 ['inverted report interval',(f:any)=>{f.focused.report.startedAt=at(135);}],
 ['inverted batch interval',(f:any)=>{f.focused.report.batches[0].startedAt=at(121);}],
 ['batch starts after report end',(f:any)=>{f.focused.report.batches[0].startedAt=at(131);}],
 ['capture before tests ended',(f:any)=>{f.focused.report.databaseTerminalEvidence.capturedAt=at(110);}],
 ['different container PID',(f:any)=>{f.focused.state.Pid=5678;}],
 ['cleanup failure',(f:any)=>{f.focused.jobs[1].steps[0].conclusion='failure';}],
 ['missing scheduling proof',(f:any)=>{f.selectedLog=f.selectedLog.replace('AIHR_TEST_DURATION_ORDER: true','');}],
 ['budget override in producer',(f:any)=>{f.selectedLog+='AIHR_CI_PG_MEMORY_GIB: 4\n';}],
 ['case omission',(f:any)=>{f.focused.result.testResults[0].assertionResults.pop();}],
 ['renamed case',(f:any)=>{f.focused.result.testResults[0].assertionResults[0].fullName+=' changed';}],
 ['skipped case',(f:any)=>{f.focused.result.testResults[0].assertionResults[0].status='pending';}],
 ['extra assertion',(f:any)=>{f.focused.result.testResults[0].assertionResults.push({fullName:'Extra',status:'passed'});}],
 ['duplicate file',(f:any)=>{f.focused.result.testResults[1]=f.focused.result.testResults[0];}],
] as const)('refuses %s',(name,change)=>{const f=fixture();change(f);expect(()=>validateFreshDb(f)).toThrow();});
it('keeps finite source/plan failures closed before any replacement can count',()=>{expect(()=>assessV9DbResource({plan:{sha:'f'.repeat(40)}} as any)).toThrow();});
it('requires complete paginated API totals, distinct rows and a stable snapshot',()=>{
 const rows=Array.from({length:101},(_,i)=>({id:i+1}));expect(collectPages(p=>({total_count:101,jobs:p===1?rows.slice(0,100):rows.slice(100)}),'jobs')).toHaveLength(101);
 for(const read of [()=>({total_count:101,jobs:rows.slice(0,99)}),(p:number)=>({total_count:101,jobs:p===1?rows.slice(0,100):[]}),(p:number)=>({total_count:101,jobs:p===1?rows.slice(0,100):[rows[0]]}),(p:number)=>({total_count:p===1?101:102,jobs:p===1?rows.slice(0,100):rows.slice(100)}),()=>({total_count:1001,jobs:[]}),()=>({jobs:[]})])expect(()=>collectPages(read,'jobs')).toThrow();
});
function historyFixture():any{const f=fixture(),original={id:pin.runId,workflow_id:WORKFLOW_ID,head_sha:pin.controller,display_title:`Alpha CI · ${pin.branch}`,created_at:at(-500),updated_at:at(0),status:'completed',conclusion:'failure',run_attempt:1};return {rows:[original,f.focused.run],context:{original,focusedRunId:321,workflowIds:[WORKFLOW_ID,12345],now:epoch+200000}};}
it('includes overlapping failures, pending executions and conflicting history rather than hiding them',()=>{
 const {rows,context}=historyFixture();expect(checkHistory(rows,context).runIds).toEqual([pin.runId,321]);
 for(const run of [{...rows[1],id:999,status:'in_progress',conclusion:null,created_at:at(-1000)},{...rows[1],id:999,conclusion:'failure',created_at:at(-600),updated_at:at(100)},{...rows[1],run_attempt:2},{...rows[1],head_sha:'f'.repeat(40)}])expect(()=>checkHistory([...rows,run],context)).toThrow();
 expect(()=>checkHistory([rows[1]],context)).toThrow();
});
it('rejects ZIP byte changes against authenticated API digests',()=>{const bytes=Buffer.from('fixture archive bytes'),a={digest:digest(bytes)};expect(()=>verifyArtifactBytes(a,bytes)).not.toThrow();expect(()=>verifyArtifactBytes(a,Buffer.from('changed'))).toThrow();});
it.each(['valid','traversal','duplicate','symlink'])('extracts only the finite five-member DB packet: %s',kind=>{
 const dir=mkdtempSync(join(tmpdir(),'v9-resource-zip-')),archive=join(dir,'source.zip'),target=join(dir,'packet');
 try{execFileSync('python3',['-c',`import zipfile,sys,stat\nnames=['focused.json','db.vitest.json','postgres-state.json','postgres-stats.txt','postgres.log']\nkind=sys.argv[2]\nif kind=='traversal': names[0]='../focused.json'\nif kind=='duplicate': names.append(names[0])\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n for n in names:\n  i=zipfile.ZipInfo(n);i.external_attr=((stat.S_IFLNK|0o777) if kind=='symlink' and n=='focused.json' else (stat.S_IFREG|0o600))<<16;z.writestr(i,'{}')\n`,archive,kind]);
 const extract=()=>execFileSync('python3',[fileURLToPath(new URL('../.github/ci/v9-db-resource-extract.py',import.meta.url)),archive,target],{stdio:'pipe'});
 if(kind==='valid'){extract();expect(readdirSync(target).sort()).toEqual(['focused.json','db.vitest.json','postgres-state.json','postgres-stats.txt','postgres.log'].sort());}else expect(extract).toThrow();
 }finally{rmSync(dir,{recursive:true,force:true});}
});

it('does not hide a same-source alias or an unresolved active application behind another title',()=>{
 const {rows,context}=historyFixture(),alias={...rows[1],id:999,display_title:'Focused only · another-frozen-alias',status:'in_progress',conclusion:null};
 expect(()=>checkHistory([...rows,alias],context)).toThrow('Unresolved application identity');
 const proof={runId:999,source:pin.candidate,controller:pin.controller,authenticated:true,artifactId:777,digest:'sha256:'+'b'.repeat(64)};
 expect(()=>checkHistory([...rows,alias],{...context,bindings:new Map([[999,proof]])})).toThrow('Unaccounted');
 expect(checkHistory([...rows,alias],{...context,bindings:new Map([[999,{...proof,source:'e'.repeat(40)}]])}).runIds).toEqual([pin.runId,321]);
});

it('composes real original API/ZIP, prerequisite and retained-report authentication with bound fixture packets',()=>{
 const source=originalFixture(),failed=source.expectedPlan.units.find((u:any)=>u.kind==='db')!.id;source.jobs.find((j:any)=>j.name===`test (${failed})`)!.conclusion='failure';
 const assessed=assessResumeSource(source);expect(assessed.rerun.map((u:any)=>u.id)).toEqual([failed]);expect(()=>validateOriginalPrerequisites(source.expectedPlan,source,failed)).not.toThrow();expect(validateRetainedReports(source.expectedPlan,source.reports,assessed,failed)).toHaveLength(source.expectedPlan.units.length-1);
 for(const name of ['build','migrations','typecheck','browser (webkit)']){const changed=structuredClone(source.jobs);changed.find(j=>j.name===name)!.conclusion='failure';expect(()=>validateOriginalPrerequisites(source.expectedPlan,{jobs:changed},failed)).toThrow();}
 expect(()=>validateOriginalPrerequisites(source.expectedPlan,{jobs:source.jobs.filter(j=>j.name!=='build')},failed)).toThrow();
 const tampered=structuredClone(source.reports),retained=tampered.find(r=>r.id!==failed)!;retained.batches[0].result.numPassedTests=0;expect(()=>validateRetainedReports(source.expectedPlan,tampered,assessed,failed)).toThrow();
 expect(()=>validateRetainedReports(source.expectedPlan,source.reports.slice(1),assessed,failed)).toThrow();
 source.archives.set('gate-plan',Buffer.from('changed ZIP'));expect(()=>assessResumeSource(source)).toThrow();
});
it('refuses original source/controller/job/artifact changes through the actual shared authenticator',()=>{
 for(const mutate of [(f:any)=>{f.run.head_sha='f'.repeat(40);},(f:any)=>{f.run.run_attempt=2;},(f:any)=>{f.jobs=f.jobs.slice(1);},(f:any)=>{f.artifacts[0].workflow_run.id=999;},(f:any)=>{f.artifacts[0].digest='sha256:'+'f'.repeat(64);}]){const source=originalFixture();mutate(source);expect(()=>assessResumeSource(source)).toThrow();}
});
it('revalidation rejects changed API job or artifact facts after an initially valid snapshot',()=>{
 const before={run:{id:1},jobs:[{id:2,conclusion:'success'}],artifacts:[{id:3,digest:'original'}]};expect(()=>assertStableSnapshot(before,structuredClone(before))).not.toThrow();for(const key of ['jobs','artifacts']){const changed=structuredClone(before) as any;changed[key][0].id=999;expect(()=>assertStableSnapshot(before,changed)).toThrow();}
});
it('binds the original canonical build to source inputs and refuses altered lock/package/testing bytes',()=>{
 const f=buildPacketFixture(),dir=mkdtempSync(join(tmpdir(),'v9-original-build-'));
 try{for(const [name,data] of Object.entries(f.entries)){mkdirSync(dirname(join(dir,name)),{recursive:true,mode:0o700});writeFileSync(join(dir,name),data as string|Buffer,{mode:0o600});}const packet=inspectCiBuildPacket(dir,f.expected);expect(bindCiBuildSource(packet,f.source).canonicalCandidateInputsVerified).toBe(true);for(const key of ['lockBytes','packageBytes','preparedBytes'])expect(()=>bindCiBuildSource(packet,{...f.source,[key]:Buffer.from('changed')})).toThrow();}
 finally{rmSync(dir,{recursive:true,force:true});}
});
