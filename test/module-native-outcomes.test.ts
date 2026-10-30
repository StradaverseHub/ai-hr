/** Authored source-only; no runtime acceptance is implied. */
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {AGENT_ACTIONS} from '../lib/ai/agent-action-registry';
import {MODULE_AGENT_ACTIONS} from '../lib/ai/module-agent-actions';
import {NATIVE_OUTCOME_ACTIONS,NATIVE_REVIEW_ACTIONS,NON_EFFECT_OBSERVATIONS,NativeOutcomeReference,RecordNativeOutcomeAssociation,NativeOutcomeAssociationView} from '../lib/ai/module-native-outcomes';

describe('closed native outcome association contract',()=>{
 it('covers every declared effect action, without inventing Explorer or Assistant effects',()=>{
  const actions=Object.values(MODULE_AGENT_ACTIONS).flatMap(module=>module.actions.map(action=>action.id));
  expect(Object.keys(NATIVE_OUTCOME_ACTIONS).sort()).toEqual(actions.sort());
  for(const action of ['approvals.claim.chase','approvals.attendance.chase','approvals.toil.chase','employees.review_overdue.remind']){
   expect(Object.hasOwn(NATIVE_OUTCOME_ACTIONS,action)).toBe(false);
   expect(NativeOutcomeReference.safeParse({source:'review',action,actionId:randomUUID()}).success).toBe(false);
  }
  expect(NATIVE_REVIEW_ACTIONS).toHaveLength(AGENT_ACTIONS.filter(row=>row.store!=='human_workflow_only').length);expect(Object.keys(NATIVE_OUTCOME_ACTIONS)).toHaveLength(actions.length);
  expect(NON_EFFECT_OBSERVATIONS).toEqual({system_explorer:'authorized_schema_observation',assistant:'authorized_orchestration_read_execution'});
 });
 it('accepts only explicit consent, closed references and server-owned import versions',()=>{
  const valid={jobId:randomUUID(),reference:{source:'review',action:'leave.apply',actionId:randomUUID()},nonce:randomUUID(),consented:true};
  expect(RecordNativeOutcomeAssociation.parse(valid)).toEqual(valid);
  for(const invalid of [{...valid,consented:false},{...valid,score:1},{...valid,reference:{...valid.reference,eventId:randomUUID()}},{...valid,reference:{...valid.reference,action:'assistant.execute'}}])expect(RecordNativeOutcomeAssociation.safeParse(invalid).success).toBe(false);
  expect(NativeOutcomeReference.safeParse({source:'employee_import',action:'employees.import',attemptId:randomUUID(),attemptVersion:1,companyId:randomUUID()}).success).toBe(true);
  expect(NativeOutcomeReference.safeParse({source:'employee_import',action:'employees.import',attemptId:randomUUID(),attemptVersion:0,companyId:randomUUID()}).success).toBe(false);
 });
 it('cannot describe a native receipt as quality, causal savings or a returned HR value',()=>{
  const view={associationId:randomUUID(),action:'leave.apply',module:'leave',semantics:'submitted_not_approved',currentStatus:null,association:'human_linked_verified_native_outcome',causalCredit:false,quality:'not_assessed',createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+1000).toISOString()};
  expect(NativeOutcomeAssociationView.safeParse(view).success).toBe(true);
  for(const invalid of [{...view,quality:'verified_correct'},{...view,causalCredit:true},{...view,salary:'100'}])expect(NativeOutcomeAssociationView.safeParse(invalid).success).toBe(false);
 });
 it('keeps custody append/delete-only and enforces actual mutations under the same canonical interval',()=>{
  const source=readFileSync(new URL('../db/migrations/0650_ai_native_outcomes.sql',import.meta.url),'utf8');
  expect(source).toContain('GRANT SELECT,INSERT,DELETE ON public.ai_native_outcome_association TO ai_hr_app');
  expect(source).not.toMatch(/GRANT[^;]*UPDATE[^;]*TO ai_hr_app/);
  expect(source).toContain('BEFORE INSERT OR DELETE ON public.ai_native_outcome_association');
  expect(source).toContain("'native-outcome:v1:'||t::text||':'||u::text");
  expect(source).toContain('UNIQUE(tenant_id,user_id,event_id)');
  const owner=readFileSync(new URL('../core/module-native-outcome-references.ts',import.meta.url),'utf8');
  expect(owner).not.toContain('for update');expect(owner).not.toContain("from './module-agent-releases'");
  expect(owner).toContain('await lockNativeOutcomeCustodyTx(tx,ctx)');
 });
});
