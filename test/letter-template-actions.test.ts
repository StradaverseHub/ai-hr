import {beforeEach,it,expect,vi} from 'vitest';
import {LetterModelError} from '../lib/letter-model';
import {LetterWorkflowError} from '../lib/letter-workflow';
import {todayInKualaLumpur} from '../lib/hr-date';
const mocks=vi.hoisted(()=>({session:vi.fn(),save:vi.fn(),decide:vi.fn(),active:vi.fn(),revalidate:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:mocks.session}));
vi.mock('../core/letters',()=>({saveLetterTemplate:mocks.save,decideLetterTemplate:mocks.decide,setLetterTemplateActive:mocks.active}));
vi.mock('next/cache',()=>({revalidatePath:mocks.revalidate}));
vi.mock('next/navigation',()=>({redirect:(url:string)=>{throw new Error('REDIRECT:'+url);}}));
import {saveTemplate,updateTemplate} from '../app/letters/templates/actions';
const day=todayInKualaLumpur();
const companyId='00000000-0000-4000-8000-000000000001',versionId='00000000-0000-4000-8000-000000000002',signatoryUserId='00000000-0000-4000-8000-000000000003',fieldId='00000000-0000-4000-8000-000000000004',ctx={tenantId:'fixture',userId:'actual-user'},editor={type:'doc',content:[{type:'paragraph'}]};
function form(){const data=new FormData();for(const [key,value]of Object.entries({companyId,code:'LETTER',name:'Fictional letter',category:'confirmation',effectiveFrom:day,editor:JSON.stringify(editor),language:'en',signatoryUserId,letterheadAssetId:'',fieldVersionId:fieldId,intent:'submit'}))data.set(key,value);return data;}
beforeEach(()=>{vi.clearAllMocks();mocks.session.mockResolvedValue(ctx);mocks.save.mockResolvedValue({versionId});});
it('sends editor data and selected identities to the fresh owner in one atomic submit request',async()=>{
 const data=form();data.set('fieldSource','arbitrary client source');await expect(saveTemplate(null,data)).rejects.toThrow('REDIRECT:/letters/templates/'+versionId+'?notice=submitted');expect(mocks.save).toHaveBeenCalledExactlyOnceWith(ctx,{companyId,code:'LETTER',name:'Fictional letter',category:'confirmation',effectiveFrom:day,editor,language:'en',fieldVersionIds:[fieldId],presentation:{letterheadAssetId:null,signatoryUserId},submit:true});expect(mocks.decide).not.toHaveBeenCalled();
});
it('refuses malformed editor envelopes, identities and missing submit intent before any mutation',async()=>{
 for(const [key,value]of [['editor','not JSON'],['editor','x'.repeat(1000001)],['signatoryUserId','other'],['language','javascript'],['intent',''],['fieldVersionId','foreign']] as const){const data=form();data.set(key,value);expect(await saveTemplate(null,data)).toEqual({error:'invalid'});}const edit=form();edit.set('templateId',versionId);expect(await saveTemplate(null,edit)).toEqual({error:'invalid'});expect(mocks.save).not.toHaveBeenCalled();
});
it('identifies invalid field keys without echoing private diagnostics or navigating away',async()=>{
 mocks.save.mockRejectedValue(new LetterModelError('unknownField','missingField'));expect(await saveTemplate(null,form())).toEqual({error:'invalidField',field:'missingField'});mocks.save.mockRejectedValue(new LetterWorkflowError('stale'));expect(await saveTemplate(null,form())).toEqual({error:'stale'});mocks.save.mockRejectedValue(new Error('PRIVATE SQL AND LETTER TEXT'));expect(await saveTemplate(null,form())).toEqual({error:'unavailable'});expect(mocks.revalidate).not.toHaveBeenCalled();
});
it('derives approval state from the requested transition and preserves the activation comparison',async()=>{
 const data=new FormData();data.set('versionId',versionId);data.set('action','approve');data.set('expectedStatus','draft');await expect(updateTemplate(null,data)).rejects.toThrow('REDIRECT:');expect(mocks.decide).toHaveBeenCalledExactlyOnceWith(ctx,{versionId,expectedStatus:'submitted',action:'approve',reason:''});
 data.set('action','deactivate');data.set('templateId',fieldId);data.set('expectedRevision','7');await expect(updateTemplate(null,data)).rejects.toThrow('REDIRECT:');expect(mocks.active).toHaveBeenCalledExactlyOnceWith(ctx,{templateId:fieldId,expectedRevision:7,active:false});
});
