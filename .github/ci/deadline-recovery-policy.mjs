/** v4 permits one byte-exact fixture deadline repair; no assertion or application edits. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {hash} from './manifest.mjs';
export const DEADLINE_RECOVERY_POLICY='aihr-test-deadline-recovery/v4';
export const DEADLINE_PATH='test/human-module-planner.test.ts';
export const DEADLINE_BEFORE="describe('consented human-question planner with human-reviewed canonical jobs',()=>{";
export const DEADLINE_AFTER="describe('consented human-question planner with human-reviewed canonical jobs',{timeout:60_000},()=>{";
const sha=x=>typeof x==='string'&&/^[a-f0-9]{40}$/.test(x);
const id=x=>Number.isSafeInteger(x)&&x>0;
export function validateDeadlineRepairBytes({changed,before,after}){
 assert(isDeepStrictEqual(changed,[DEADLINE_PATH]),'Only the named existing planner fixture may change');
 assert(Buffer.isBuffer(before)&&before.length>1000&&before.length<1024**2&&Buffer.isBuffer(after),'Bounded complete original fixture bytes required');
 const text=before.toString('utf8');assert(Buffer.from(text).equals(before),'Original fixture must be exact UTF8');
 assert(text.split(DEADLINE_BEFORE).length===2&&!text.includes(DEADLINE_AFTER),'Exactly one original fixture suite required');
 assert(after.equals(Buffer.from(text.replace(DEADLINE_BEFORE,DEADLINE_AFTER))),'Only the exact bounded suite deadline insertion is permitted');
 const digest=b=>createHash('sha256').update(b).digest('hex');
 return {kind:'EXACT_FIXTURE_DEADLINE_ONLY',path:DEADLINE_PATH,timeoutMs:60000,beforeSha256:digest(before),afterSha256:digest(after)};
}
export function validateDeadlineFocusedTerminal(focused){
 assert(Array.isArray(focused)&&focused.length===1,'One complete original DB process required');
 const f=focused[0],r=f.report;assert(r?.groups?.DB?.length>0&&r.groups.NODB?.length===0&&r.batches?.length===1,'One homogeneous DB process required');
 const times=[r.startedAt,r.batches[0].startedAt,r.batches[0].endedAt,r.databaseTerminalEvidence?.capturedAt,r.endedAt,f.producer?.completed_at].map(Date.parse);
 assert(times.every(Number.isFinite)&&times.every((t,i)=>i===0||t>=times[i-1]),'Terminal DB evidence must follow the entire test process');
}
export function deadlineRecoveryCertificate(c,deadline){
 assert(c.kind==='AUTHENTICATED_CROSS_SOURCE_RECOVERY'&&c.recoveryPolicy==='aihr-cross-source-recovery/v2'&&c.originalConclusion==='failure','Complete cross-source verification required first');
 assert(deadline?.kind==='EXACT_FIXTURE_DEADLINE_ONLY'&&deadline.path===DEADLINE_PATH&&deadline.timeoutMs===60000,'Exact deadline delta required');
 assert(c.disposition.fresh.length===1&&c.units.filter(u=>u.kind==='repaired-source').length===1,'Only the complete original failed process may be replaced');
 return {...c,kind:'AUTHENTICATED_TEST_DEADLINE_RECOVERY',recoveryPolicy:DEADLINE_RECOVERY_POLICY,deadline};
}
export function validateDeadlineGrantEvidence(evidence,run){
 const c=evidence.recovery;
 assert(c?.kind==='AUTHENTICATED_TEST_DEADLINE_RECOVERY'&&c.recoveryPolicy===DEADLINE_RECOVERY_POLICY&&c.originalConclusion==='failure'&&sha(c.originalSha)&&sha(c.sha)&&sha(c.controller)&&sha(c.baseline)&&id(c.originalRunId)&&id(c.runId)&&c.originalSha!==c.sha&&c.originalRunId!==c.runId&&evidence.fingerprint===hash(c),'Authenticated v4 deadline certificate required');
 assert(c.pendingReview===false&&c.reviewedController===c.verificationController&&c.releaseAuthorized===false,'Exact independent verifier review required');
 assert(c.deadline?.kind==='EXACT_FIXTURE_DEADLINE_ONLY'&&c.deadline.path===DEADLINE_PATH&&c.deadline.timeoutMs===60000&&isDeepStrictEqual(c.delta?.deadline,c.deadline)&&isDeepStrictEqual(c.delta?.changed,[DEADLINE_PATH]),'Exact deadline source delta missing');
 for(const k of ['beforeSha256','afterSha256'])assert(/^[a-f0-9]{64}$/.test(c.deadline[k]??''),'Deadline byte identity missing');
 for(const key of ['sha','controller','verificationController','baseline','runId','policyVersion','suiteFiles','browserFiles','tests'])assert(isDeepStrictEqual(evidence[key],c[key]),'Deadline grant identity differs: '+key);
 assert(sha(c.verificationController)&&run.id===c.runId&&run.head_sha===c.controller&&run.conclusion==='success'&&run.status==='completed'&&run.run_attempt===1&&c.verificationDiagnostic?.controller===c.verificationController&&id(c.verificationDiagnostic.runId)&&c.compilers?.length>0&&c.focusedSources?.length>0&&c.units?.filter(u=>u.kind==='repaired-source').length===1&&c.disposition?.fresh?.length===1,'Fresh build/compiler/full-process/controller provenance required');
 return true;
}
