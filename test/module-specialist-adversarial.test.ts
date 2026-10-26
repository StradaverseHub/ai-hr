/** Independently authored business counterexamples. UNRUN; synthetic permitted projections only.
 * These do not establish actual native authorization, provider quality or release readiness. */
import {describe,expect,it} from 'vitest';
import {executeCanonicalSpecialist} from '../lib/ai/module-specialists';
import {MODULE_AGENT_CAPABILITIES,type AgentModuleCode} from '../lib/ai/module-agents';

const bounded=(rows:unknown[],truncated=false)=>({rows,truncated});
function assess(module:AgentModuleCode,data:unknown){
 return executeCanonicalSpecialist({kind:'canonical_specialist_v1',module,playbook:'canonical_domain_v1'},
  {module,capability:MODULE_AGENT_CAPABILITIES.find(([code])=>code===module)![1],scope:'current-caller',data});
}
const facts=(view:ReturnType<typeof assess>)=>view.presentation.cards.flatMap(card=>card.facts);

describe('specialists preserve business meaning rather than inventing HR conclusions',()=>{
 it('copies inconsistent recorded payroll numbers without repairing or computing the net',()=>{
  const result=assess('payroll',bounded([{payPeriod:'2026-01',company:'Fictional',gross:'100.00',deductions:'5.00',net:'93.17',currency:'MYR',runType:'regular',runSeq:1}]));
  expect(facts(result).find(fact=>fact.field==='net')?.value).toBe('93.17');
  expect(facts(result).some(fact=>fact.value==='95.00')).toBe(false);
  expect(result.findings).toContain('released_pay_stored_only');expect(result.effects).toEqual([]);
 });
 it('refuses a withheld balance carrying poisoned values instead of recovering their presence or amounts',()=>{
  expect(()=>assess('leave',bounded([{balances:[{leaveType:'Fictional annual',withheld:true,available:98765,pending:12345,taken:2}]}]))).toThrow();
 });
 it('preserves an approved unpaid claim without treating approval as payment',()=>{
  const result=assess('claims',{hasEmployment:true,truncated:false,claims:[{claimType:'Fictional travel',status:'approved',incurredOn:'2026-01-01',createdAt:'2026-01-01',decidedAt:'2026-01-02',paidAt:null}]});
  expect(result.findings).toContain('claim_approved_not_paid');expect(result.findings).not.toContain('claim_payment_recorded');
  expect(facts(result).find(fact=>fact.field==='paidAt')?.value).toBeNull();
 });
 it('does not let a complete aggregate hide an unfinished applicable onboarding step',()=>{
  const result=assess('lifecycle',{status:'in_progress',progress:{done:2,total:2,percent:100},steps:[{label:'Fictional acknowledgement',applicable:true,done:false}]});
  expect(result.findings).toContain('lifecycle_steps_remaining');expect(result.findings).not.toContain('lifecycle_progress_complete');
 });
 it('does not invent a missing administrative manager from a functional reporting line',()=>{
  const result=assess('org',bounded([{company:'Fictional',reportingLines:[{name:'Fictional functional manager',employeeCode:'FIC',lineType:'functional'}]}]));
  expect(result.findings).toContain('administrative_manager_missing');expect(result.findings).toContain('reporting_recorded');
 });
 it('preserves stored component precision without rounding or deriving payroll money',()=>{
  const result=assess('typed_pay_components',bounded([{payPeriod:'2026-01',currency:'MYR',lines:bounded([{name:'Fictional component',code:'FIC',amount:'1234.567891'}])}]));
  expect(facts(result).find(fact=>fact.field==='amount')?.value).toBe('1234.567891');expect(result.effects).toEqual([]);
 });
 it('keeps a human reported test pass distinct from independent execution evidence',()=>{
  const result=assess('system_testing',bounded([{title:'Fictional assigned case',caseNo:7,moduleCode:'leave',ordinal:2,status:'passed',updatedAt:'2026-01-01'}]));
  expect(result.findings).toContain('human_test_pass_not_independent_verification');expect(result.effects).toEqual([]);
 });
 it('keeps reward posting distinct from processing payroll or paying a person',()=>{
  const result=assess('rewards',bounded([{cycle:'Fictional cycle',company:'Fictional',unit:'month',kind:'bonus',year:2026,status:'posted',revision:1}]));
  expect(result.findings).toContain('reward_posted_not_processed_or_paid');expect(result.effects).toEqual([]);
 });
 it('does not turn an empty own scope into a claim that the tenant has no records',()=>{
  const result=assess('employees',bounded([]));expect(result.presentation.cards).toEqual([]);
  expect(result.findings).toContain('empty_is_not_tenant_absence');expect(result.findings).not.toContain('employment_active');
 });
 it('retains the truncated boundary without treating visible rows as complete scope',()=>{
  const result=assess('employees',bounded([{company:'Fictional',status:'active',hiredOn:'2020-01-01',terminatedOn:null}],true));
  expect(result.presentation.truncated).toBe(true);expect(result.findings).toContain('bounded_results');
 });
 it('does not grant record access merely because a schema table name is visible',()=>{
  const result=assess('system_explorer',{withheldTables:1,tables:bounded([{table:'employment',module:'employees'}])});
  expect(result.findings).toContain('schema_inventory_not_record_access');expect(result.effects).toEqual([]);
 });
 it('rejects privilege and effect fields added to the supposedly closed candidate',()=>{
  for(const extra of [{roles:['super_admin']},{execute:true},{qualityScore:1}]){
   expect(()=>executeCanonicalSpecialist({kind:'canonical_specialist_v1',module:'employees',playbook:'canonical_domain_v1',...extra},
    {module:'employees',capability:'own_work_profile',scope:'current-caller',data:bounded([])})).toThrow();
  }
 });
});
