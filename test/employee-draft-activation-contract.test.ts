import {describe,it,expect} from 'vitest';
import {EmployeeDraftActivation as C,EmployeeDraftActivationBrowserPacket as Packet} from '../lib/assistant-actions/employee-draft-activation-contract';
import {employeeDraftActivationEntitlements,supportedEmployeeDraftActivationData} from '../core/assistant-actions/employee-draft-activation-source';
const id='11111111-1111-4111-8111-111111111111';
describe('human saved draft nomination',()=>{
 it('accepts only existing Draft/company selectors, never captured values or effects from a model',()=>{
  const human={action:C.action,contractVersion:1,draftId:id,companyId:id};expect(C.Human.parse(human)).toEqual(human);
  for(const value of [{...human,data:{}},{...human,employmentId:id},{...human,confirmed:true},{...human,actor:'hr_admin'}])expect(C.Human.safeParse(value).success).toBe(false);
  expect(Packet.safeParse({action:C.action,operation:'confirm',confirmation:{...human,actionId:id,reviewedDigest:'a'.repeat(64)}}).success).toBe(false);
 });
 it('keeps unsupported captured facts in native review instead of silently dropping them',()=>{
  expect(supportedEmployeeDraftActivationData({profile:{fullName:'Fictional'},employment:{companyId:id},payroll:{basicSalary:'3000'}})).toBe(true);
  for(const value of [{profile:{preferredName:'Human entered name'}},{statutory:{bankName:'Human bank'}},{family:[{fullName:'Human child'}]},{employment:{gradeId:id}},{profile:{fullName:42}}])expect(supportedEmployeeDraftActivationData(value)).toBe(false);
 });
});

it('requires a closed handoff reason exactly when a draft is unsupported',()=>{
 const row={draftId:id,companyId:id,label:'Fictional saved draft',employeeCode:'SAVED-1',route:'/admin/personnel/new'},choices=(draft:unknown)=>({kind:'choices',drafts:[draft],truncated:false});
 for(const unsupportedReason of ['captured_shape','configured_onboarding'])expect(C.Choices.safeParse(choices({...row,supported:false,unsupportedReason})).success).toBe(true);
 expect(C.Choices.safeParse(choices({...row,supported:true,unsupportedReason:null})).success).toBe(true);
 for(const draft of [{...row,supported:false,unsupportedReason:null},{...row,supported:true,unsupportedReason:'configured_onboarding'},{...row,supported:false,unsupportedReason:'invented'},{...row,supported:false}])expect(C.Choices.safeParse(choices(draft)).success).toBe(false);
});
it('canonicalizes commercial module/company sets for the private source digest without mutating permissions',()=>{
 const left={tenantId:id,tenantStatus:'active',enabledModules:['lifecycle','assistant','assistant'],scopedModules:{employees:['b','a','a'],leave:['d','c']},settings:{z:1,a:false}},right={...left,enabledModules:['assistant','lifecycle'],scopedModules:{leave:['c','d'],employees:['a','b']},settings:{a:false,z:1}};
 expect(JSON.stringify(employeeDraftActivationEntitlements(left))).toBe(JSON.stringify(employeeDraftActivationEntitlements(right)));expect(left.enabledModules).toEqual(['lifecycle','assistant','assistant']);expect(left.scopedModules.employees).toEqual(['b','a','a']);
});
