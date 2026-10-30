/** A complete audited PDF unit executed by the independently frozen read-only verifier. */
import assert from 'node:assert/strict';
import {REPOSITORY,REPOSITORY_ID,WORKFLOW_ID,WORKFLOW_PATH} from './release-policy.mjs';
export const PDF_REPAIR_TITLE='Fixture PDF unit · codex/browser-recovery-verifier-20261030';
export function validatePdfRepairMetadata({run,jobs,artifacts,expected,now=Date.now()}){
 assert(run.id===expected.runId&&run.repository?.id===REPOSITORY_ID&&run.repository.full_name===REPOSITORY&&run.head_repository?.id===REPOSITORY_ID&&run.workflow_id===WORKFLOW_ID&&run.path===WORKFLOW_PATH,'Foreign PDF execution');
 assert(run.head_sha===expected.verificationController&&run.head_branch==='codex/browser-recovery-verifier-20261030'&&run.display_title===PDF_REPAIR_TITLE&&run.event==='workflow_dispatch'&&run.run_attempt===1&&run.status==='completed'&&run.conclusion==='success','Reviewed exact PDF execution required');
 const start=Date.parse(run.created_at),end=Date.parse(run.updated_at);assert(Number.isFinite(start)&&Number.isFinite(end)&&start>=Date.parse(expected.after)&&end>=start&&end<=now+60000&&now-start<=86400000,'PDF execution stale or precedes original');
 const names=['resolve','typecheck','migrations','test','controller-tests','plan','runner-diagnostics','build','browser','verify','deployment-hold'];
 assert(jobs.length===names.length&&new Set(jobs.map(j=>j.name)).size===names.length&&new Set(jobs.map(j=>j.id)).size===names.length,'Complete PDF execution job inventory required');
 for(const j of jobs){
  const active=['resolve','deployment-hold'].includes(j.name);
  assert(names.includes(j.name)&&Number.isSafeInteger(j.id)&&j.id>0&&j.run_id===run.id&&j.head_sha===run.head_sha&&j.head_branch===run.head_branch&&j.run_attempt===1&&j.status==='completed'&&j.conclusion===(active?'success':'skipped'),'Foreign or failed PDF producing job');
  if(active)assert(Date.parse(j.started_at)>=start&&Date.parse(j.completed_at)>=Date.parse(j.started_at)&&Date.parse(j.completed_at)<=end,'PDF job outside producing execution');
 }
 const producer=jobs.find(j=>j.name==='resolve'),step=producer.steps?.filter(s=>s.name==='Run complete audited PDF unit with pinned execution code');assert(step?.length===1&&step[0].conclusion==='success','PDF setup or diagnostic cannot substitute for executed unit');
 const namesAllowed=['controller-plan-diagnostics','fixture-impact-projection-diagnostic','fixture-pdf-unit-evidence'];
 assert(artifacts.length===3&&new Set(artifacts.map(a=>a.name)).size===3&&new Set(artifacts.map(a=>a.id)).size===3,'Exact PDF artifact inventory required');
 for(const a of artifacts){const w=a.workflow_run;assert(namesAllowed.includes(a.name)&&Number.isSafeInteger(a.id)&&a.id>0&&Number.isSafeInteger(a.size_in_bytes)&&a.size_in_bytes>0&&a.size_in_bytes<=64*1024**2&&a.expired===false&&/^sha256:[a-f0-9]{64}$/.test(a.digest),'Invalid PDF artifact');assert(w?.id===run.id&&w.repository_id===REPOSITORY_ID&&w.head_repository_id===REPOSITORY_ID&&w.head_sha===run.head_sha&&w.head_branch===run.head_branch,'Foreign PDF artifact provenance');assert(Date.parse(a.created_at)>=Date.parse(producer.started_at)&&Date.parse(a.created_at)<=Date.parse(producer.completed_at)&&Date.parse(a.expires_at)>now,'PDF artifact outside producing job');}
 return {producer,artifact:artifacts.find(a=>a.name==='fixture-pdf-unit-evidence')};
}
