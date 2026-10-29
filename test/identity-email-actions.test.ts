import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({guard:vi.fn(),ipc:vi.fn(),revalidate:vi.fn(),retention:vi.fn()}));
vi.mock('../core/account-email-retention',()=>({saveAccountEmailRetention:mocks.retention}));
vi.mock('../lib/identity/email-settings',()=>({requireIdentityEmailAdmin:mocks.guard}));
vi.mock('../lib/identity/email-ipc',()=>({identityEmailRequest:mocks.ipc}));
vi.mock('next/cache',()=>({revalidatePath:mocks.revalidate}));
vi.mock('next/navigation',()=>({redirect:(path:string)=>{throw new Error('REDIRECT '+path);}}));
import {saveEmailDraft,testEmailDraft,activateEmailDraft,saveEmailRetention} from '../app/admin/settings/email/actions';
const actor={issuer:'https://hr.test',subject:'server-derived',userId:'22222222-2222-4222-8222-222222222222',tenantId:'11111111-1111-4111-8111-111111111111'};
beforeEach(()=>{vi.clearAllMocks();mocks.guard.mockResolvedValue({actor,session:{tenantId:actor.tenantId,userId:actor.userId}});mocks.ipc.mockResolvedValue({});mocks.retention.mockResolvedValue(undefined);});
afterEach(()=>vi.unstubAllEnvs());
describe('SMTP server action authentication boundary',()=>{
 it.each([saveEmailDraft,testEmailDraft,activateEmailDraft,saveEmailRetention])('checks identity authority before any IPC operation',async action=>{
  mocks.guard.mockRejectedValue(new Error('denied'));await expect(action(new FormData())).rejects.toThrow('denied');expect(mocks.ipc).not.toHaveBeenCalled();
 });
 it('saves retention only with the server identity and reports a fixed error on failure',async()=>{
  const form=new FormData();for(const[k,v]of Object.entries({retentionMode:'days',retentionDays:'90',retentionRevision:'4',retentionAcknowledged:'true',subject:'attacker'}))form.set(k,v);
  await expect(saveEmailRetention(form)).rejects.toThrow('retentionSaved=1');
  expect(mocks.retention).toHaveBeenCalledWith({tenantId:actor.tenantId,userId:actor.userId},actor,{days:90,revision:4,acknowledged:true});
  mocks.retention.mockRejectedValue(Error('private-database-error'));await expect(saveEmailRetention(form)).rejects.toThrow('retentionError=1');
  mocks.retention.mockClear();form.set('retentionMode','unexpected');await expect(saveEmailRetention(form)).rejects.toThrow('retentionError=1');expect(mocks.retention).not.toHaveBeenCalled();
 });
 it('derives identity on the server and reads the explicit authentication value',async()=>{
  const form=new FormData();for(const [k,v]of Object.entries({revision:'a'.repeat(64),host:'smtp.test',port:'465',from:'sender@test.example',fromName:'HR',replyTo:'',auth:'false',user:'',password:'',subject:'attacker'}))form.set(k,v);
  await expect(saveEmailDraft(form)).rejects.toThrow('success=save');expect(mocks.ipc).toHaveBeenCalledWith({op:'save',actor,revision:'a'.repeat(64),config:{host:'smtp.test',port:465,security:'tls',from:'sender@test.example',fromName:'HR',replyTo:'',auth:false,user:''},password:''});
 });
 it('does not reflect a credential-bearing provider error into the redirect',async()=>{
  mocks.ipc.mockRejectedValue(new Error('AUTH very-secret'));const form=new FormData();form.set('draftId',crypto.randomUUID());
  await expect(testEmailDraft(form)).rejects.toThrow('error=unavailable');
 });
 it('saves application identity and required STARTTLS through the canonical owner action',async()=>{
  vi.stubEnv('AUTH_PROVIDER','internal');const tenantId=crypto.randomUUID(),clientId=crypto.randomUUID(),form=new FormData();
  for(const [key,value] of Object.entries({revision:'initial',host:'smtp.office365.com',port:'587',security:'starttls',auth:'microsoft365',tenantId,clientId,user:'sender@example.test',from:'sender@example.test',fromName:'HR',replyTo:'',password:'fictional-secret'}))form.set(key,value);
  await expect(saveEmailDraft(form)).rejects.toThrow('success=save');expect(mocks.ipc).toHaveBeenCalledWith({op:'save',actor,revision:'initial',password:'fictional-secret',config:{host:'smtp.office365.com',port:587,security:'starttls',auth:true,authentication:'microsoft365',oauth2:{tenantId,clientId},user:'sender@example.test',from:'sender@example.test',fromName:'HR',replyTo:''}});
  mocks.ipc.mockClear();form.set('security','tls');await expect(saveEmailDraft(form)).rejects.toThrow('error=invalid');expect(mocks.ipc).not.toHaveBeenCalled();
  form.set('security','starttls');vi.stubEnv('AUTH_PROVIDER','keycloak');await expect(saveEmailDraft(form)).rejects.toThrow('error=invalid');expect(mocks.ipc).not.toHaveBeenCalled();
 });
});

it('applies a lifecycle sender only through an internal named connection and the server actor',async()=>{
 vi.stubEnv('AUTH_PROVIDER','internal');const form=new FormData();form.set('draftId','actual-version');form.set('connectionId','actual-connection');form.set('received','true');form.set('lifecycleSender','hr');form.set('tenantId','attacker');
 await expect(activateEmailDraft(form)).rejects.toThrow('success=sender');expect(mocks.ipc).toHaveBeenCalledWith({op:'apply',actor,draftId:'actual-version',connectionId:'actual-connection',received:true,lifecycleSender:'hr'});
 for(const profile of ['__proto__','unknown']){mocks.ipc.mockClear();form.set('lifecycleSender',profile);await expect(activateEmailDraft(form)).rejects.toThrow('error=invalid');expect(mocks.ipc).not.toHaveBeenCalled();}
 form.set('lifecycleSender','hr');form.delete('connectionId');await expect(activateEmailDraft(form)).rejects.toThrow('error=invalid');
 form.set('connectionId','actual-connection');vi.stubEnv('AUTH_PROVIDER','keycloak');await expect(activateEmailDraft(form)).rejects.toThrow('error=invalid');
});
