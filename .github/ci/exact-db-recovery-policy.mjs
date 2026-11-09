/** Admission for one complete failed database unit on the original, unchanged build source. */
import assert from 'node:assert/strict';
import {hash,DB_BATCH_FILES} from './manifest.mjs';
import {focusedPlanIdentity} from './focused-checks.mjs';
import {validatePostgresEvidence} from './postgres-evidence.mjs';
import {validateDisposableRoleFixture,validateFullCiRoleReceipt} from './run-unit.mjs';

export const EXACT_DB_RECOVERY_POLICY='aihr-exact-db-recovery/v1';
export const PREMIGRATION_ROLES='personnel-draft-discard-premigration-role-prerequisites.json';
export const FOCUSED_ROLES='personnel-draft-discard-role-prerequisites.json';

export function verifyExactDatabaseBatch({plan,unit,run,originalJob,originalReport,originalRole,focused,roleHashes}){
 const r=focused.report,batch=r.batches[0],terminal=r.databaseTerminalEvidence;
 assert(unit?.kind==='db'&&!unit.pdfTools,'Exact database recovery needs an ordinary database unit');
 assert.deepEqual(r.files,unit.files.slice().sort(),'Rerun the complete original database unit');
 const expected=focusedPlanIdentity({sha:plan.sha,controller:plan.controller,files:r.files,
  groups:{NODB:[],DB:r.files},classifierHash:r.classifierHash,
  execution:{workers:plan.execution.workers,postgres:plan.execution.postgres}});
 for(const [key,value] of Object.entries(expected))assert.deepEqual(r[key],value,'Focused database plan differs: '+key);
 assert(originalReport?.batches?.length===1&&originalReport.batches[0].exitCode!==0&&originalJob?.conclusion==='failure','Original database process evidence is incomplete');
 for(const evidence of [originalReport.batches[0].databaseEvidence,originalReport.databaseTerminalEvidence]){
  validatePostgresEvidence(evidence,plan.execution);
  assert(evidence.name===`aihr-ci-${run.id}-1-${unit.id}`&&Date.parse(evidence.capturedAt)>=Date.parse(originalJob.started_at)
   &&Date.parse(evidence.capturedAt)<=Date.parse(originalJob.completed_at),'Original PostgreSQL ownership or capture interval differs');
 }
 validatePostgresEvidence(terminal,plan.execution);
 assert(terminal.name===`aihr-ci-${focused.run.id}-1-db-1`
  &&Date.parse(batch.startedAt)>=Date.parse(r.startedAt)&&Date.parse(batch.endedAt)>=Date.parse(batch.startedAt)
  &&Date.parse(terminal.capturedAt)>=Date.parse(batch.endedAt)&&Date.parse(terminal.capturedAt)<=Date.parse(r.endedAt)
  &&[originalReport.batches[0].databaseEvidence,originalReport.databaseTerminalEvidence].every(e=>e.settings.serverVersionNum===terminal.settings.serverVersionNum),
 'Replacement PostgreSQL ownership, capture interval or server version differs');
 const summary=originalReport.batches[0].rolePrerequisites;
 if(!roleHashes){
  assert(!summary&&!originalRole&&!focused.preMigrationRoles&&!focused.roles,'Unexpected database role prerequisite evidence');
  return {unitId:unit.id,postgresEvidenceHash:hash(terminal)};
 }
 const binding={mode:'full_ci_disposable',candidate:plan.sha,controller:plan.controller,runId:String(run.id),
  attempt:'1',unit:unit.id,offset:0,planFingerprint:plan.fingerprint,batchSize:DB_BATCH_FILES,batchFiles:unit.files};
 const receipt=originalRole?.receipt;
 const full=validateFullCiRoleReceipt(receipt,binding,roleHashes);
 assert.deepEqual(summary,{...full,basename:`personnel-dd-full-role-${unit.id}-offset-0.json`,sha256:originalRole.sha256},
  'Original premigration role receipt differs');
 const pre=focused.preMigrationRoles,post=focused.roles;
 const identity={candidate:plan.sha,controller:plan.controller,runId:String(focused.run.id)};
 const fixture=pre?.fixture;
 validateDisposableRoleFixture(fixture,'focused_disposable');
 assert.deepEqual(pre,{kind:'PERSONNEL_DRAFT_DISCARD_PREMIGRATION_ROLE_PREREQUISITES',phase:'before_initial_candidate_migration',
  scope:'job-owned disposable focused cluster only; no installation or native proof attestation',
  ...identity,attempt:'1',...roleHashes,fixture},'Replacement premigration role receipt differs');
 assert.deepEqual(post,{kind:'PERSONNEL_DRAFT_DISCARD_DISPOSABLE_ROLE_PREREQUISITES',
  scope:'disposable focused cluster only; no installation attestation',...identity,helperSha256:roleHashes.helperSha256,...fixture},
 'Replacement role fixture differs');
 assert(fixture.postgres.versionNumber===Number(terminal.settings.serverVersionNum)
  &&full.postgresVersionNumber===fixture.postgres.versionNumber,'Database role fixture server version differs');
 return {unitId:unit.id,postgresEvidenceHash:hash(terminal),originalRoleReceiptSha256:originalRole.sha256,
  premigrationRolesHash:hash(pre),rolesHash:hash(post)};
}
