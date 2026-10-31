import {beforeEach,it,expect,vi} from 'vitest';
import {LetterWorkflowError} from '../lib/letter-workflow';
const mocks=vi.hoisted(()=>({scope:vi.fn(),template:vi.fn(),save:vi.fn(),revalidate:vi.fn()}));
vi.mock('../lib/scope',()=>({scopedSession:mocks.scope}));
vi.mock('../core/letters',()=>({getLetterTemplate:mocks.template,saveLetterAutomationRule:mocks.save,LETTER_AUTOMATION_TRIGGERS:['probation_due','confirmation_applied','promotion_applied']}));
vi.mock('next/cache',()=>({revalidatePath:mocks.revalidate}));
vi.mock('next/navigation',()=>({redirect:(url:string)=>{throw new Error('REDIRECT:'+url);}}));
import {saveAutomationSettings} from '../app/(app)/letters/settings/automation/actions';
const companyId='00000000-0000-4000-8000-000000000001',templateId='00000000-0000-4000-8000-000000000002',versionId='00000000-0000-4000-8000-000000000003',ctx={tenantId:'fixture',userId:'actual-user'},field={key:'effectiveDate',label:'Effective date',kind:'date',source:'custom.date',required:true,editable:true,sensitive:false};
function form(){const data=new FormData();for(const [key,value]of Object.entries({companyId,templateId,versionId,trigger:'probation_due',expectedOrdinal:'4',enabled:'yes',startOn:'2026-11-01','custom:effectiveDate:value':'2026-11-02'}))data.set(key,value);return data;}
beforeEach(()=>{vi.clearAllMocks();mocks.scope.mockResolvedValue({s:ctx,scopeIds:[companyId]});mocks.template.mockResolvedValue({root:{id:templateId,companyId},fields:[{definition:field}]});mocks.save.mockRejectedValue(new LetterWorkflowError('stale'));});
it('uses fresh server mappings and the displayed ordinal without adopting submitted owners, employee selections or bodies',async()=>{
 const data=form();data.set('createdBy',versionId);data.set('afterSequence','0');data.set('employmentId',versionId);data.set('document','FORGED BODY');expect(await saveAutomationSettings(null,data)).toEqual({error:'stale'});expect(mocks.template).toHaveBeenCalledExactlyOnceWith(ctx,versionId,{forGeneration:true});expect(mocks.save).toHaveBeenCalledExactlyOnceWith(ctx,{companyId,templateId,trigger:'probation_due',expectedOrdinal:4,enabled:true,startOn:'2026-11-01',customValues:{effectiveDate:{kind:'date',value:'2026-11-02'}}});expect(mocks.revalidate).not.toHaveBeenCalled();
});
it('refuses duplicate scalar fields, unsupported events and forged custom keys before mutation',async()=>{
 for(const key of ['companyId','templateId','versionId','trigger','expectedOrdinal','enabled','startOn']){const data=form();data.append(key,String(data.get(key)));expect(await saveAutomationSettings(null,data)).toEqual({error:'invalid'});}const unsupported=form();unsupported.set('trigger','automatic_issue');expect(await saveAutomationSettings(null,unsupported)).toEqual({error:'invalid'});expect(mocks.scope).not.toHaveBeenCalled();
 const duplicate=form();duplicate.append('custom:effectiveDate:value','2026-11-03');expect(await saveAutomationSettings(null,duplicate)).toEqual({error:'invalid'});const unknown=form();unknown.set('custom:employeeName:value','FORGED NAME');expect((await saveAutomationSettings(null,unknown))?.error).toBe('invalid');expect(mocks.save).not.toHaveBeenCalled();
});
it('keeps writes inside the current server company scope and binds the displayed version to the actual template',async()=>{
 mocks.scope.mockResolvedValue({s:ctx,scopeIds:[]});expect(await saveAutomationSettings(null,form())).toEqual({error:'permission'});expect(mocks.template).not.toHaveBeenCalled();mocks.scope.mockResolvedValue({s:ctx,scopeIds:[companyId]});mocks.template.mockResolvedValue({root:{id:versionId,companyId},fields:[]});expect(await saveAutomationSettings(null,form())).toEqual({error:'permission'});expect(mocks.save).not.toHaveBeenCalled();
});
it('allows disabling an existing rule without reading an inactive template or replacing its stored defaults',async()=>{
 const data=form();data.set('enabled','no');data.delete('startOn');data.delete('versionId');data.set('custom:effectiveDate:value','FORGED DISABLE DEFAULT');expect(await saveAutomationSettings(null,data)).toEqual({error:'stale'});expect(mocks.template).not.toHaveBeenCalled();expect(mocks.save).toHaveBeenCalledExactlyOnceWith(ctx,{companyId,templateId,trigger:'probation_due',expectedOrdinal:4,enabled:false});
});
it('revalidates only after an actual successful save and closes internal errors',async()=>{
 mocks.save.mockResolvedValue({ordinal:5});await expect(saveAutomationSettings(null,form())).rejects.toThrow('REDIRECT:/letters/settings/automation?companyId='+companyId+'&notice=saved');expect(mocks.revalidate).toHaveBeenCalledWith('/letters/settings/automation');mocks.save.mockRejectedValue(new Error('PRIVATE DATABASE DETAIL'));expect(await saveAutomationSettings(null,form())).toEqual({error:'unavailable'});
});
