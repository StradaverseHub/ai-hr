/** Request boundary coverage. Actual writes/revocation/audit are exercised by workforce-access. */
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {requireWorkforceAccess} from '../lib/workforce-authz';
import {maintainWorkforceRecord,WorkforceMaintenanceValidationError,WorkforceMaintenanceUnavailableError} from '../core/workforce-maintenance';
import {WorkforceAccessError} from '../core/workforce-access';
import {WorkforceRecordChangedError} from '../core/workforce-code';
import {workforceMaintenanceFields} from '../lib/workforce-maintenance-fields';
import {saveWorkforceRecordAction} from '../app/(app)/admin/personnel/[employmentId]/workforce-record-actions';
vi.mock('next/navigation',()=>({redirect:(url:string)=>{throw new Error(`redirect:${url}`);}}));
vi.mock('next/cache',()=>({revalidatePath:vi.fn()}));
vi.mock('../lib/workforce-authz',()=>({requireWorkforceAccess:vi.fn()}));
vi.mock('../core/workforce-maintenance',()=>({maintainWorkforceRecord:vi.fn(),WorkforceMaintenanceValidationError:class extends Error{},WorkforceMaintenanceUnavailableError:class extends Error{}}));
const id='11111111-1111-4111-8111-111111111111',row='22222222-2222-4222-8222-222222222222';
const ctx={tenantId:id,userId:row,roles:['employee'],grants:[{role:'employee',companyId:null}]};
const path=`/admin/personnel/${id}`;
function form(){
 const f=new FormData();f.set('employmentId',id);f.set('kind','person');f.set('operation','update');f.set('section','personal');f.set('expectedVersion','1042');
 for(const {key}of workforceMaintenanceFields('person','personal'))f.set(key,'');
 f.set('fullName','Fictional normal colleague');return f;
}
beforeEach(()=>{
 vi.clearAllMocks();vi.mocked(requireWorkforceAccess).mockResolvedValue({s:ctx,scopeIds:[id],allowedCount:1,companyIds:[id]});
 vi.mocked(maintainWorkforceRecord).mockReset().mockResolvedValue({id,changed:true});
});
describe('scoped Workforce value action',()=>{
 it('binds the authenticated actor, selected section and opaque version; discards forged authority and other fields',async()=>{
  const f=form();for(const [k,v]of Object.entries({userId:'forged',personId:row,companyId:row,role:'hr_admin',salary:'50000',primaryEmail:'not-in-this-section@example.invalid'}))f.set(k,v);
  await expect(saveWorkforceRecordAction(f)).rejects.toThrow(`redirect:${path}?workforceEdit=saved`);
  const [actor,command]=vi.mocked(maintainWorkforceRecord).mock.calls[0];expect(actor).toBe(ctx);
  expect(command).toMatchObject({employmentId:id,kind:'person',operation:'update',rowId:null,expectedVersion:'1042',patch:{fullName:'Fictional normal colleague'}});
  for(const key of ['userId','personId','companyId','role','salary','primaryEmail'])expect(command.patch).not.toHaveProperty(key);
 });
 it.each(['section','expectedVersion','fullName'])('refuses missing %s before executing a command',async key=>{
  const f=form();f.delete(key);await expect(saveWorkforceRecordAction(f)).rejects.toThrow(`redirect:${path}?workforceEdit=invalid`);
  expect(maintainWorkforceRecord).not.toHaveBeenCalled();
 });
 it('refuses a duplicated value or operation and an unsupported register',async()=>{
  const cases=[()=>{const f=form();f.append('fullName','ambiguous');return f;},()=>{const f=form();f.append('operation','archive');return f;},()=>{const f=form();f.set('kind','bank');return f;}];
  for(const build of cases)await expect(saveWorkforceRecordAction(build())).rejects.toThrow(`redirect:${path}?workforceEdit=invalid`);
  expect(maintainWorkforceRecord).not.toHaveBeenCalled();
 });
 it('archives only the identified register row and version, without replaying form values',async()=>{
  const f=new FormData();Object.entries({employmentId:id,kind:'emergency',operation:'archive',rowId:row,expectedVersion:'1050',fullName:'not written'}).forEach(([k,v])=>f.set(k,v));
  await expect(saveWorkforceRecordAction(f)).rejects.toThrow(`redirect:${path}?workforceEdit=saved`);
  expect(maintainWorkforceRecord).toHaveBeenCalledExactlyOnceWith(ctx,{employmentId:id,kind:'emergency',operation:'archive',rowId:row,expectedVersion:'1050',patch:{}});
 });
 it('parses explicit boolean choices for a new Qualification without accepting a caller row id',async()=>{
  const f=new FormData();Object.entries({employmentId:id,kind:'qualification',operation:'add'}).forEach(([k,v])=>f.set(k,v));
  for(const {key,field}of workforceMaintenanceFields('qualification'))f.set(key,field.type==='boolean'?'true':'');f.set('qualification','Master');
  await expect(saveWorkforceRecordAction(f)).rejects.toThrow(`redirect:${path}?workforceEdit=saved`);
  expect(vi.mocked(maintainWorkforceRecord).mock.calls[0][1]).toMatchObject({rowId:null,expectedVersion:null,patch:{qualification:'Master',isHighest:true}});
  f.set('rowId',row);await expect(saveWorkforceRecordAction(f)).rejects.toThrow(`redirect:${path}?workforceEdit=invalid`);
 });
 it('retains a never-decided Family claim rather than coercing it into an explicit refusal',async()=>{
  const f=new FormData();Object.entries({employmentId:id,kind:'dependent',operation:'add'}).forEach(([k,v])=>f.set(k,v));
  for(const {key,field}of workforceMaintenanceFields('dependent'))f.set(key,field.type==='boolean'&&!['spouseWorking','isStudent','childTaxRelief'].includes(key)?'false':'');
  f.set('fullName','Fictional child');f.set('relationship','child');f.set('taxNumber','not accepted');
  await expect(saveWorkforceRecordAction(f)).rejects.toThrow(`redirect:${path}?workforceEdit=saved`);
  const command=vi.mocked(maintainWorkforceRecord).mock.calls[0][1];
  expect(command.patch).toMatchObject({childTaxRelief:null,isStudent:null,spouseWorking:null,isBeneficiary:false,isDeceased:false});
  expect(command.patch).not.toHaveProperty('taxNumber');
 });
 it('keeps the generic Family notice in the redirect without serializing financial details',async()=>{
  vi.mocked(maintainWorkforceRecord).mockResolvedValue({id,changed:true,hrReviewNotice:true});
  await expect(saveWorkforceRecordAction(form())).rejects.toThrow(`redirect:${path}?workforceEdit=review`);
 });
 it.each([[new WorkforceAccessError(),'denied'],[new WorkforceRecordChangedError(),'changed'],[new WorkforceMaintenanceValidationError(),'invalid'],[new WorkforceMaintenanceUnavailableError(),'unavailable']] as const)('keeps failures finite for %s',async(error,outcome)=>{
  vi.mocked(maintainWorkforceRecord).mockRejectedValue(error);await expect(saveWorkforceRecordAction(form())).rejects.toThrow(`redirect:${path}?workforceEdit=${outcome}`);
 });
 it('preserves infrastructure/audit failures rather than mislabelling them as invalid input',async()=>{
  const error=new Error('Fictional audit store unavailable');vi.mocked(maintainWorkforceRecord).mockRejectedValue(error);
  await expect(saveWorkforceRecordAction(form())).rejects.toBe(error);
 });
});
