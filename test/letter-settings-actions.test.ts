import {beforeEach,it,expect,vi} from 'vitest';
import {LetterWorkflowError} from '../lib/letter-workflow';
const mocks=vi.hoisted(()=>({session:vi.fn(),save:vi.fn(),asset:vi.fn(),revalidate:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:mocks.session}));
vi.mock('../core/letters',()=>({saveLetterPolicy:mocks.save,addLetterAsset:mocks.asset}));
vi.mock('next/cache',()=>({revalidatePath:mocks.revalidate}));
vi.mock('next/navigation',()=>({redirect:(url:string)=>{throw new Error('REDIRECT:'+url);}}));
import {savePolicySettings,uploadLetterAsset} from '../app/(app)/letters/settings/actions';
const companyId='00000000-0000-4000-8000-000000000001',signerId='00000000-0000-4000-8000-000000000002',ctx={tenantId:'fixture',userId:'actual-user'};
function form(){const data=new FormData();for(const [key,value]of Object.entries({companyId,category:'confirmation',expectedOrdinal:'4',signatoryUserId:signerId,signingMode:'authenticated',referenceFormat:'HR/{YYYY}/{SEQ:6}',retentionDays:'365',sensitiveLinkMinutes:'15',acknowledgement:'acknowledge',approvalDueHours:'48',acknowledgementDueDays:'7',reminderHours:'24',enabled:'yes',stages:JSON.stringify([{key:'signatory',label:'Authorised signatory',userIds:[signerId],allowDelegation:false}])}))data.set(key,value);return data;}
beforeEach(()=>{vi.clearAllMocks();mocks.session.mockResolvedValue(ctx);mocks.save.mockResolvedValue({ordinal:5});mocks.asset.mockResolvedValue({id:signerId});});
it('preserves the displayed configuration witness and leaves fresh authority to the owner',async()=>{
 const data=form();data.set('smtpHost','FORGED SMTP');data.set('emailAddress','FORGED RECIPIENT');mocks.save.mockRejectedValue(new LetterWorkflowError('stale','policyVersion'));expect(await savePolicySettings(null,data)).toEqual({error:'stale',detail:'policyVersion'});expect(mocks.save.mock.calls[0][1]).toMatchObject({companyId,category:'confirmation',expectedOrdinal:4,enabled:true,policy:{signatoryUserId:signerId,portalNotifications:false,emailNotifications:false}});expect(mocks.save.mock.calls[0][1].policy).not.toHaveProperty('smtpHost');expect(mocks.save.mock.calls[0][1].policy).not.toHaveProperty('emailAddress');expect(mocks.revalidate).not.toHaveBeenCalled();
});
it('rejects malformed stages and a delegated final signatory before calling an owner',async()=>{
 for(const stages of ['{',JSON.stringify([{key:'signatory',label:'Signatory',userIds:[signerId],allowDelegation:true}]),JSON.stringify([{key:'signatory',label:'Signatory',userIds:[signerId],allowDelegation:false,script:'UNSUPPORTED'}])]){const data=form();data.set('stages',stages);expect((await savePolicySettings(null,data))?.error).toMatch(/invalid|configuration/);}expect(mocks.save).not.toHaveBeenCalled();expect(mocks.session).not.toHaveBeenCalled();
});
it('reports unavailable email configuration without falsely reporting a successful save',async()=>{
 const data=form();data.set('emailNotifications','yes');mocks.save.mockRejectedValue(new LetterWorkflowError('configuration','emailTransport'));expect(await savePolicySettings(null,data)).toEqual({error:'configuration',detail:'emailTransport'});expect(mocks.revalidate).not.toHaveBeenCalled();
});
it('never takes an uploaded signature owner from form fields and closes private storage errors',async()=>{
 const data=new FormData();data.set('companyId',companyId);data.set('kind','signature');data.set('name','Own signature');data.set('ownerUserId',signerId);data.set('file',new File([Buffer.alloc(32)],'signature.png',{type:'image/png'}));mocks.asset.mockRejectedValue(new Error('PRIVATE STORAGE'));expect(await uploadLetterAsset(null,data)).toEqual({error:'unavailable'});expect(mocks.asset).toHaveBeenCalledExactlyOnceWith(ctx,{companyId,kind:'signature',name:'Own signature',content:Buffer.alloc(32)});expect(mocks.revalidate).not.toHaveBeenCalled();
});
it('refuses oversize images before reading bytes into the asset owner',async()=>{
 const data=new FormData();data.set('companyId',companyId);data.set('kind','letterhead');data.set('name','Huge image');data.set('file',new File([Buffer.alloc(2_097_153)],'large.png',{type:'image/png'}));expect(await uploadLetterAsset(null,data)).toEqual({error:'invalid',detail:'png'});expect(mocks.asset).not.toHaveBeenCalled();expect(mocks.session).not.toHaveBeenCalled();
});
