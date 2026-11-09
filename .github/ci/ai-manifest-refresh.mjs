/** Artifact-only execution of the existing reviewed source generators. Never approval or admission. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,lstatSync,realpathSync,mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join,relative,isAbsolute,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {candidateRequest,repository} from './resolve.mjs';
import {AI_MANIFEST_INPUTS} from './ai-manifest-admission.mjs';
import {aiSourceFiles,aiSourceDigest} from '../../scripts/ai-agent-source-scope.mjs';

const ownRoot=fileURLToPath(new URL('../../',import.meta.url));
const outputs=['lib/ai/provider-data-source-manifest.ts','lib/ai/module-agent-source-manifest.ts'];
const approval='lib/ai/provider-data-approvals.ts';
const approvalSha256='8d527c26d99b5931f466fb56cc3a39ff493265c0c6e2c8b7163d0ca57a87c452';
// All 29 approved rows in the pinned e706 registry bind this one digest.
const approvedProviderDigest='6d36d3f44cd79a5b386685e8e60176c45a50a61c188999251ecb9e5f4206bb16';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const disabled=['qualify_restricted_port_prerequisites','profile_database','duration_order','run_typecheck','run_native_typecheck','run_native_swift_models','run_native_bundle','run_build'];
const keys=['candidate_ref','expected_sha','selected_tests','refresh_ai_source_manifests',...disabled,'model_eval','eval_budget_usd','eval_allowed_providers'];
const childEnv=()=>({PATH:dirname(process.execPath)+':/usr/bin:/bin',LANG:'C.UTF-8',LC_ALL:'C.UTF-8',TZ:'UTC',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'});
export const MANIFEST_REFRESH_COMMANDS=Object.freeze([
 Object.freeze(['scripts/ai-provider-data-source-manifest.mjs','--list']),
 Object.freeze(['scripts/ai-agent-source-manifest.mjs']),
 Object.freeze(['scripts/ai-provider-data-source-manifest.mjs','--check']),
 Object.freeze(['scripts/ai-agent-source-manifest.mjs','--check']),
]);

export function manifestRefreshSelection(event){
 const input=event?.inputs;
 assert(input&&typeof input==='object'&&!Array.isArray(input),'Refresh requires dispatch inputs');
 assert([true,'true'].includes(input.refresh_ai_source_manifests),'Refresh opt-in required');
 assert(Object.keys(input).every(k=>keys.includes(k)),'Unknown refresh input');
 assert(input.selected_tests==='[]','Refresh requires exact empty selection');
 assert(disabled.every(k=>input[k]===undefined||input[k]===false||input[k]==='false'),'Refresh excludes all optional work');
 assert((input.model_eval??'')===''&&(input.eval_allowed_providers??'')==='','Refresh excludes providers');
 assert((input.eval_budget_usd??'20')==='20','Refresh uses unchanged unused evaluation budget');
 assert(typeof input.candidate_ref==='string'&&input.candidate_ref!==''&&typeof input.expected_sha==='string'
  &&/^[0-9a-f]{40}$/.test(input.expected_sha),'Refresh requires exact candidate branch and SHA');
 const request=candidateRequest(event,input);
 assert(request.branch===input.candidate_ref&&request.expected===input.expected_sha,'Refresh candidate identity differs');
 return {branch:request.branch,source:request.expected};
}

export function checkedManifestChild(result,withSources=false){
 assert(result&&result.error==null&&result.signal==null&&result.status===0,'Fixed manifest operation refused');
 assert(typeof result.stdout==='string'&&Buffer.byteLength(result.stdout)<=1024*1024&&result.stderr==='','Fixed manifest output refused');
 let value;try{value=JSON.parse(result.stdout);}catch{throw Error('Invalid fixed manifest JSON');}
 assert(value&&Object.keys(value).sort().join(',')===(withSources?'digest,files,sources':'digest,files'),'Unexpected manifest result');
 assert(Number.isSafeInteger(value.files)&&value.files>0&&/^[0-9a-f]{64}$/.test(value.digest??''),'Invalid manifest identity');
 if(withSources)assert(Array.isArray(value.sources)&&value.sources.length===value.files&&value.sources.every(n=>typeof n==='string')&&new Set(value.sources).size===value.files&&value.sources.join('\0')===value.sources.slice().sort().join('\0'),'Invalid manifest members');
 return value;
}

export function assertRefreshProviderSource(provider){
 assert(provider.sources.includes('core/attendance-formula-ai.ts')&&provider.sources.includes('lib/attendance-formula-ai.ts'),
  'Attendance authoring source closure required');
 assert(provider.digest!==approvedProviderDigest,'Refresh must leave the changed provider source unapproved');
}

export function manifestRemainingTimeout(deadline,now,max){
 assert(Number.isFinite(deadline)&&Number.isFinite(now)&&Number.isSafeInteger(max)&&max>0,'Invalid fixed manifest clock');
 const left=Math.floor(deadline-now);assert(left>0,'Manifest aggregate deadline exhausted');return Math.min(max,left);
}

export function refreshAiManifests({candidatePath,controllerPath,source,controller}){
 const start=performance.now(),deadline=start+240000;
 const budget=max=>manifestRemainingTimeout(deadline,performance.now(),max);
 const git=(cwd,...args)=>{
  const result=spawnSync('/usr/bin/git',args,{cwd,env:childEnv(),encoding:'utf8',timeout:budget(10000),maxBuffer:8*1024*1024});
  assert(result.error==null&&result.signal==null&&result.status===0,'Fixed source metadata refused');return result.stdout.trimEnd();
 };
 const cwd=realpathSync(candidatePath),trusted=realpathSync(controllerPath);
 assert(cwd!==trusted,'Separate controller and candidate required');
 const frozen=(root,expected)=>assert(/^[0-9a-f]{40}$/.test(expected??'')&&git(root,'rev-parse','HEAD')===expected&&git(root,'status','--porcelain')==='','Exact clean source required');
 frozen(trusted,controller);frozen(cwd,source);
 assert(source!==controller,'Separate controller and candidate identities required');
 const tree=git(cwd,'rev-parse','HEAD^{tree}');assert(/^[0-9a-f]{40}$/.test(tree),'Invalid original tree');
 const tracked=git(cwd,'ls-files','-z').split('\0').filter(Boolean),trackedNames=new Set(tracked);
 const regular=(root,name,max=16*1024*1024)=>{
  budget(1);assert(typeof name==='string'&&name!==''&&!isAbsolute(name)&&name.split('/').every(p=>p!==''&&p!=='.'&&p!=='..'),'Invalid fixed source member');
  const path=join(root,name),s=lstatSync(path);assert(s.isFile()&&!s.isSymbolicLink()&&s.size<=max&&realpathSync(path)===path,'Untrusted source member');return readFileSync(path);
 };
 const protectedBytes=new Map([...AI_MANIFEST_INPUTS,approval].map(n=>[n,regular(cwd,n)]));
 for(const name of AI_MANIFEST_INPUTS)assert(protectedBytes.get(name).equals(regular(trusted,name)),'Unreviewed generator or scope');
 assert(sha(protectedBytes.get(approval))===approvalSha256,'Exact e706 approval registry required');
 const originalOutputs=outputs.map(path=>({path,sha256:sha(regular(cwd,path,4096))}));
 const guard=()=>{
  assert(git(cwd,'rev-parse','HEAD')===source&&git(cwd,'rev-parse','HEAD^{tree}')===tree,'Original source identity changed');
  frozen(trusted,controller);
  for(const [name,bytes]of protectedBytes)assert(regular(cwd,name).equals(bytes),'Protected generator, scope or approval changed');
  const changes=git(cwd,'status','--porcelain','-z').split('\0').filter(Boolean);
  assert(changes.every(row=>row.startsWith(' M ')&&outputs.includes(row.slice(3))),'Unexpected candidate change');
 };
 const invoke=index=>{
  guard();const args=MANIFEST_REFRESH_COMMANDS[index];
  const result=spawnSync(process.execPath,args,{cwd,env:childEnv(),encoding:'utf8',timeout:budget(60000),maxBuffer:1024*1024});
  const value=checkedManifestChild(result,index===0);guard();return value;
 };
 const provider=invoke(0),agentNames=aiSourceFiles(tracked);
 assert(provider.sources.every(path=>trackedNames.has(path)),'Manifest inputs must belong to the frozen tracked source');
 const members=names=>names.map(path=>({path,sha256:sha(regular(cwd,path))}));
 const providerMembers=members(provider.sources),agentMembers=members(agentNames);
 assert(providerMembers.every(r=>!outputs.includes(r.path)&&r.path!==approval),'Provider closure must exclude generated identities and approvals');
 assert(sha(JSON.stringify(providerMembers.map(r=>[r.path,r.sha256])))===provider.digest,'Provider member digest mismatch');
 assertRefreshProviderSource(provider);
 const agent=invoke(1);
 assert(agentNames.length===agent.files&&aiSourceDigest(agentMembers.map(r=>[r.path,r.sha256]))===agent.digest,'Agent member digest mismatch');
 assert(!agentNames.includes(outputs[1]),'Agent output cannot hash itself');
 for(const [index,expected]of[[2,provider],[3,agent]]){
  const checked=invoke(index);assert(checked.files===expected.files&&checked.digest===expected.digest,'Generated check mismatch');
 }
 assert(JSON.stringify(providerMembers)===JSON.stringify(members(provider.sources))&&JSON.stringify(agentMembers)===JSON.stringify(members(agentNames)),'Manifest inputs changed during checks');
 const generated=outputs.map(path=>({path,bytes:regular(cwd,path,4096)}));
 const expectedProvider='/** GENERATED exact privacy transform sources. Regenerate after any listed dependency changes. */\nexport const PROVIDER_DATA_TRANSFORM_SOURCE_DIGEST = '+JSON.stringify(provider.digest)+' as const;\n';
 const expectedAgent='/** GENERATED static source manifest of the AI behaviour surface (scripts/ai-agent-source-scope.mjs).\n * Regenerate/check after all integration; no runtime source reads. */\nexport const MODULE_AGENT_SOURCE_DIGEST = '+JSON.stringify(agent.digest)+' as const;\nexport const MODULE_AGENT_SOURCE_FILE_COUNT = '+agent.files+' as const;\n';
 assert(generated[0].bytes.toString('utf8')===expectedProvider&&generated[1].bytes.toString('utf8')===expectedAgent,'Generated output bytes refused');
 guard();
 return {generated,receipt:{kind:'AI_SOURCE_MANIFEST_REFRESH_DATA_NOT_APPROVAL',source,controller,originalTree:tree,originalOutputs,outputs:generated.map(r=>({path:r.path,bytes:r.bytes.length,sha256:sha(r.bytes)})),protectedInputs:[...protectedBytes].map(([path,bytes])=>({path,sha256:sha(bytes)})),approvalRecords:{approved:29,pending:2,unchanged:true,renewed:false},provider:{files:provider.files,digest:provider.digest,members:providerMembers},agent:{files:agent.files,digest:agent.digest,inputPhase:'after-provider-refresh',members:agentMembers},operations:MANIFEST_REFRESH_COMMANDS.map(a=>a.slice()),releaseAuthorized:false,testAuthorized:false,nativeAuthorized:false,providerAuthorized:false}};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const event=JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,'utf8')),request=manifestRefreshSelection(event);
 assert(process.env.GITHUB_ACTIONS==='true'&&process.env.CI==='true'&&process.env.RUNNER_ENVIRONMENT==='github-hosted'&&process.env.RUNNER_OS==='Linux'&&process.env.GITHUB_REPOSITORY===repository&&process.env.GITHUB_EVENT_NAME==='workflow_dispatch'&&process.env.GITHUB_JOB==='refresh-ai-source-manifests','Standard hosted refresh job required');
 assert(process.version==='v22.23.3'&&/^[1-9][0-9]*$/.test(process.env.GITHUB_RUN_ID??'')&&process.env.GITHUB_RUN_ATTEMPT==='1','Pinned first-attempt runtime required');
 assert(process.env.GITHUB_SHA===process.env.AIHR_CI_CONTROL_HEAD,'Controller context mismatch');
 if(process.argv[2]==='--selection'){
  assert(process.argv.length===3,'No extra refresh arguments');console.log(JSON.stringify({kind:'AI_MANIFEST_REFRESH_SELECTION',...request,releaseAuthorized:false}));
 }else{
  assert(process.argv.length===2&&request.source===process.env.AIHR_CI_HEAD,'Exact resolved refresh source required');
  const result=refreshAiManifests({candidatePath:process.cwd(),controllerPath:ownRoot,source:request.source,controller:process.env.AIHR_CI_CONTROL_HEAD});
  const temp=realpathSync(process.env.RUNNER_TEMP),destination=join(temp,'ai-manifest-refresh');
  assert(relative(temp,destination)==='ai-manifest-refresh'&&!existsSync(destination),'Fresh owned artifact directory required');mkdirSync(destination,{mode:0o700});
  for(const row of result.generated)writeFileSync(join(destination,row.path.split('/').at(-1)),row.bytes,{mode:0o600,flag:'wx'});
  const receipt={...result.receipt,runId:process.env.GITHUB_RUN_ID,attempt:1,branch:request.branch};
  const bytes=JSON.stringify(receipt,null,2)+'\n';assert(Buffer.byteLength(bytes)<=1024*1024,'Refresh receipt exceeds bound');writeFileSync(join(destination,'refresh.json'),bytes,{mode:0o600,flag:'wx'});
  console.log(JSON.stringify({kind:receipt.kind,source:receipt.source,controller:receipt.controller,releaseAuthorized:false}));
 }
}
