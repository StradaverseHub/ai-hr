import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {render,screen,cleanup,within,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {createTranslator} from 'next-intl';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import viMessages from '../messages/vi.json';
import {todayInKualaLumpur} from '../lib/hr-date';
const mocks=vi.hoisted(()=>({locale:'en' as 'en'|'ms'|'zh'|'ta'|'th'|'vi',access:vi.fn(),templates:vi.fn(),batches:vi.fn(),template:vi.fn(),batch:vi.fn(),create:vi.fn(),update:vi.fn(),detail:vi.fn()}));
const catalogues={en,ms,zh,ta,th,vi:viMessages};
vi.mock('../lib/authz',()=>({requireModule:async()=>({})}));
vi.mock('../lib/scope',()=>({scopedSession:async()=>({s:{tenantId:'fixture',userId:'actual-user'},scopeIds:['00000000-0000-4000-8000-000000000001']})}));
vi.mock('../core/letters',()=>({letterCompanyAccess:mocks.access,listLetterTemplates:mocks.templates,listLetterGenerationBatches:mocks.batches,getLetterTemplate:mocks.template,getLetterGenerationBatch:mocks.batch,getStaffLetter:mocks.detail}));
vi.mock('../app/(app)/letters/generate/actions',()=>({createGeneration:mocks.create,updateGeneration:mocks.update}));
vi.mock('next-intl/server',()=>({getLocale:async()=>mocks.locale,getTranslations:async(namespace:'letters.automation'|'letters.generate'|'letters.templates'|'letters.fields'|'letters.reports')=>{const c=catalogues[mocks.locale];return createTranslator({locale:mocks.locale,messages:{letters:{automation:c.letters.automation,generate:c.letters.generate,templates:c.letters.templates,fields:c.letters.fields,reports:{states:c.letters.reports.states}}},namespace});}}));
import GeneratePage from '../app/(app)/letters/generate/page';
import NewPage from '../app/(app)/letters/generate/new/page';
import BatchPage from '../app/(app)/letters/generate/[batchId]/page';
const companyId='00000000-0000-4000-8000-000000000001',versionId='00000000-0000-4000-8000-000000000002',batchId='00000000-0000-4000-8000-000000000003',employeeId='00000000-0000-4000-8000-000000000004',letterId='00000000-0000-4000-8000-000000000005';
const field={key:'note',label:'Note',description:'Explicit custom note',source:'custom.text',kind:'text',required:false,editable:true,sensitive:false};
function template(){return {root:{id:'root',companyId,code:'FICTIONAL',deactivated:false},version:{id:versionId,name:'Fictional template',category:'confirmation',ordinal:1,status:'approved',effectiveFrom:todayInKualaLumpur()},fields:[{id:'mapping',definition:field}]};}
function batch(){return {batch:{id:batchId,companyId,templateVersionId:versionId,selection:{customValues:{}}},templateActive:true,total:4,selected:3,ready:2,needsCorrection:1,states:{draft:3,withdrawn:1},nextCursor:letterId,rows:[{record:{id:letterId,employmentId:employeeId,state:'draft',reference:'HR/0001',lockVersion:2,currentRevisionId:versionId},employee:{name:'Fictional employee',code:'0001'},revision:{document:{version:1,language:'en',blocks:[{type:'paragraph',content:[{type:'text',text:'Generated preview wording'}]}]},editableValues:{note:{kind:'text',value:'Original permitted note'}}},ready:true,sourceChanged:false,issue:null}]};}
beforeEach(()=>{cleanup();vi.clearAllMocks();mocks.locale='en';mocks.access.mockResolvedValue([{id:companyId,name:'Fictional company',read:true,generate:true},{id:'outside',name:'Outside context',read:true,generate:true}]);mocks.templates.mockResolvedValue({rows:[{root:template().root,version:template().version}],nextCursor:null});mocks.batches.mockResolvedValue({rows:[],nextCursor:null});mocks.template.mockResolvedValue(template());mocks.batch.mockResolvedValue(batch());mocks.create.mockResolvedValue({error:'stale'});});
afterEach(()=>vi.unstubAllGlobals());
it('offers only current-context active templates and requests the actor batch list',async()=>{
 render(await GeneratePage({searchParams:Promise.resolve({companyId})}));expect(screen.queryByRole('option',{name:'Outside context'})).toBeNull();expect(screen.getByRole('link',{name:'Create draft batch'}).getAttribute('href')).toBe('/letters/generate/new?versionId='+versionId);expect(mocks.templates).toHaveBeenCalledExactlyOnceWith({tenantId:'fixture',userId:'actual-user'},{companyId,mode:'active',search:undefined,cursor:undefined});
});
it('keeps full-cohort readiness counts separate from the displayed page and disables partial submission',async()=>{
 render(await BatchPage({params:Promise.resolve({batchId}),searchParams:Promise.resolve({})}));expect(screen.getByText('Selected letters').parentElement?.textContent).toBe('Selected letters3');expect(screen.getByText('Needs correction').parentElement?.textContent).toBe('Needs correction1');expect(screen.getByRole('button',{name:'Submit 2 ready letters'})).toHaveProperty('disabled',true);expect(screen.getByText('Fictional employee · 0001')).toBeTruthy();expect(screen.queryByRole('textbox',{name:'Letter body'})).toBeNull();
 const user=userEvent.setup();await user.click(screen.getByText('Letter preview'));expect(screen.getByText('Letter preview').closest('details')).toHaveProperty('open',true);expect(screen.getByText('Generated preview wording')).toBeTruthy();expect(mocks.batch).toHaveBeenCalledExactlyOnceWith({tenantId:'fixture',userId:'actual-user'},batchId,{cursor:undefined,limit:25});
});
it('retains the selected roster and custom inputs after a refused draft save',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,headers:new Headers({'content-type':'application/json'}),json:async()=>({rows:[{id:employeeId,label:'Fictional employee · 0001'}],nextCursor:null})}));render(await NewPage({searchParams:Promise.resolve({versionId})}));const user=userEvent.setup();await user.click(screen.getByRole('button',{name:'Find'}));await user.click(await screen.findByRole('button',{name:'Add shown employees'}));await user.type(screen.getByLabelText('Note'),'Retain this note');await user.click(screen.getByRole('button',{name:'Create draft batch'}));await screen.findByRole('alert');expect(within(screen.getByRole('region',{name:'Selected employees'})).getByText('Fictional employee · 0001')).toBeTruthy();expect(screen.getByLabelText('Note')).toHaveProperty('value','Retain this note');expect(document.querySelector('input[name="employmentId"]')).toHaveProperty('value',employeeId);expect(mocks.template).toHaveBeenCalledWith({tenantId:'fixture',userId:'actual-user'},versionId,{forGeneration:true});
});
it.each(['en','ms','zh','ta','th','vi'] as const)('renders the actual new-generation filters in %s',async locale=>{
 mocks.locale=locale;render(await NewPage({searchParams:Promise.resolve({versionId})}));const copy=catalogues[locale].letters.generate;expect(screen.getByLabelText(copy.form.department)).toBeTruthy();expect(screen.getByLabelText(copy.form.branch)).toBeTruthy();expect(screen.getByLabelText(copy.form.hiredFrom)).toHaveProperty('type','date');expect(screen.getByRole('button',{name:copy.form.create})).toHaveProperty('disabled',true);
});

it('keeps a replacement draft fixed to the original recipient and names the fresh approval requirement',async()=>{
 mocks.detail.mockResolvedValue({record:{id:letterId,companyId,employmentId:employeeId,state:'void',reference:'ORIGINAL/0001'},employee:{name:'Original fictional employee',code:'0007'}});
 render(await NewPage({searchParams:Promise.resolve({versionId,reissueOf:letterId})}));expect(screen.getByText('Original fictional employee · 0007')).toBeTruthy();expect(screen.getByText('Replacement for ORIGINAL/0001. This creates a new draft and requires fresh approval.')).toBeTruthy();expect(screen.queryByRole('button',{name:'Find'})).toBeNull();expect(screen.queryByRole('button',{name:/Remove:/})).toBeNull();expect(document.querySelector('input[name="employmentId"]')).toHaveProperty('value',employeeId);expect(document.querySelector('input[name="reissueOf"]')).toHaveProperty('value',letterId);
});

it.each(['en','ms','zh','ta','th','vi'] as const)('shows the reviewer reason and decision history beside the correction controls in %s',async locale=>{
 mocks.locale=locale;const data=batch(),reason='Correct the effective date <script>literal reason</script>';mocks.batch.mockResolvedValue({...data,ready:0,needsCorrection:1,rows:[{...data.rows[0],record:{...data.rows[0].record,state:'returned'},ready:false,correctionReason:reason}]});render(await BatchPage({params:Promise.resolve({batchId}),searchParams:Promise.resolve({})}));const copy=catalogues[locale].letters.generate.page;
 expect(screen.getByText(copy.reviewerReason)).toBeTruthy();expect(screen.getByText(reason)).toBeTruthy();expect(screen.getByRole('link',{name:copy.decisionHistory}).getAttribute('href')).toBe('/letters/approval/'+letterId);expect(document.querySelector('script')).toBeNull();
});


it.each(['en','ms','zh','ta','th','vi'] as const)('blocks batch submission until corrections are saved or restored, retaining refused edits in %s',async locale=>{
 mocks.locale=locale;const data=batch();mocks.batch.mockResolvedValue({...data,ready:3,needsCorrection:0});mocks.update.mockResolvedValue({error:'stale'});
 render(await BatchPage({params:Promise.resolve({batchId}),searchParams:Promise.resolve({})}));const user=userEvent.setup(),copy=catalogues[locale].letters.generate,submit=screen.getByRole('button',{name:copy.page.submit.replace('{count}','3')});
 expect(submit).toHaveProperty('disabled',false);await user.click(screen.getByText(copy.page.correct));const input=screen.getByLabelText('Note');await user.type(input,' — correction');expect(submit).toHaveProperty('disabled',true);expect(screen.getByText(copy.page.unsavedCorrections)).toBeTruthy();await user.click(submit);expect(mocks.update).not.toHaveBeenCalled();
 const unload=new Event('beforeunload',{cancelable:true});window.dispatchEvent(unload);expect(unload.defaultPrevented).toBe(true);
 await user.clear(input);await user.type(input,'Original permitted note');expect(submit).toHaveProperty('disabled',false);expect(screen.queryByText(copy.page.unsavedCorrections)).toBeNull();
 await user.type(input,' — retained after failure');await user.click(screen.getByRole('button',{name:copy.page.refresh}));await screen.findByRole('alert');expect(input).toHaveProperty('value','Original permitted note — retained after failure');expect(submit).toHaveProperty('disabled',true);expect(mocks.update).toHaveBeenCalledTimes(1);
 await user.clear(input);await user.type(input,'Original permitted note');await waitFor(()=>expect(submit).toHaveProperty('disabled',false));
});

it('keeps submission blocked while any other letter on the page has unsaved corrections',async()=>{
 const data=batch(),secondId='00000000-0000-4000-8000-000000000006';mocks.batch.mockResolvedValue({...data,ready:3,needsCorrection:0,rows:[data.rows[0],{...data.rows[0],record:{...data.rows[0].record,id:secondId,reference:'HR/0002'}}]});render(await BatchPage({params:Promise.resolve({batchId}),searchParams:Promise.resolve({})}));const user=userEvent.setup(),submit=screen.getByRole('button',{name:'Submit 3 ready letters'});
 for(const toggle of screen.getAllByText('Update permitted fields'))await user.click(toggle);const [first,second]=screen.getAllByLabelText('Note');await user.type(first,' changed');await user.type(second,' changed');await user.clear(first);await user.type(first,'Original permitted note');expect(submit).toHaveProperty('disabled',true);await user.clear(second);await user.type(second,'Original permitted note');expect(submit).toHaveProperty('disabled',false);
});


it.each(['en','ms','zh','ta','th','vi'] as const)('explains invalid automatic sources and removes obsolete correction actions in %s',async locale=>{
 mocks.locale=locale;const data=batch();mocks.batch.mockResolvedValue({...data,ready:0,needsCorrection:1,rows:[{...data.rows[0],ready:false,automationSourceChanged:true}]});render(await BatchPage({params:Promise.resolve({batchId}),searchParams:Promise.resolve({})}));expect(screen.getByRole('alert').textContent).toBe(catalogues[locale].letters.automation.sourceBlocked);expect(screen.queryByText(catalogues[locale].letters.generate.page.correct)).toBeNull();expect(screen.getByRole('button',{name:catalogues[locale].letters.generate.page.submit.replace('{count}','0')})).toHaveProperty('disabled',true);
});
