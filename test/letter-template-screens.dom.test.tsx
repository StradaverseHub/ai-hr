import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {render,screen,cleanup} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {createTranslator} from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import viMessages from '../messages/vi.json';
import {todayInKualaLumpur} from '../lib/hr-date';
const mocks=vi.hoisted(()=>({locale:'en' as 'en'|'ms'|'zh'|'ta'|'th'|'vi',scopeIds:[] as string[],access:vi.fn(),list:vi.fn(),detail:vi.fn(),history:vi.fn(),save:vi.fn(),update:vi.fn(),preview:vi.fn()}));
const catalogues={en,ms,zh,ta,th,vi:viMessages};
vi.mock('../lib/authz',()=>({requireModule:async()=>({})}));
vi.mock('../lib/scope',()=>({scopedSession:async()=>({s:{tenantId:'fixture',userId:'current-user'},scopeIds:mocks.scopeIds,allowedCount:2})}));
vi.mock('../core/letters',()=>({letterCompanyAccess:mocks.access,listLetterTemplates:mocks.list,getLetterTemplate:mocks.detail,listLetterTemplateVersions:mocks.history}));
vi.mock('../app/(app)/letters/templates/actions',()=>({saveTemplate:mocks.save,updateTemplate:mocks.update,previewTemplate:mocks.preview}));
vi.mock('next-intl/server',()=>({getLocale:async()=>mocks.locale,getTranslations:async(namespace:'letters.templates'|'letters.fields')=>createTranslator({locale:mocks.locale,messages:{letters:{templates:catalogues[mocks.locale].letters.templates,fields:catalogues[mocks.locale].letters.fields}},namespace})}));
import TemplatesPage from '../app/(app)/letters/templates/page';
import TemplatePage from '../app/(app)/letters/templates/[versionId]/page';
import NewPage from '../app/(app)/letters/templates/new/page';
import EditPage from '../app/(app)/letters/templates/[versionId]/edit/page';
const companyId='00000000-0000-4000-8000-000000000001',versionId='00000000-0000-4000-8000-000000000002',templateId='00000000-0000-4000-8000-000000000003',fieldId='00000000-0000-4000-8000-000000000004';
const day=todayInKualaLumpur(),definition={key:'employeeName',label:'Employee name',description:'Canonical name',kind:'text',source:'employee.name',required:true,editable:false,sensitive:false};
function detail(){return {root:{id:templateId,companyId,revision:4,code:'LETTER',deactivated:false},version:{id:versionId,ordinal:2,name:'Fictional template',category:'confirmation',effectiveFrom:day,status:'submitted',createdBy:'other-author',document:{version:1,language:'en',blocks:[{type:'paragraph',content:[{type:'text',text:'<script>untrusted literal</script>',marks:['bold']},{type:'field',key:'employeeName'}]}]},presentation:{letterheadAssetId:null,signatoryUserId:'signer'}},fields:[{id:fieldId,definition,active:true,ordinal:3}],appearance:{letterhead_name:null,signatory_name:'Fictional signer'}};}
beforeEach(()=>{
 cleanup();vi.clearAllMocks();mocks.locale='en';mocks.scopeIds=[companyId];mocks.access.mockResolvedValue([{id:companyId,name:'Fictional company',read:true,template:true},{id:'outside-context',name:'Outside selected context',read:true,template:true}]);mocks.detail.mockResolvedValue(detail());mocks.list.mockResolvedValue({rows:[{root:detail().root,version:detail().version}],nextCursor:null});mocks.history.mockResolvedValue({rows:[{...detail().version,createdAt:new Date()}],nextCursor:null});mocks.update.mockResolvedValue({error:'stale'});
});
afterEach(()=>vi.unstubAllGlobals());
it('lists the actual version state within the current company context and links to authoring',async()=>{
 render(await TemplatesPage({searchParams:Promise.resolve({companyId})}));expect(screen.getByRole('link',{name:'Fictional template'}).getAttribute('href')).toBe('/letters/templates/'+versionId);expect(screen.getByText('Awaiting approval')).toBeTruthy();expect(screen.queryByRole('option',{name:'Outside selected context'})).toBeNull();expect(mocks.list).toHaveBeenCalledExactlyOnceWith({tenantId:'fixture',userId:'current-user'},{companyId,mode:'latest',search:undefined,cursor:undefined});expect(screen.getByRole('link',{name:'New template'}).getAttribute('href')).toContain('companyId='+companyId);
});
it('renders retained wording safely and retains a rejection comment after a stale decision',async()=>{
 render(await TemplatePage({params:Promise.resolve({versionId}),searchParams:Promise.resolve({})}));expect(screen.getByText('<script>untrusted literal</script>').closest('strong')).toBeTruthy();expect(document.querySelector('script')).toBeNull();expect(screen.getByText('{{employeeName}}')).toBeTruthy();expect(screen.getByText('Fictional signer')).toBeTruthy();
 const user=userEvent.setup();await user.type(screen.getByLabelText('Reason for rejection'),'Please correct the wording');await user.click(screen.getByRole('button',{name:'Reject version'}));await screen.findByRole('alert');expect(screen.getByLabelText('Reason for rejection')).toHaveProperty('value','Please correct the wording');
});
it('does not offer the author approval or rejection controls',async()=>{
 const value=detail();value.version.createdBy='current-user';mocks.detail.mockResolvedValue(value);render(await TemplatePage({params:Promise.resolve({versionId}),searchParams:Promise.resolve({})}));expect(screen.queryByRole('button',{name:'Approve version'})).toBeNull();expect(screen.queryByRole('button',{name:'Reject version'})).toBeNull();expect(screen.getByText('Another authorized template administrator must approve this version.')).toBeTruthy();
});
it('duplicates retained wording with a new code and keeps original field-version identities until explicitly rebound',async()=>{
 render(await EditPage({params:Promise.resolve({versionId}),searchParams:Promise.resolve({copy:'yes'})}));expect(screen.getByLabelText('Template code')).toHaveProperty('value','');expect(document.querySelector<HTMLInputElement>('input[name="templateId"]')).toHaveProperty('value','');expect(document.querySelector<HTMLInputElement>('input[name="fieldVersionId"]')).toHaveProperty('value',fieldId);expect(screen.getByLabelText('Template name')).toHaveProperty('value','Fictional template');
});
it.each(['en','ms','zh','ta','th','vi'] as const)('renders the authoring controls in %s without enabling an unconfigured submission',async locale=>{
 mocks.locale=locale;render(await NewPage({searchParams:Promise.resolve({companyId})}));const copy=catalogues[locale].letters.templates;expect(screen.getByLabelText(copy.form.name)).toBeTruthy();expect(screen.getByRole('button',{name:copy.form.submit})).toHaveProperty('disabled',true);expect(screen.getByRole('option',{name:'Bahasa Melayu'})).toBeTruthy();
});

it('shows an explicit employee preview and hides it as soon as the selection inputs change',async()=>{
 mocks.preview.mockResolvedValue({document:{version:1,language:'en',blocks:[{type:'paragraph',content:[{type:'text',text:'Actual employee preview result'}]}]}});
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,headers:new Headers({'content-type':'application/json'}),json:async()=>({rows:[{id:fieldId,label:'Selected employee 0001'}],nextCursor:null})}));
 render(await TemplatePage({params:Promise.resolve({versionId}),searchParams:Promise.resolve({})}));const user=userEvent.setup();await user.click(screen.getByRole('button',{name:'Find'}));await user.click(await screen.findByRole('button',{name:'Choose: Selected employee 0001'}));await user.click(screen.getByRole('button',{name:'Preview saved version'}));expect(await screen.findByText('Actual employee preview result')).toBeTruthy();
 await user.type(screen.getByLabelText('Search choices'),'different');expect(screen.queryByText('Actual employee preview result')).toBeNull();
});
