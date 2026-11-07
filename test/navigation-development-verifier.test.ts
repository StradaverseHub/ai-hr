/** Protocol/unit simulation only. These mocks never constitute an executed browser receipt. */
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {NAVIGATION_CAPTURE_VERSION,type NavigationScenarioPlan} from '../scripts/performance/navigation-protocol';
const state=vi.hoisted(()=>({candidate:'a'.repeat(40),controller:'a'.repeat(40),harness:'b'.repeat(64),scenario:'c'.repeat(64),
 run:{} as any,workflow:{} as any,jobs:[] as any[],artifact:{} as any,files:{} as Record<string,any>,plan:{} as NavigationScenarioPlan,transportFailed:false,sourceMismatch:false,calls:[] as string[]}));
vi.mock('../scripts/performance/navigation-source',()=>({navigationCleanHead:(root:string)=>root==='/candidate'?state.candidate:state.controller,
 navigationSourceIdentity:(root:string)=>({harnessSha256:state.sourceMismatch&&root==='/candidate'?'0'.repeat(64):state.harness,scenarioSha256:state.scenario,plan:state.plan,files:[]})}));
vi.mock('node:fs',()=>({mkdtempSync:()=>'/private/unit-navigation-evidence',writeFileSync:vi.fn(),readFileSync:(path:string)=>{
 const key=path.split('/').pop()!;if(!(key in state.files))throw Error('Missing fixture member');return JSON.stringify(state.files[key]);}}));
vi.mock('node:child_process',()=>({execFileSync:(command:string,args:string[])=>{
 if(command==='python3')return Buffer.from('');expect(command).toBe('gh');expect(args[0]).toBe('api');state.calls.push(args[1]);
 const path=args[1];expect(path.startsWith('repos/StradaverseHub/ai-hr/')).toBe(true);
 const value=path.endsWith('/actions/runs/123')?state.run:path.endsWith('/actions/workflows/395862645')?state.workflow:
  path.includes('/jobs?')?{total_count:state.jobs.length,jobs:state.jobs}:path.includes('/artifacts?')?{total_count:1,artifacts:[state.artifact]}:null;
 if(!value)throw Error('Unexpected API endpoint');return Buffer.from(JSON.stringify(value));}}));
vi.mock('../.github/ci/archive-downloads.mjs',()=>({downloadCiArchives:async()=>{if(state.transportFailed)throw Error('Artifact digest mismatch');return {releaseAuthorized:false};},readCiArchive:()=>Buffer.from('unit transport bytes')}));
import {readVerifiedNavigationDevelopmentEvidence,verifyNavigationDevelopmentRun} from '../scripts/performance/navigation-capture-verifier';
function reset(){
 const started=new Date(Date.now()-60000).toISOString(),finished=new Date(Date.now()-30000).toISOString();
 state.candidate=state.controller='a'.repeat(40);state.transportFailed=false;state.sourceMismatch=false;state.calls=[];
 state.plan={schemaVersion:1,fixture:'system-load-v1',engine:'chromium',scope:'Explicit unit contract, not executed coverage',scenarios:[{
  id:'unit.employee',destinationId:'shell.unit',role:'employee',href:'/unit',originHref:'/unit',outcome:'usable',readiness:'controls',steps:[],checks:[{id:'control',kind:'enabled',tag:'input',selector:'main input[name="unit"]'}]}]};
 state.run={id:123,repository:{id:1333414856,full_name:'StradaverseHub/ai-hr'},head_repository:{id:1333414856},workflow_id:395862645,path:'.github/workflows/alpha-focused-checks.yml',event:'workflow_dispatch',head_branch:'alpha',head_sha:state.controller,status:'completed',conclusion:'success',run_attempt:1,run_started_at:started,updated_at:finished};
 state.workflow={id:395862645,path:'.github/workflows/alpha-focused-checks.yml',state:'active'};
 state.jobs=['resolve','system-http-browser-load'].map((name,index)=>({id:index+1,name,run_id:123,head_sha:state.controller,run_attempt:1,status:'completed',conclusion:'success',started_at:started,completed_at:finished}));
 state.artifact={id:999,name:'system-http-browser-development-evidence',expired:false,size_in_bytes:100,digest:'sha256:'+'d'.repeat(64),created_at:finished,updated_at:finished,
  workflow_run:{id:123,repository_id:1333414856,head_repository_id:1333414856,head_sha:state.controller,head_branch:'alpha'}};
 const baseline={schemaVersion:1,protocol:NAVIGATION_CAPTURE_VERSION,releaseAuthorized:false,fixture:'system-load-v1',engine:'chromium',candidateSha:state.candidate,controllerSha:state.controller,runId:123,runAttempt:1,harnessSha256:state.harness,scenarioSha256:state.scenario,phase:'baseline',complete:true,
  observations:[{scenarioId:'unit.employee',destinationId:'shell.unit',role:'employee',actorIndex:4,href:'/unit',outcome:'usable',readiness:'controls',status:200,finalPath:'/unit',internalSessionObserved:true,fixtureIdentityObserved:true,elapsedMs:100,checks:[{id:'control',passed:true,observedCount:1}],failures:{busy:0,unavailable:0,alerts:0,http500:0,pageErrors:0}}]};
 state.files={'runner.json':{kind:'ISOLATED_HTTP_BROWSER_DEVELOPMENT_ONLY',releaseEligible:false,sha:state.candidate,controller:state.controller,run:'123',exitCode:0,runtimeAcceptance:{pass:true,failures:[]}},
  'http-browser.json':{kind:'HTTP_WORKFLOW_PREFLIGHT_ONLY',suite:'workflow-preflight',releaseEligible:false,users:0,functionalErrors:[],browserErrors:[],homeCardFailures:[]},
  'navigation-browser-capture.json':{schemaVersion:1,protocol:NAVIGATION_CAPTURE_VERSION,releaseAuthorized:false,baseline}};
}
beforeEach(reset);
describe('private development evidence brand after live provenance and byte verification (mocked transport)',()=>{
 it('rejects flags, JSON, copies and callback-shaped claims',()=>{
  for(const value of [null,{},Object.freeze({verified:true,releaseAuthorized:false}),{verify:()=>true},JSON.parse('{"scope":"authenticated-development-runtime"}')])expect(readVerifiedNavigationDevelopmentEvidence(value)).toBeUndefined();
 });
 it('mints only a deeply frozen development capability and cannot be JSON copied',async()=>{
  const token=await verifyNavigationDevelopmentRun({runId:123,candidateRoot:'/candidate'}),data=readVerifiedNavigationDevelopmentEvidence(token)!;
  expect(data.scope).toBe('authenticated-development-runtime');expect(data.releaseAuthorized).toBe(false);expect(data.captures.loaded).toBeUndefined();
  expect(Object.isFrozen(token)).toBe(true);expect(Object.isFrozen(data.captures.baseline.observations[0].checks)).toBe(true);
  expect(readVerifiedNavigationDevelopmentEvidence({...token})).toBeUndefined();expect(readVerifiedNavigationDevelopmentEvidence(JSON.parse(JSON.stringify(token)))).toBeUndefined();
  expect(state.calls.some(path=>path.includes('/actions/runs/123/jobs?'))).toBe(true);
 });
 it.each(['foreign repository','untrusted controller','rerun','stale run','failed producer','artifact provenance','digest failure','source harness mismatch','source capture mismatch','native runtime failure','missing capture'])(
  'refuses %s before counting any executed evidence',async failure=>{
   if(failure==='foreign repository')state.run.repository.id=1;
   if(failure==='untrusted controller')state.run.head_branch='codex/untrusted';
   if(failure==='rerun')state.run.run_attempt=2;
   if(failure==='stale run')state.run.run_started_at=new Date(Date.now()-25*3600000).toISOString();
   if(failure==='failed producer')state.jobs[1].conclusion='failure';
   if(failure==='artifact provenance')state.artifact.workflow_run.head_sha='0'.repeat(40);
   if(failure==='digest failure')state.transportFailed=true;
   if(failure==='source harness mismatch')state.sourceMismatch=true;
   if(failure==='source capture mismatch')state.files['navigation-browser-capture.json'].baseline.harnessSha256='0'.repeat(64);
   if(failure==='native runtime failure')state.files['runner.json'].runtimeAcceptance={pass:false,failures:['postgres-lock-failure']};
   if(failure==='missing capture')delete state.files['navigation-browser-capture.json'];
   await expect(verifyNavigationDevelopmentRun({runId:123,candidateRoot:'/candidate'})).rejects.toThrow();
  });
});
