import {describe,it,expect,vi} from 'vitest';
import type {Tx} from '../db/client';
import {withContractPostingIntentTx,contractPostingMovementAuthorityTx,contractPostingInfoAuthorityTx,contractPostingAssignmentAuthorityTx,type ContractPostingIntent} from '../core/contract-posting-authority';
const renewal:ContractPostingIntent={postingId:'posting',employmentId:'employment',kind:'contractRenewal',movementKind:'contractRenewal',previousEndDate:'2026-12-31',effectiveDate:'2027-01-01',endDate:'2027-06-30',contractNumber:'5',remarks:'Agreed renewal',completed:false,groupId:null};
const transaction=(intent:ContractPostingIntent)=>({execute:vi.fn().mockResolvedValue([{intent}])}) as unknown as Tx;
describe('fixed-source Contract posting authority',()=>{
 it('grants no authority outside its own verified transaction or after the callback',async()=>{
  const tx=transaction(renewal),other=transaction(renewal),input={employmentId:renewal.employmentId,kind:renewal.kind,effectiveDate:renewal.effectiveDate,endDate:renewal.endDate,contractStartDate:renewal.effectiveDate,contractNumber:renewal.contractNumber,contractPostingId:renewal.postingId,remarks:renewal.remarks};
  expect(contractPostingMovementAuthorityTx(tx,input)).toBe(false);
  await withContractPostingIntentTx(tx,renewal.postingId,async()=>{
   expect(contractPostingMovementAuthorityTx(tx,input)).toBe(true);expect(contractPostingMovementAuthorityTx(other,input)).toBe(false);
   for(const changed of [{employmentId:'someone-else'},{effectiveDate:'2027-01-02'},{kind:'promotion'},{basicSalary:5200},{departmentId:'new-department'},{contractNumber:'6'},{remarks:'Different statement'},{typeCode:'termination'}])expect(contractPostingMovementAuthorityTx(tx,{...input,...changed})).toBe(false);
  });
  expect(contractPostingMovementAuthorityTx(tx,input)).toBe(false);
 });
 it('the Personnel information leg must carry the entire agreed renewal period and counter, with no other field',async()=>{
  const tx=transaction(renewal),movement={type:renewal.kind,effectiveDate:renewal.effectiveDate},input={employmentId:renewal.employmentId,contractStartDate:renewal.effectiveDate,contractEndDate:renewal.endDate,contractNumber:'5',movement};
  await withContractPostingIntentTx(tx,renewal.postingId,async()=>{
   expect(contractPostingInfoAuthorityTx(tx,input)).toBe(true);
   expect(contractPostingInfoAuthorityTx(tx,{...input,contractNumber:undefined})).toBe(false);
   expect(contractPostingInfoAuthorityTx(tx,{...input,confirmationDate:'2027-01-01'})).toBe(false);
   expect(contractPostingInfoAuthorityTx(tx,{...input,movement:{...movement,type:'confirmation'}})).toBe(false);
  });
 });
 it('a conversion changes only the dated employment type and clears its contract dates; it cannot acquire probation or organisation authority',async()=>{
  const intent={...renewal,kind:'contractConversion' as const,movementKind:'employmentTypeChange' as const,endDate:null,contractNumber:null},tx=transaction(intent),movement={type:intent.movementKind,effectiveDate:intent.effectiveDate};
  await withContractPostingIntentTx(tx,intent.postingId,async()=>{
   const assignment={employmentId:intent.employmentId,effectiveDate:intent.effectiveDate,employmentType:'full_time',movement};
   expect(contractPostingAssignmentAuthorityTx(tx,assignment)).toBe(true);
   for(const changed of [{companyId:'another-company'},{departmentId:'another-department'},{costCenterId:'another-cost-centre'},{employmentType:'contract'},{movement:{...movement,type:'transfer'}}])expect(contractPostingAssignmentAuthorityTx(tx,{...assignment,...changed})).toBe(false);
   expect(contractPostingInfoAuthorityTx(tx,{employmentId:intent.employmentId,contractStartDate:null,contractEndDate:null,movement})).toBe(true);
   expect(contractPostingInfoAuthorityTx(tx,{employmentId:intent.employmentId,contractStartDate:null,contractEndDate:null,probationEndDate:'2027-04-01',movement})).toBe(false);
  });
 });
 it('cleans up a failed callback and treats completed source receipts as read-only',async()=>{
  const tx=transaction(renewal);
  await expect(withContractPostingIntentTx(tx,renewal.postingId,async()=>{throw new Error('writer refused');})).rejects.toThrow('writer refused');
  expect(contractPostingInfoAuthorityTx(tx,{employmentId:renewal.employmentId})).toBe(false);
  const done=transaction({...renewal,completed:true});
  await withContractPostingIntentTx(done,renewal.postingId,async()=>expect(contractPostingMovementAuthorityTx(done,{})).toBe(false));
 });
});
