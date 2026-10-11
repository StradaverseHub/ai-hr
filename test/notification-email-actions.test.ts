import { beforeEach,describe,expect,it,vi } from 'vitest';
const m=vi.hoisted(()=>({session:vi.fn(),identity:vi.fn(),internal:vi.fn(),policy:vi.fn(),preferences:vi.fn(),retry:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:m.session}));
vi.mock('../lib/identity/session',()=>({currentIdentitySession:m.identity}));
vi.mock('../lib/identity/config',()=>({keycloakSelected:m.internal}));
vi.mock('../core/notification-email',()=>({saveNotificationEmailPolicy:m.policy,saveNotificationEmailPreferences:m.preferences,retryNotificationEmail:m.retry}));
vi.mock('next/cache',()=>({revalidatePath:vi.fn()}));vi.mock('next/navigation',()=>({redirect:(p:string)=>{throw new Error('REDIRECT '+p);}}));
import { saveWorkflowEmailPolicy,retryWorkflowEmail } from '../app/admin/settings/notifications/actions';
import { saveMyWorkflowEmailPreferences } from '../app/me/notifications/actions';
const session={tenantId:'tenant',userId:'server-user'},identity={issuer:'https://hr.test',subject:'server-subject',email:'verified@example.test',emailVerified:true};
beforeEach(()=>{vi.clearAllMocks();m.session.mockResolvedValue(session);m.identity.mockResolvedValue(identity);m.internal.mockReturnValue(true);m.policy.mockResolvedValue(undefined);m.preferences.mockResolvedValue(undefined);m.retry.mockResolvedValue(undefined);});
describe('workflow email server action identity boundaries',()=>{
 it.each([saveWorkflowEmailPolicy,saveMyWorkflowEmailPreferences,retryWorkflowEmail])('requires a current session before any mutation',async action=>{
  m.session.mockRejectedValue(new Error('sign in required'));await expect(action(new FormData())).rejects.toThrow('sign in required');expect(m.policy).not.toHaveBeenCalled();expect(m.preferences).not.toHaveBeenCalled();expect(m.retry).not.toHaveBeenCalled();
 });
 it('takes consent identity from the server, never from a form claim',async()=>{
  const f=new FormData();for(const [k,v]of Object.entries({employmentId:'target',locale:'ms',issuer:'https://evil.test',subject:'attacker',email:'attacker@example.test',emailVerified:'true'}))f.set(k,v);f.append('category','leave');
  await expect(saveMyWorkflowEmailPreferences(f)).rejects.toThrow('saved=1');expect(m.preferences).toHaveBeenCalledWith(session,'target',['leave'],'ms',identity);
 });
 it('does not use an internal identity cookie to give a demo or legacy session external-mail consent',async()=>{
  m.internal.mockReturnValue(false);const f=new FormData();f.set('locale','en');f.set('employmentId','target');f.append('category','leave');
  await expect(saveMyWorkflowEmailPreferences(f)).rejects.toThrow('saved=1');expect(m.identity).not.toHaveBeenCalled();expect(m.preferences).toHaveBeenCalledWith(session,'target',['leave'],'en',null);
 });
 it('does not accept retry acknowledgement by checkbox presence',async()=>{
  const f=new FormData();f.set('deliveryId','delivery');f.set('acknowledged','false');await expect(retryWorkflowEmail(f)).rejects.toThrow('saved=1');expect(m.retry).toHaveBeenCalledWith(session,'delivery',false);
 });
 it('does not reflect sensitive provider or database errors into a URL',async()=>{
  m.policy.mockRejectedValue(new Error('smtp secret and employee address'));await expect(saveWorkflowEmailPolicy(new FormData())).rejects.toThrow('error=save');
 });
});
