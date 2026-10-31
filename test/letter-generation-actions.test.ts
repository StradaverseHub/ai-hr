import {beforeEach,it,expect,vi} from 'vitest';
import {LetterWorkflowError} from '../lib/letter-workflow';
const mocks=vi.hoisted(()=>({session:vi.fn(),create:vi.fn(),template:vi.fn(),detail:vi.fn(),refresh:vi.fn(),withdraw:vi.fn(),submit:vi.fn(),revalidate:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:mocks.session}));
vi.mock('../core/letters',()=>({createLetterDraftBatch:mocks.create,getLetterTemplate:mocks.template,getStaffLetter:mocks.detail,refreshLetterDraft:mocks.refresh,withdrawLetterDraft:mocks.withdraw,submitLetterBatch:mocks.submit}));
vi.mock('next/cache',()=>({revalidatePath:mocks.revalidate}));
vi.mock('next/navigation',()=>({redirect:(url:string)=>{throw new Error('REDIRECT:'+url);}}));
import {createGeneration,updateGeneration} from '../app/(app)/letters/generate/actions';
const companyId='00000000-0000-4000-8000-000000000001',versionId='00000000-0000-4000-8000-000000000002',batchId='00000000-0000-4000-8000-000000000003',employeeId='00000000-0000-4000-8000-000000000004',operationKey='00000000-0000-4000-8000-000000000005',letterId='00000000-0000-4000-8000-000000000006',ctx={tenantId:'fixture',userId:'actual-user'};
const fields=[{id:'mapping',definition:{key:'allowance',label:'Allowance',description:'Typed amount',source:'custom.currency',kind:'currency',required:false,editable:true,sensitive:true}},{id:'canonical',definition:{key:'employeeName',label:'Employee name',description:'Canonical name',source:'employee.name',kind:'text',required:true,editable:false,sensitive:false}}];
function form(){const result=new FormData();for(const [key,value]of Object.entries({companyId,versionId,operationKey,employmentId:employeeId,'custom:allowance:value':'1200.50','custom:allowance:currency':'MYR'}))result.set(key,value);return result;}
beforeEach(()=>{vi.clearAllMocks();mocks.session.mockResolvedValue(ctx);mocks.template.mockResolvedValue({root:{companyId},fields});mocks.create.mockResolvedValue({batchId});mocks.detail.mockResolvedValue({record:{batchId,currentRevisionId:versionId},batch:{templateVersionId:versionId}});});
it('creates a retry-keyed draft from the fresh saved bindings and explicit selected identities',async()=>{
 await expect(createGeneration(null,form())).rejects.toThrow('REDIRECT:/letters/generate/'+batchId+'?notice=created');expect(mocks.create).toHaveBeenCalledExactlyOnceWith(ctx,{companyId,templateVersionId:versionId,operationKey,employmentIds:[employeeId],customValues:{[employeeId]:{allowance:{kind:'currency',value:'1200.50',currency:'MYR'}}}});expect(mocks.submit).not.toHaveBeenCalled();
});
it('rejects an empty/oversized selection and canonical source overrides before any draft mutation',async()=>{
 const empty=form();empty.delete('employmentId');expect(await createGeneration(null,empty)).toEqual({error:'invalid'});const huge=form();for(let index=0;index<500;index++)huge.append('employmentId',employeeId);expect(await createGeneration(null,huge)).toEqual({error:'invalid'});
 const forged=form();forged.set('custom:employeeName:value','Forged employee');expect(await createGeneration(null,forged)).toEqual({error:'invalid'});expect(mocks.create).not.toHaveBeenCalled();
});
it('allows only designated editable values after generation and derives the redirect batch from the record',async()=>{
 const data=form();data.set('action','refresh');data.set('letterId',letterId);data.set('expectedLockVersion','7');data.set('batchId',operationKey);
 await expect(updateGeneration(null,data)).rejects.toThrow('REDIRECT:/letters/generate/'+batchId+'?notice=refresh');expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith(ctx,{letterId,expectedLockVersion:7,customValues:{allowance:{kind:'currency',value:'1200.50',currency:'MYR'}}});
 mocks.template.mockResolvedValue({root:{companyId},fields:[{...fields[0],definition:{...fields[0].definition,editable:false}}]});mocks.refresh.mockClear();expect(await updateGeneration(null,data)).toEqual({error:'invalid'});expect(mocks.refresh).not.toHaveBeenCalled();
});
it('delegates whole-batch submission to the current owner and keeps stale failures closed',async()=>{
 const data=new FormData();data.set('action','submit');data.set('batchId',batchId);await expect(updateGeneration(null,data)).rejects.toThrow('REDIRECT:');expect(mocks.submit).toHaveBeenCalledExactlyOnceWith(ctx,batchId);
 mocks.revalidate.mockClear();mocks.submit.mockRejectedValue(new LetterWorkflowError('stale','sourceChanged'));expect(await updateGeneration(null,data)).toEqual({error:'stale'});mocks.submit.mockRejectedValue(new Error('PRIVATE SQL'));expect(await updateGeneration(null,data)).toEqual({error:'unavailable'});expect(mocks.revalidate).not.toHaveBeenCalled();
});

it('binds a replacement draft to the original employee and keeps its immutable source link',async()=>{
 const data=form();data.set('reissueOf',letterId);mocks.detail.mockResolvedValue({record:{id:letterId,state:'void',companyId,employmentId:employeeId}});
 await expect(createGeneration(null,data)).rejects.toThrow('REDIRECT:/letters/generate/'+batchId+'?notice=created');expect(mocks.create.mock.calls[0][1]).toMatchObject({reissueOf:letterId,employmentIds:[employeeId]});mocks.create.mockClear();
 data.set('employmentId',operationKey);expect(await createGeneration(null,data)).toEqual({error:'permission'});expect(mocks.create).not.toHaveBeenCalled();
});
