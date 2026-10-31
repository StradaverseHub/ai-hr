import { beforeEach,describe,expect,it,vi } from 'vitest';
const m=vi.hoisted(()=>({session:vi.fn(),identity:vi.fn(),internalIdentity:vi.fn(),workosIdentity:vi.fn(),internal:vi.fn(),keycloak:vi.fn(),policy:vi.fn(),preferences:vi.fn(),retry:vi.fn(),accountRetry:vi.fn(),emailAdmin:vi.fn()}));
vi.mock('../core/letter-email-preferences',()=>({saveLetterEmailPreferences:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:m.session}));
vi.mock('../lib/identity/session',()=>({currentIdentitySession:m.identity}));
vi.mock('../lib/identity/config',()=>({keycloakSelected:m.keycloak}));
vi.mock('../lib/internal-auth/config',()=>({internalSelected:m.internal}));
vi.mock('../lib/internal-auth/web-session',()=>({currentInternalIdentity:m.internalIdentity}));
vi.mock('../lib/workos',()=>({currentWorkosSession:m.workosIdentity}));
vi.mock('../lib/identity/email-ipc',()=>({identityEmailRequest:vi.fn()}));
vi.mock('../core/notification-email',()=>({saveNotificationEmailPolicy:m.policy,saveNotificationEmailPreferences:m.preferences,retryNotificationEmail:m.retry}));
vi.mock('../core/auth',()=>({retryAccountEmail:m.accountRetry}));
vi.mock('../lib/identity/email-settings',()=>({requireIdentityEmailAdmin:m.emailAdmin}));
vi.mock('next/cache',()=>({revalidatePath:vi.fn()}));vi.mock('next/navigation',()=>({redirect:(p:string)=>{throw new Error('REDIRECT '+p);}}));
import { saveWorkflowEmailPolicy,retryWorkflowEmail,retryAccountEmailAction } from '../app/(app)/admin/settings/notifications/actions';
import { saveMyWorkflowEmailPreferences } from '../app/(app)/me/notifications/actions';
const session={tenantId:'tenant',userId:'server-user'},identity={issuer:'https://hr.test',subject:'server-subject',email:'verified@example.test',emailVerified:true};
beforeEach(()=>{vi.clearAllMocks();m.session.mockResolvedValue(session);m.identity.mockResolvedValue(identity);m.internalIdentity.mockResolvedValue({...identity,issuer:'https://hr.test/auth/tenant',subject:'internal-subject'});m.workosIdentity.mockResolvedValue(null);m.internal.mockReturnValue(false);m.keycloak.mockReturnValue(true);m.policy.mockResolvedValue(undefined);m.preferences.mockResolvedValue(undefined);m.retry.mockResolvedValue(undefined);m.accountRetry.mockResolvedValue(undefined);m.emailAdmin.mockResolvedValue({session,actor:{...identity,...session}});});
describe('workflow email server action identity boundaries',()=>{
 it.each([saveWorkflowEmailPolicy,saveMyWorkflowEmailPreferences,retryWorkflowEmail])('requires a current session before any mutation',async action=>{
  m.session.mockRejectedValue(new Error('sign in required'));await expect(action(new FormData())).rejects.toThrow('sign in required');expect(m.policy).not.toHaveBeenCalled();expect(m.preferences).not.toHaveBeenCalled();expect(m.retry).not.toHaveBeenCalled();expect(m.internalIdentity).not.toHaveBeenCalled();expect(m.identity).not.toHaveBeenCalled();expect(m.workosIdentity).not.toHaveBeenCalled();
 });
 it('takes consent identity from the server, never from a form claim',async()=>{
  const f=new FormData();for(const [k,v]of Object.entries({employmentId:'target',locale:'ms',issuer:'https://evil.test',subject:'attacker',email:'attacker@example.test',emailVerified:'true'}))f.set(k,v);f.append('category','leave');
  await expect(saveMyWorkflowEmailPreferences(f)).rejects.toThrow('saved=1');expect(m.identity).toHaveBeenCalledOnce();expect(m.internalIdentity).not.toHaveBeenCalled();expect(m.preferences).toHaveBeenCalledWith(session,'target',['leave'],'ms',identity);
 });
 it('uses the selected internal provider and preserves its exact tenant issuer and subject',async()=>{
  m.internal.mockReturnValue(true);const f=new FormData();f.set('locale','en');f.set('employmentId','target');f.append('category','leave');f.set('issuer','https://evil.test');f.set('subject','attacker');f.set('emailVerified','true');
  await expect(saveMyWorkflowEmailPreferences(f)).rejects.toThrow('saved=1');expect(m.internalIdentity).toHaveBeenCalledOnce();expect(m.identity).not.toHaveBeenCalled();expect(m.workosIdentity).not.toHaveBeenCalled();
  expect(m.preferences).toHaveBeenCalledWith(session,'target',['leave'],'en',{...identity,issuer:'https://hr.test/auth/tenant',subject:'internal-subject'});
 });
 it('does not give a legacy WorkOS session an issuer or verified-mail claim',async()=>{
  m.keycloak.mockReturnValue(false);m.workosIdentity.mockResolvedValue({subject:'legacy-subject',email:'legacy@example.test'});
  const f=new FormData();f.set('locale','en');f.set('employmentId','target');f.append('category','leave');
  await expect(saveMyWorkflowEmailPreferences(f)).rejects.toThrow('saved=1');expect(m.workosIdentity).toHaveBeenCalledOnce();expect(m.internalIdentity).not.toHaveBeenCalled();expect(m.identity).not.toHaveBeenCalled();expect(m.preferences).toHaveBeenCalledWith(session,'target',['leave'],'en',null);
 });
 it.each([
  ['missing provider session',null],
  ['unverified internal email',{...identity,emailVerified:false}],
  ['nonboolean verification claim',{...identity,emailVerified:'true'}],
  ['missing issuer',{...identity,issuer:undefined}],
  ['empty issuer',{...identity,issuer:''}],
  ['empty subject',{...identity,subject:''}],
 ])('passes no consent identity for %s, never a form replacement',async(_label,provider)=>{
  m.internal.mockReturnValue(true);m.internalIdentity.mockResolvedValue(provider);
  const f=new FormData();for(const [key,value]of Object.entries({locale:'en',employmentId:'target',issuer:identity.issuer,subject:identity.subject,email:identity.email,emailVerified:'true'}))f.set(key,value);f.append('category','leave');
  await expect(saveMyWorkflowEmailPreferences(f)).rejects.toThrow('saved=1');expect(m.preferences).toHaveBeenCalledWith(session,'target',['leave'],'en',null);
 });
 it('allows the canonical owner to withdraw consent when provider proof is unavailable',async()=>{
  m.internal.mockReturnValue(true);m.internalIdentity.mockRejectedValue(Error('provider unavailable'));
  const f=new FormData();f.set('locale','en');f.set('employmentId','target');
  await expect(saveMyWorkflowEmailPreferences(f)).rejects.toThrow('saved=1');expect(m.preferences).toHaveBeenCalledWith(session,'target',[],'en',null);
 });
 it('preserves canonical consent-owner refusal without reflecting identity or private binding errors',async()=>{
  m.internal.mockReturnValue(true);m.preferences.mockRejectedValue(Error('private employment binding and sequence'));
  const f=new FormData();f.set('locale','en');f.set('employmentId','another-employment');f.append('category','leave');
  await expect(saveMyWorkflowEmailPreferences(f)).rejects.toThrow('REDIRECT /me/notifications?error=save');expect(m.preferences).toHaveBeenCalledOnce();
 });
 it('does not accept retry acknowledgement by checkbox presence',async()=>{
  const f=new FormData();f.set('deliveryId','delivery');f.set('acknowledged','false');await expect(retryWorkflowEmail(f)).rejects.toThrow('saved=1');expect(m.retry).toHaveBeenCalledWith(session,'delivery',false);
 });
 it('does not reflect sensitive provider or database errors into a URL',async()=>{
  m.policy.mockRejectedValue(new Error('smtp secret and employee address'));await expect(saveWorkflowEmailPolicy(new FormData())).rejects.toThrow('error=save');
 });
});

describe('account email retry server action boundaries',()=>{
 it('requires a server session for invitation retry before mutation',async()=>{
  m.session.mockRejectedValue(Error('sign in required'));
  await expect(retryAccountEmailAction(new FormData())).rejects.toThrow('sign in required');expect(m.accountRetry).not.toHaveBeenCalled();
 });
 it('requires the installation email guard for recovery and never trusts form actor claims',async()=>{
  const f=new FormData();for(const [k,v] of Object.entries({returnTo:'/admin/settings/email',kind:'recovery',deliveryId:'delivery',acknowledged:'true',issuer:'evil',subject:'attacker',userId:'attacker'}))f.set(k,v);
  await expect(retryAccountEmailAction(f)).rejects.toThrow('accountRetry=1');
  expect(m.accountRetry).toHaveBeenCalledWith(session,'delivery',true,{...identity,...session});
  m.emailAdmin.mockRejectedValue(Error('owner required'));m.accountRetry.mockClear();
  await expect(retryAccountEmailAction(f)).rejects.toThrow('owner required');expect(m.accountRetry).not.toHaveBeenCalled();
 });
 it('whitelists the return path and does not accept checkbox presence as acknowledgement',async()=>{
  const f=new FormData();f.set('returnTo','https://evil.test');f.set('deliveryId','delivery');f.set('acknowledged','false');
  await expect(retryAccountEmailAction(f)).rejects.toThrow('REDIRECT /admin/settings/notifications?accountRetry=1');
  expect(m.emailAdmin).not.toHaveBeenCalled();expect(m.accountRetry).toHaveBeenCalledWith(session,'delivery',false,undefined);
 });
 it('lets an HR invitation retry return to Email delivery without requiring the paid notifications module or installation role',async()=>{
  const f=new FormData();f.set('returnTo','/admin/settings/email');f.set('kind','invitation');f.set('deliveryId','delivery');f.set('acknowledged','true');
  await expect(retryAccountEmailAction(f)).rejects.toThrow('REDIRECT /admin/settings/email?accountRetry=1');
  expect(m.emailAdmin).not.toHaveBeenCalled();expect(m.accountRetry).toHaveBeenCalledWith(session,'delivery',true,undefined);
 });
 it('keeps secret provider errors out of redirects' ,async()=>{
  m.accountRetry.mockRejectedValue(Error('secret reset link'));await expect(retryAccountEmailAction(new FormData())).rejects.toThrow('REDIRECT /admin/settings/notifications?error=account-retry');
 });
});
