/** Authenticate the candidate of another run of a shared controller. Never accepts its tests for this release. */
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {REPOSITORY,REPOSITORY_ID,WORKFLOW_ID,WORKFLOW_PATH} from './release-policy.mjs';
export function inspectOtherControllerRun({snapshot,artifact,archivedPlan,reconstructedPlan,candidate,controller}) {
 const {run,jobs,artifacts}=snapshot;
 assert(run?.repository?.id===REPOSITORY_ID&&run.repository.full_name===REPOSITORY&&run.head_repository?.id===REPOSITORY_ID,'Foreign additional run');
 assert(run.workflow_id===WORKFLOW_ID&&run.path===WORKFLOW_PATH&&run.head_branch==='alpha'&&run.head_sha===controller&&run.event==='workflow_dispatch','Untrusted additional controller run');
 assert(run.status==='completed'&&['success','failure'].includes(run.conclusion)&&run.run_attempt===1,'Additional run not terminal first attempt');
 assert(/^[a-f0-9]{40}$/.test(archivedPlan?.sha??'')&&archivedPlan.sha!==candidate&&archivedPlan.controller===controller,'Additional run concerns this candidate or is unbound');
 assert(isDeepStrictEqual(archivedPlan,reconstructedPlan),'Additional candidate plan differs from immutable sources');
 const matches=artifacts.filter(a=>a.name==='gate-plan');assert(matches.length===1&&isDeepStrictEqual(matches[0],artifact),'Ambiguous additional plan');
 assert(artifact.expired===false&&Number.isSafeInteger(artifact.id)&&artifact.id>0&&Number.isSafeInteger(artifact.size_in_bytes)&&artifact.size_in_bytes>0&&artifact.size_in_bytes<=1048576&&/^sha256:[a-f0-9]{64}$/.test(artifact.digest??''),'Invalid additional plan archive');
 const w=artifact.workflow_run;assert(w?.id===run.id&&w.repository_id===REPOSITORY_ID&&w.head_repository_id===REPOSITORY_ID&&w.head_sha===controller&&w.head_branch==='alpha','Additional archive provenance differs');
 const start=Date.parse(run.created_at),end=Date.parse(run.updated_at);assert(Number.isFinite(start)&&Number.isFinite(end)&&start<=end,'Invalid additional chronology');
 for(const name of ['resolve','plan']){const matches=jobs.filter(j=>j.name===name);assert(matches.length===1,'Missing/ambiguous additional bootstrap');const j=matches[0];assert(j.run_id===run.id&&j.run_attempt===1&&j.head_sha===controller&&j.head_branch==='alpha'&&j.status==='completed'&&j.conclusion==='success','Additional bootstrap untrusted');assert(Date.parse(j.started_at)>=start&&Date.parse(j.completed_at)>=Date.parse(j.started_at)&&Date.parse(j.completed_at)<=end,'Additional job chronology differs');if(name==='plan')assert(Date.parse(artifact.created_at)>=Date.parse(j.started_at)&&Date.parse(artifact.created_at)<=Date.parse(j.completed_at),'Additional plan outside producer');}
 return{kind:'AUTHENTICATED_DIFFERENT_CANDIDATE_NOT_RELEASE_COVERAGE',runId:run.id,candidate:archivedPlan.sha,controller,planFingerprint:archivedPlan.fingerprint,artifactId:artifact.id,artifactDigest:artifact.digest,releaseCandidate:candidate,coverageReused:false,releaseAuthorized:false};
}
