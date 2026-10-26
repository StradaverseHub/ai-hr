/** Advisory publisher discovery only. Every selected origin still needs full independent validation. */
import assert from 'node:assert/strict';
export function cacheArtifactCandidates(inventory,{name,currentRunId}){
 assert(['whole-compiler-state-v1','next-application-state-v1'].includes(name),'Unknown graph artifact namespace');
 assert(inventory&&Number.isSafeInteger(inventory.total_count)&&inventory.total_count>=0&&Array.isArray(inventory.artifacts)&&inventory.artifacts.length<=3&&inventory.total_count>=inventory.artifacts.length,'Unbounded or malformed graph discovery response');
 const ids=new Set(),runs=new Set(),selected=[];
 for(const artifact of inventory.artifacts){
  assert(Number.isSafeInteger(artifact?.id)&&artifact.id>0&&!ids.has(artifact.id)&&artifact.name===name&&typeof artifact.expired==='boolean','Foreign or duplicate graph discovery entry');ids.add(artifact.id);
  if(artifact.expired)continue;
  const run=artifact.workflow_run;
  assert(run&&Number.isSafeInteger(run.id)&&run.id>0&&run.repository_id===1333414856&&run.head_repository_id===1333414856&&/^[a-f0-9]{40}$/.test(run.head_sha??''),'Foreign graph publisher pointer');
  if(String(run.id)===String(currentRunId))continue;
  assert(!runs.has(run.id),'Ambiguous graph namespace within producing run');runs.add(run.id);
  selected.push({runId:run.id,discoveryArtifactId:artifact.id});
 }
 return selected;
}
