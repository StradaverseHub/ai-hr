/** Complete supported-controller execution inventory; branch names never identify historical source. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {hash} from './manifest.mjs';
import {REPOSITORY,REPOSITORY_ID,WORKFLOW_ID,verifyArtifactBytes} from './release-policy.mjs';
import {BROWSER_REPAIR_WORKFLOW_ID} from './browser-repair-metadata.mjs';
export const FINITE_SOURCE='6bdddf4f84b3ecb693d8fbf29409373e49c73ac9';
export const PUBLISHED_CONTROLLER='d6cb83d620d8d4380c981a72fc41628780840b4e';
export const FROZEN_PROOF_CONTROLLER='f133ce140f38f782d44de1187a82b822e2acdb74';
const api=path=>JSON.parse(execFileSync('gh',['api',`repos/${REPOSITORY}/${path}`],{encoding:'utf8',timeout:60000,maxBuffer:64*1024**2}));
export function completeWorkflowRows(workflowIds,readApi=api){
 const rows=[],ids=new Set();assert(workflowIds.length===3&&new Set(workflowIds).size===3,'Exact supported workflow registry required');
 for(const workflow of workflowIds){let total=null,seen=0;
  for(let page=1;page<=100;page++){
   const response=readApi(`actions/workflows/${workflow}/runs?per_page=100&page=${page}`);
   assert(Number.isSafeInteger(response.total_count)&&response.total_count>=0&&response.total_count<=10000&&Array.isArray(response.workflow_runs),'Unbounded workflow history');
   if(total===null)total=response.total_count;assert(response.total_count===total,'History count changed during pagination');
   assert(response.workflow_runs.length<=100,'Oversized history page');
   for(const row of response.workflow_runs){assert(Number.isSafeInteger(row.id)&&row.id>0&&!ids.has(row.id)&&row.workflow_id===workflow,'Repeated or foreign history execution');ids.add(row.id);rows.push(row);seen++;}
   if(response.workflow_runs.length<100){assert(seen===total,'History pagination omitted executions');break;}assert(page<100,'History exceeds page bound');
  }
 }
 return rows;
}
function pages(path,key){const all=[];for(let page=1;page<=10;page++){const r=api(`${path}${path.includes('?')?'&':'?'}per_page=100&page=${page}`);assert(Array.isArray(r[key]),'Missing history producer inventory');all.push(...r[key]);if(r[key].length<100)return all;}throw Error('History producer inventory exceeds bound');}
const metadata=id=>({run:api(`actions/runs/${id}`),jobs:pages(`actions/runs/${id}/jobs?filter=all`,'jobs'),artifacts:pages(`actions/runs/${id}/artifacts`,'artifacts')});
export function supportedExecution(row){return row.event==='workflow_dispatch'&&['main','alpha'].includes(row.head_branch)&&row.head_sha===PUBLISHED_CONTROLLER;}
export function bindExecutionSource({row,directory,readMetadata=metadata,download=a=>execFileSync('gh',['api',`repos/${REPOSITORY}/actions/artifacts/${a.id}/zip`],{timeout:60000,maxBuffer:64*1024**2}),readPacket=(path,member)=>JSON.parse(execFileSync('python3',[fileURLToPath(new URL('./finite-history-source-extract.py',import.meta.url)),path,member],{encoding:'utf8',timeout:10000,maxBuffer:64*1024**2}))}){
 assert(supportedExecution(row),'Only frozen published-controller source bindings supported');
 const m=readMetadata(row.id);assert(m.run.id===row.id&&m.run.head_sha===row.head_sha&&m.run.workflow_id===row.workflow_id&&m.run.head_branch===row.head_branch&&m.run.repository?.id===REPOSITORY_ID&&m.run.repository.full_name===REPOSITORY&&m.run.head_repository?.id===REPOSITORY_ID&&m.run.event===row.event,'History execution metadata changed or is foreign');
 if(m.run.run_attempt!==1)return {runId:row.id,kind:'UNRESOLVED',reason:'Unresolved rerun source lineage'};
 const choices=[['gate-plan','ci-plan.json','plan'],['focused-development-evidence','focused.json','selected-tests'],...['chromium','firefox','webkit'].map(e=>[`diagnostic-complete-image-browser-${e}`,`unit-browser-${e}.json`,`browser-image (${e})`])];
 const selected=choices.find(([name])=>m.artifacts.some(a=>a.name===name));if(!selected)return {runId:row.id,kind:'UNRESOLVED',reason:'No immutable source-binding archive yet'};
 const [name,member,producerName]=selected,matching=m.artifacts.filter(a=>a.name===name);assert(matching.length===1,'Duplicate history source archive');const a=matching[0],w=a.workflow_run;
 assert(a.expired===false&&Number.isSafeInteger(a.id)&&a.id>0&&Number.isSafeInteger(a.size_in_bytes)&&a.size_in_bytes>0&&a.size_in_bytes<=64*1024**2&&/^sha256:[a-f0-9]{64}$/.test(a.digest)&&w?.id===row.id&&w.repository_id===REPOSITORY_ID&&w.head_repository_id===REPOSITORY_ID&&w.head_sha===row.head_sha&&w.head_branch===row.head_branch,'Foreign or invalid history source archive');
 const jobs=m.jobs.filter(j=>j.name===producerName&&j.run_id===row.id&&j.head_sha===row.head_sha&&j.head_branch===row.head_branch&&j.status==='completed'&&Date.parse(a.created_at)>=Date.parse(j.started_at)&&Date.parse(a.created_at)<=Date.parse(j.completed_at));
 if(jobs.length===0)return {runId:row.id,kind:'UNRESOLVED',reason:'Source archive producer has not completed'};assert(jobs.length===1,'Ambiguous source archive producer');const producer=jobs[0];assert(Number.isSafeInteger(producer.id)&&producer.id>0&&producer.run_attempt===1&&Date.parse(a.expires_at)>Date.now(),'Invalid source producer attempt or expiry');
 mkdirSync(directory,{recursive:true,mode:0o700});const path=join(directory,`source-${row.id}-${a.id}.zip`);
 if(!existsSync(path)){const bytes=download(a);assert(bytes.length===a.size_in_bytes,'History archive size differs');verifyArtifactBytes(a,bytes);writeFileSync(path,bytes,{flag:'wx',mode:0o600});}
 const bytes=readFileSync(path);assert(bytes.length===a.size_in_bytes,'Cached source archive size differs');verifyArtifactBytes(a,bytes);const packet=readPacket(path,member);
 assert(/^[a-f0-9]{40}$/.test(packet.sha),'Missing immutable application source');
 if(member==='focused.json')assert(packet.kind==='FOCUSED_ONLY'&&packet.controller===row.head_sha&&packet.runId===String(row.id)&&packet.attempt===String(producer.run_attempt),'Focused source binding differs');
 else if(member==='ci-plan.json')assert(packet.schemaVersion===2&&packet.controller===row.head_sha&&/^[a-f0-9]{64}$/.test(packet.fingerprint),'Plan source binding differs');
 else assert(packet.id===member.slice(5,-5)&&/^[a-f0-9]{64}$/.test(packet.fingerprint),'Browser source binding differs');
 return {kind:'AUTHENTICATED_ARCHIVE_SOURCE_BINDING',runId:row.id,source:packet.sha,controller:row.head_sha,producerAttempt:producer.run_attempt,jobId:producer.id,artifactId:a.id,digest:a.digest,member};
}
export function classifyCandidateHistory({rows,original,knownBindings,workflowIds,bindings}){
 assert(original.id===41028659062&&Number.isFinite(Date.parse(original.updated_at)),'Exact complete original history anchor required');
 const records=[],known=new Map(knownBindings.map(b=>[b.runId,b]));assert(known.size===knownBindings.length,'Duplicate managed source binding');
 for(const row of rows){
  assert(workflowIds.includes(row.workflow_id)&&Number.isSafeInteger(row.id)&&/^[a-f0-9]{40}$/.test(row.head_sha)&&typeof row.head_branch==='string'&&typeof row.event==='string'&&['queued','in_progress','waiting','requested','pending','completed'].includes(row.status)&&Number.isFinite(Date.parse(row.created_at))&&Number.isFinite(Date.parse(row.updated_at))&&Date.parse(row.updated_at)>=Date.parse(row.created_at),'Malformed supported workflow row');
  if(row.id===original.id||row.status==='completed'&&Date.parse(row.updated_at)<Date.parse(original.updated_at))continue;
  if(known.has(row.id)){
   const b=known.get(row.id);assert(b.source===FINITE_SOURCE&&b.controller===row.head_sha&&b.workflowId===row.workflow_id&&b.headBranches.includes(row.head_branch)&&row.event==='workflow_dispatch'&&row.status==='completed'&&row.conclusion==='success'&&row.run_attempt===1,'Managed candidate execution changed or failed');records.push({runId:row.id,classification:'VERIFIED_CANDIDATE',binding:b});continue;
  }
  if(!supportedExecution(row)){
   assert(!(['main','alpha'].includes(row.head_branch)&&row.event==='workflow_dispatch'),'Unresolved changed published execution controller');
   records.push({runId:row.id,classification:'OUTSIDE_CANONICAL_EXECUTION_CONTRACT',controller:row.head_sha,branch:row.head_branch,event:row.event});continue;
  }
  const b=bindings.get(row.id);assert(b?.kind==='AUTHENTICATED_ARCHIVE_SOURCE_BINDING'&&b.runId===row.id&&b.controller===row.head_sha,'Unresolved source for later or active supported execution: '+row.id);
  assert(b.source!==FINITE_SOURCE,'Unaccounted same-source execution outside managed aliases: '+row.id);
  records.push({runId:row.id,classification:'AUTHENTICATED_OTHER_SOURCE',binding:b});
 }
 assert([...known.keys()].every(id=>records.some(r=>r.runId===id&&r.classification==='VERIFIED_CANDIDATE')),'Managed execution absent from complete workflow inventory');
 const ordered=records.sort((a,b)=>a.runId-b.runId);return {kind:'AUTHENTICATED_COMPLETE_SUPPORTED_CANDIDATE_HISTORY',scope:{workflowIds,publishedController:PUBLISHED_CONTROLLER,canonicalBranches:['main','alpha'],noncanonicalExecutionsAreNotSourceObservations:true},candidate:FINITE_SOURCE,originalRunId:original.id,records:ordered,fingerprint:hash(ordered),releaseAuthorized:false};
}
export function knownProofBindings(proof,focusedWorkflowId){
 const r=proof.recovery;assert(proof.sha===FINITE_SOURCE&&r?.kind==='AUTHENTICATED_FIXTURE_BROWSER_RECOVERY'&&r.verificationController===FROZEN_PROOF_CONTROLLER&&proof.result==='DIAGNOSTIC_NONINSTALLABLE'&&proof.installationEligible===false,'Exact frozen managed proof required');
 const found=new Map(),add=(runId,controller,kind,source)=>{const entry={runId,source:FINITE_SOURCE,controller,kind,workflowId:kind==='browser'?BROWSER_REPAIR_WORKFLOW_ID:['focused','compiler'].includes(kind)?focusedWorkflowId:WORKFLOW_ID,headBranches:kind==='complete-pdf'?['codex/browser-recovery-verifier-20261030']:['main','alpha'],proofHash:hash(r),...source};if(found.has(runId)){assert(found.get(runId).controller===controller,'Managed execution controller disagreement');return;}found.set(runId,entry);};
 add(proof.buildRunId,proof.controller,'canonical-build',{});
 for(const f of r.focusedSources)add(f.runId,proof.controller,'focused',{artifactId:f.artifactId,digest:f.digest});
 for(const c of r.compilers)add(c.runId,proof.controller,'compiler',{jobId:c.jobId});
 for(const b of r.browserSources)add(b.runId,proof.controller,'browser',{artifactId:b.artifactId,digest:b.digest});
 for(const p of r.pdfSources)add(p.runId,p.executionController,'complete-pdf',{artifactId:p.artifactId,digest:p.digest});
 assert(found.size>=5,'Incomplete managed source producer inventory');return [...found.values()];
}
export async function verifyCompleteCandidateHistory({proof,directory,readApi=api,readMetadata=metadata}){
 const focused=readApi('actions/workflows/alpha-focused-checks.yml'),browser=readApi('actions/workflows/alpha-staging-browser-checks.yml');assert(focused.path==='.github/workflows/alpha-focused-checks.yml'&&browser.id===BROWSER_REPAIR_WORKFLOW_ID&&browser.path==='.github/workflows/alpha-staging-browser-checks.yml','Supported workflow registry changed');
 const workflowIds=[WORKFLOW_ID,focused.id,browser.id],original=readApi('actions/runs/41028659062'),knownBindings=knownProofBindings(proof,focused.id),knownIds=new Set(knownBindings.map(b=>b.runId));
 let passNumber=0;const pass=()=>{const rows=completeWorkflowRows(workflowIds,readApi),bindings=new Map();for(const row of rows)if(row.id!==original.id&&!knownIds.has(row.id)&&(row.status!=='completed'||Date.parse(row.updated_at)>=Date.parse(original.updated_at))&&supportedExecution(row))bindings.set(row.id,bindExecutionSource({row,directory,readMetadata}));mkdirSync(directory,{recursive:true,mode:0o700});writeFileSync(join(directory,'source-history-'+(++passNumber)+'.json'),JSON.stringify({rows,bindings:[...bindings]},null,2)+'\n',{flag:'wx',mode:0o600});return classifyCandidateHistory({rows,original,knownBindings,workflowIds,bindings});};
 const first=pass(),second=pass();assert(isDeepStrictEqual(first,second),'Candidate source history changed during final reconciliation');return second;
}
