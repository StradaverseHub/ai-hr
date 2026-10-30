import {beforeEach,describe,it,expect,vi} from 'vitest';
const m=vi.hoisted(()=>({session:vi.fn(),invite:vi.fn(),revalidate:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:m.session}));
vi.mock('../core/auth',()=>({inviteUser:m.invite,revokeInvitation:vi.fn(),setAppUserArchived:vi.fn()}));
vi.mock('next/cache',()=>({revalidatePath:m.revalidate}));
vi.mock('next/navigation',()=>({redirect:(path:string)=>{throw new Error('REDIRECT '+path);}}));
import {inviteUserAction} from '../app/admin/actions';
const principal={tenantId:'fixture-tenant',userId:'server-actor'};
function form(){const value=new FormData();Object.entries({accountType:'existing',personId:'fixture-person',email:'fixture@example.test',emailLocale:'ms',role:'employee',companyId:'group',returnTo:'https://foreign.test',userId:'forged'}).forEach(([key,text])=>value.set(key,text));return value;}
beforeEach(()=>{vi.clearAllMocks();m.session.mockResolvedValue(principal);m.invite.mockResolvedValue(undefined);});
describe('invitation results stay on their owning page',()=>{
 it('uses the server actor and returns success to the fixed invitation page',async()=>{
  await expect(inviteUserAction(form())).rejects.toThrow('REDIRECT /admin/users/invite?saved=1');
  expect(m.invite).toHaveBeenCalledWith(principal,{email:'fixture@example.test',emailLocale:'ms',role:'employee',companyId:null,personId:'fixture-person'});
  expect(m.revalidate.mock.calls).toEqual([['/admin/users'],['/admin/users/invite']]);
 });
 it('retains refusal and never revalidates or claims success after a failed invitation',async()=>{
  m.invite.mockRejectedValue(new Error('Invitation refused'));await expect(inviteUserAction(form())).rejects.toThrow('REDIRECT /admin/users/invite?error=');expect(m.revalidate).not.toHaveBeenCalled();
 });
 it('refuses malformed targets before calling the invitation owner',async()=>{
  const value=form();value.delete('personId');await expect(inviteUserAction(value)).rejects.toThrow('REDIRECT /admin/users/invite?error=');expect(m.invite).not.toHaveBeenCalled();
  m.session.mockRejectedValue(new Error('authentication'));await expect(inviteUserAction(form())).rejects.toThrow('authentication');expect(m.invite).not.toHaveBeenCalled();
 });
});
