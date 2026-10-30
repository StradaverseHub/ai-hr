import {describe,it,expect} from 'vitest';
import {EmployeeDraftActivation as C,EmployeeDraftActivationBrowserPacket as Packet} from '../lib/assistant-actions/employee-draft-activation-contract';
import {supportedEmployeeDraftActivationData} from '../core/assistant-actions/employee-draft-activation-source';
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
