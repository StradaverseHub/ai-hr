/** Endpoint binding only. Real permission, SQL, race and audit outcomes live in workforce-access. */
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {revalidatePath} from 'next/cache';
import {requireWorkforceAccess} from '../lib/workforce-authz';
import {setWorkforceEmployeeCode,WorkforceCodeValidationError,WorkforceRecordChangedError} from '../core/workforce-code';
import {WorkforceAccessError} from '../core/workforce-access';
import {saveWorkforceCodeAction} from '../app/(app)/admin/personnel/[employmentId]/workforce-record-actions';
vi.mock('next/navigation',()=>({redirect:(url:string)=>{throw new Error(`redirect:${url}`);}}));
vi.mock('next/cache',()=>({revalidatePath:vi.fn()}));
vi.mock('../lib/workforce-authz',()=>({requireWorkforceAccess:vi.fn()}));
vi.mock('../core/workforce-code',async original=>({...await original<typeof import('../core/workforce-code')>(),setWorkforceEmployeeCode:vi.fn()}));
vi.mock('../core/workforce-maintenance',()=>({maintainWorkforceRecord:vi.fn(),WorkforceMaintenanceValidationError:class extends Error{},WorkforceMaintenanceUnavailableError:class extends Error{}}));
const id='11111111-1111-4111-8111-111111111111',actor='22222222-2222-4222-8222-222222222222';
const ctx={tenantId:id,userId:actor,roles:['employee'],grants:[{role:'employee',companyId:null}]};
const path=`/admin/personnel/${id}`;
function form(){const data=new FormData();data.set('employmentId',id);data.set('employeeCode','wf-command');data.set('expectedCode',JSON.stringify('WF-BEFORE'));return data;}
beforeEach(()=>{
 vi.clearAllMocks();vi.mocked(requireWorkforceAccess).mockResolvedValue({s:ctx,scopeIds:[id],allowedCount:1,companyIds:[id]});
 vi.mocked(setWorkforceEmployeeCode).mockReset().mockResolvedValue({id,changed:true});
});
describe('fixed Workforce identifier endpoint',()=>{
 it('uses the real session, ignores posted authority and keeps success in the redirect',async()=>{
  const data=form();data.set('userId','forged');data.set('companyId','forged');data.set('canMaintain','true');data.set('role','hr_admin');
  await expect(saveWorkforceCodeAction(data)).rejects.toThrow(`redirect:${path}?workforceCode=saved`);
  expect(setWorkforceEmployeeCode).toHaveBeenCalledExactlyOnceWith(ctx,{employmentId:id,employeeCode:'wf-command',expectedCode:'WF-BEFORE'});
  expect(revalidatePath).toHaveBeenCalledExactlyOnceWith(path);
 });
 it.each([[new WorkforceAccessError(),'denied'],[new WorkforceRecordChangedError(),'changed'],[new WorkforceCodeValidationError('Private duplicate details'),'invalid']] as const)('returns finite feedback for %s',async(error,outcome)=>{
  vi.mocked(setWorkforceEmployeeCode).mockRejectedValue(error);
  await expect(saveWorkforceCodeAction(form())).rejects.toThrow(`redirect:${path}?workforceCode=${outcome}`);
 });
 it('requires a nullable-string baseline and a valid subject URL before invoking a command',async()=>{
  const data=form();data.set('expectedCode','{"role":"hr_admin"}');
  await expect(saveWorkforceCodeAction(data)).rejects.toThrow(`redirect:${path}?workforceCode=invalid`);
  expect(setWorkforceEmployeeCode).not.toHaveBeenCalled();
  data.set('employmentId','../../other');await expect(saveWorkforceCodeAction(data)).rejects.toThrow('redirect:/admin/personnel');
  expect(setWorkforceEmployeeCode).not.toHaveBeenCalled();
 });
 it('preserves a real system failure instead of presenting it as invalid employee input',async()=>{
  const failure=new Error('Fictional unavailable command connection');vi.mocked(setWorkforceEmployeeCode).mockRejectedValue(failure);
  await expect(saveWorkforceCodeAction(form())).rejects.toBe(failure);expect(revalidatePath).not.toHaveBeenCalled();
 });
});
