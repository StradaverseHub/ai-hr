import {beforeEach,expect,it,vi} from 'vitest';
import {GET} from '../app/lifecycle/contracts/letters/[letterId]/pdf/route';
import {automationDocument} from '../lib/automation-document';
const commands=vi.hoisted(()=>({session:vi.fn(),letter:vi.fn(),render:vi.fn(),form:vi.fn(),pdf:vi.fn(),proof:vi.fn()}));
vi.mock('../lib/scoped-lifecycle-page',()=>({requireScopedLifecycleModule:commands.session}));
vi.mock('../packs/contracts/service',()=>({readContractSharedLetter:commands.letter,renderContractSharedLetter:commands.render,readContractSharedForm:commands.form,readContractSharedReleaseProof:commands.proof}));
vi.mock('../lib/lifecycle-v9-pdf',()=>({renderV9DocumentPdf:commands.pdf}));
const id='11111111-1111-4111-8111-111111111111',hash='a'.repeat(64);
const document=automationDocument({id,name:'Fictional Form',templateId:'template',templateVersion:1,blocks:[],fields:[],merge:{},createdAt:'2026-11-17T00:00:00Z'});
beforeEach(()=>{vi.clearAllMocks();commands.session.mockResolvedValue({tenantId:'tenant',userId:'actual-assigned-user'});commands.letter.mockResolvedValue({id,contentHash:hash,history:[],body:{receipts:[]}});commands.proof.mockResolvedValue(null);commands.render.mockReturnValue({...document,values:{answer:'OLD ANSWER',unselected:'MUST NOT LEAK'}});commands.form.mockResolvedValue({letterId:id,kind:'Form',visible:true,legalBaseHash:hash,values:{answer:'Saved native answer'}});commands.pdf.mockResolvedValue({bytes:new Uint8Array([37,80,68,70])});});
it('prints only the authorized saved native Form answers for the exact displayed legal version',async()=>{
 const result=await GET(new Request('https://example.test'),{params:Promise.resolve({letterId:id})});
 expect(result.status).toBe(200);expect(result.headers.get('cache-control')).toBe('private, no-store');expect(commands.pdf).toHaveBeenCalledWith(expect.objectContaining({values:{answer:'Saved native answer'}}),expect.stringContaining(hash),false,[]);
});
it.each([{letterId:id,kind:'Form',visible:false},{letterId:id,kind:'Form',visible:true,legalBaseHash:'b'.repeat(64),values:{answer:'Saved native answer'}}])('refuses a hidden or mismatched Form proof instead of producing a mixed-version PDF',async form=>{
 commands.form.mockResolvedValue(form);const result=await GET(new Request('https://example.test'),{params:Promise.resolve({letterId:id})});expect(result.status).toBe(404);expect(commands.pdf).not.toHaveBeenCalled();
});
