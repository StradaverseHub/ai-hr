import {beforeEach,describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({guard:vi.fn(),ipc:vi.fn(),revalidate:vi.fn()}));
vi.mock('../lib/identity/email-settings',()=>({requireIdentityEmailAdmin:mocks.guard}));
vi.mock('../lib/identity/email-ipc',()=>({identityEmailRequest:mocks.ipc}));
vi.mock('next/cache',()=>({revalidatePath:mocks.revalidate}));
vi.mock('next/navigation',()=>({redirect:(path:string)=>{throw new Error('REDIRECT '+path);}}));
import {saveEmailDraft,testEmailDraft,activateEmailDraft} from '../app/admin/settings/email/actions';
const actor={issuer:'https://hr.test',subject:'server-derived',userId:'22222222-2222-4222-8222-222222222222',tenantId:'11111111-1111-4111-8111-111111111111'};
beforeEach(()=>{vi.clearAllMocks();mocks.guard.mockResolvedValue({actor});mocks.ipc.mockResolvedValue({});});
describe('SMTP server action authentication boundary',()=>{
 it.each([saveEmailDraft,testEmailDraft,activateEmailDraft])('checks identity authority before any IPC operation',async action=>{
  mocks.guard.mockRejectedValue(new Error('denied'));await expect(action(new FormData())).rejects.toThrow('denied');expect(mocks.ipc).not.toHaveBeenCalled();
 });
 it('derives identity on the server and reads the explicit authentication value',async()=>{
  const form=new FormData();for(const [k,v]of Object.entries({revision:'a'.repeat(64),host:'smtp.test',port:'465',from:'sender@test.example',fromName:'HR',replyTo:'',auth:'false',user:'',password:'',subject:'attacker'}))form.set(k,v);
  await expect(saveEmailDraft(form)).rejects.toThrow('success=save');expect(mocks.ipc).toHaveBeenCalledWith({op:'save',actor,revision:'a'.repeat(64),config:{host:'smtp.test',port:465,security:'tls',from:'sender@test.example',fromName:'HR',replyTo:'',auth:false,user:''},password:''});
 });
 it('does not reflect a credential-bearing provider error into the redirect',async()=>{
  mocks.ipc.mockRejectedValue(new Error('AUTH very-secret'));const form=new FormData();form.set('draftId',crypto.randomUUID());
  await expect(testEmailDraft(form)).rejects.toThrow('error=unavailable');
 });
});
