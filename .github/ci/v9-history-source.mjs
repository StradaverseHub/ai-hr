/** Resolve immutable application identities for later/overlapping runs; unknown active identities refuse downstream. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {REPOSITORY,REPOSITORY_ID,verifyArtifactBytes} from './release-policy.mjs';
import {V9_DB_CASE as pin,collectPages} from './v9-db-resource-policy.mjs';
/** No creation/status/branch cutoff: an arbitrarily old queued run may complete later. */
export function collectCompleteWorkflowHistory(workflowIds,api){
 assert(Array.isArray(workflowIds)&&workflowIds.length>0&&workflowIds.length<=8&&new Set(workflowIds).size===workflowIds.length&&workflowIds.every(id=>Number.isSafeInteger(id)&&id>0),'Bounded workflow registry required');
 const rows=[];
 for(const id of workflowIds)rows.push(...collectPages(page=>api(`actions/workflows/${id}/runs?per_page=100&page=${page}`),'workflow_runs',{limit:8000}));
 assert(rows.length<=8000,'Global history exceeds bounded complete inventory');return rows;
}
export function bindHistoryApplications({rows,original,focusedRunId,metadata,directory}){
 const bindings=new Map(),seen=new Map();
 for(const row of rows){if(row.id===original.id||row.id===focusedRunId||row.status==='completed'&&Date.parse(row.updated_at)<Date.parse(original.updated_at))continue;if(seen.has(row.id)){assert(seen.get(row.id)===JSON.stringify(row),'Changing history snapshot');continue;}seen.set(row.id,JSON.stringify(row));
  const m=metadata(row.id);assert(m.run.id===row.id&&m.run.head_sha===row.head_sha&&m.run.workflow_id===row.workflow_id,'History metadata changed');
  // Untrusted controllers or executions with no immutable source-binding output remain unknown.
  if(m.run.head_sha!==pin.controller||m.run.run_attempt!==1)continue;
  const choices=[['gate-plan','ci-plan.json','plan'],['focused-development-evidence','focused.json','selected-tests'],...['chromium','firefox','webkit'].map(engine=>[`diagnostic-complete-image-browser-${engine}`,`unit-browser-${engine}.json`,`browser-image (${engine})`])];
  const choice=choices.find(([name])=>m.artifacts.some(a=>a.name===name));if(!choice)continue;
  const [name,member,jobName]=choice,a=m.artifacts.find(a=>a.name===name),job=m.jobs.find(j=>j.name===jobName),w=a.workflow_run;
  assert(a.expired===false&&a.size_in_bytes>0&&a.size_in_bytes<=64*1024**2&&/^sha256:[a-f0-9]{64}$/.test(a.digest)&&w?.id===row.id&&w.repository_id===REPOSITORY_ID&&w.head_repository_id===REPOSITORY_ID&&w.head_sha===row.head_sha&&w.head_branch===row.head_branch,'History artifact provenance differs');
  if(!job||job.status!=='completed')continue;
  assert(job.run_id===row.id&&job.head_sha===row.head_sha&&job.run_attempt===1&&Date.parse(a.created_at)>=Date.parse(job.started_at)&&Date.parse(a.created_at)<=Date.parse(job.completed_at)&&Date.parse(a.expires_at)>Date.now(),'History artifact outside producer');
  const path=join(directory,`history-${row.id}-${a.id}.zip`);if(!existsSync(path)){const bytes=execFileSync('gh',['api',`repos/${REPOSITORY}/actions/artifacts/${a.id}/zip`],{timeout:60000,maxBuffer:64*1024**2});assert(bytes.length===a.size_in_bytes);verifyArtifactBytes(a,bytes);writeFileSync(path,bytes,{flag:'wx',mode:0o600});}
  const bytes=readFileSync(path);assert(bytes.length===a.size_in_bytes);verifyArtifactBytes(a,bytes);
  const packet=JSON.parse(execFileSync('python3',[fileURLToPath(new URL('./v9-history-source-extract.py',import.meta.url)),path,member],{encoding:'utf8',timeout:10000,maxBuffer:64*1024**2}));
  assert(/^[a-f0-9]{40}$/.test(packet.sha),'History packet lacks application identity');
  if(member==='focused.json')assert(packet.kind==='FOCUSED_ONLY'&&packet.controller===row.head_sha&&packet.runId===String(row.id)&&packet.attempt==='1','Focused history binding differs');
  else if(member==='ci-plan.json')assert(packet.schemaVersion===2&&packet.controller===row.head_sha&&/^[a-f0-9]{64}$/.test(packet.fingerprint),'Plan history binding differs');
  else assert(packet.id===member.slice(5,-5)&&/^[a-f0-9]{64}$/.test(packet.fingerprint),'Browser history binding differs');
  bindings.set(row.id,{runId:row.id,controller:row.head_sha,source:packet.sha,authenticated:true,artifactId:a.id,digest:a.digest});
 }
 return bindings;
}
