import {beforeEach,describe,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({guard:vi.fn(),create:vi.fn(),resume:vi.fn(),cancel:vi.fn(),revalidate:vi.fn()}));
vi.mock('../lib/identity/manual-admin',()=>({requireManualIdentityAdmin:m.guard}));
vi.mock('../core/manual-identity',()=>({createManualAccount:m.create,resumeManualAccount:m.resume,cancelManualAccount:m.cancel}));
vi.mock('next/cache',()=>({revalidatePath:m.revalidate}));
vi.mock('next/navigation',()=>({redirect:(path:string)=>{throw new Error('REDIRECT '+path);}}));
import {createManualAccountAction,resumeManualAccountAction,cancelManualAccountAction} from '../app/admin/users/manual-actions';
const ctx={tenantId:'server-tenant',userId:'server-user'};
beforeEach(()=>{vi.clearAllMocks();m.guard.mockResolvedValue(ctx);m.create.mockResolvedValue('new-user');m.resume.mockResolvedValue('user');m.cancel.mockResolvedValue(undefined);});
describe('manual identity server-action authority and secret handling',()=>{
 it.each([createManualAccountAction,resumeManualAccountAction,cancelManualAccountAction])('authenticates before any mutation',async action=>{
  m.guard.mockRejectedValue(new Error('denied'));await expect(action(new FormData())).rejects.toThrow('denied');expect(m.create).not.toHaveBeenCalled();expect(m.resume).not.toHaveBeenCalled();expect(m.cancel).not.toHaveBeenCalled();
 });
 it('uses the server principal and explicit attestation value, never reflecting the submitted password',async()=>{
  const form=new FormData();Object.entries({id:'request',personId:'person',username:'typed.username',email:'mail@example.test',role:'employee',companyId:'',password:'Private-password-12345',ownershipAttested:'false',userId:'attacker'}).forEach(([k,v])=>form.set(k,v));
  await expect(createManualAccountAction(form)).rejects.toThrow('REDIRECT /admin/users/create?manualSuccess=created');
  expect(m.create).toHaveBeenCalledWith(ctx,expect.objectContaining({ownershipAttested:false,username:'typed.username',password:'Private-password-12345'}));
  expect(m.revalidate.mock.calls).toEqual([['/admin/users'],['/admin/users/create']]);
  m.create.mockRejectedValue(new Error('Private-password-12345 provider detail'));
  await expect(createManualAccountAction(form)).rejects.toThrow('REDIRECT /admin/users/create?manualError=unavailable');
 });
 it('uses only an explicit standalone choice for new-person creation and maps group scope to null',async()=>{
  const form=new FormData();Object.entries({id:'request',accountType:'standalone',personId:'ignored-forged-person',fullName:'External user',username:'external',email:'external@example.test',role:'hr_admin',companyId:'group',password:'Private-password-12345',ownershipAttested:'true'}).forEach(([k,v])=>form.set(k,v));
  await expect(createManualAccountAction(form)).rejects.toThrow('REDIRECT /admin/users/create?manualSuccess=created');
  expect(m.create).toHaveBeenCalledWith(ctx,expect.objectContaining({personId:null,fullName:'External user',role:'hr_admin',companyId:null}));
  form.delete('accountType');form.delete('personId');
  await expect(createManualAccountAction(form)).rejects.toThrow('REDIRECT /admin/users/create?manualSuccess=created');
  expect(m.create).toHaveBeenLastCalledWith(ctx,expect.objectContaining({personId:''}));
 });

});
