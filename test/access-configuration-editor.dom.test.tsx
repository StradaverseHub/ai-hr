// @vitest-environment jsdom
import {captureAiReviewScreenshots,aiReviewDomHtml} from './helpers/ai-review-screenshots';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {AccessConfigurationEditor,type AccessEditorProps,type AccessEditorResult} from '../app/admin/users/access-editor';
import {FINANCIAL_LETTER_FUNCTIONS} from '../deploy/access/financial-letter-function-bindings';
import {functionActionCapabilities} from '../deploy/access/function-action-contract';
import type {AccessConfigurationPreview} from '../core/access-configuration';
const routing=vi.hoisted(()=>({refresh:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>routing}));
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const tenant=id(1),root=id(2),worker=id(3),system=id(4),readers=id(5),companyA=id(6),companyB=id(7);
function fixture(supportedWrites=false){
 const preview=vi.fn<AccessEditorProps['previewAction']>().mockResolvedValue({ok:true,value:{revision:id(8),fingerprint:'b'.repeat(64),changes:[],changesUnrestrictedScope:false}});
 const save=vi.fn<AccessEditorProps['saveAction']>().mockResolvedValue({ok:true,value:{revision:id(9)}});
 const props:AccessEditorProps={actorUserId:root,scopeFingerprint:'a'.repeat(64),snapshot:{tenantId:tenant,revision:id(8),users:[{id:root,active:true},{id:worker,active:true}],groups:[
  {id:system,name:'System Administrators',retired:false,systemAdministrator:true,grants:[{capabilityId:'access.configure',companyId:null}]},
  {id:readers,name:'Readers',retired:false,systemAdministrator:false,grants:[{capabilityId:'workforce.view',companyId:companyA},{capabilityId:'workforce.view',companyId:companyB}]},
 ],memberships:[{userId:worker,groupId:readers,companyId:companyA,derived:true}],overrides:[]},capabilities:[
  {id:'workforce.view',label:'View workforce records',scope:'company',supported:true},
  {id:'workforce.maintain',label:'Maintain workforce records',scope:'company',supported:false},
  ...(['add','edit','delete'] as const).map(action=>({id:'workforce.'+action,label:action[0].toUpperCase()+action.slice(1)+' workforce records',scope:'company' as const,supported:supportedWrites})),
 ],users:[{id:root,label:'Fictional root'},{id:worker,label:'Fictional worker'}],companies:[{id:companyA,label:'Company A'},{id:companyB,label:'Company B'}],previewAction:preview,saveAction:save,history:[]};
 const tree=(next:AccessEditorProps=props)=><NextIntlClientProvider locale="en" timeZone="Asia/Kuala_Lumpur" messages={en}><AccessConfigurationEditor {...next}/></NextIntlClientProvider>;
 const view=render(tree());
 const chooseReaders=()=>{fireEvent.click(screen.getByRole('button',{name:'Readers'}));fireEvent.change(screen.getByRole('combobox',{name:'Company scope'}),{target:{value:companyA}});};
 return {props,preview,save,view,tree,chooseReaders};
}
afterEach(()=>{cleanup();vi.clearAllMocks();});
describe('access editor decisions and stale preview behavior',()=>{
 it('renders the existing security controls at desktop and phone sizes',async()=>{fixture();await captureAiReviewScreenshots(aiReviewDomHtml(document.body),'en','security-permissions');},60000);
 it('keeps protected groups and unsupported capabilities read-only and never offers confirmation before preview',()=>{
  const f=fixture();expect((screen.getByRole('textbox',{name:'Group name'}) as HTMLInputElement).disabled).toBe(true);
  f.chooseReaders();expect((screen.getByRole('checkbox',{name:/Add workforce records/}) as HTMLInputElement).disabled).toBe(true);
  expect(screen.queryByRole('button',{name:'Confirm access change'})).toBeNull();expect(f.save).not.toHaveBeenCalled();
 });
 it('write cells add View and clearing View removes scoped writes without touching other companies',async()=>{
  const f=fixture(true);f.chooseReaders();fireEvent.click(screen.getByRole('checkbox',{name:/View workforce records/}));fireEvent.click(screen.getByRole('checkbox',{name:/Add workforce records/}));
  expect(screen.getByRole('checkbox',{name:/View workforce records/})).toBeChecked();
  fireEvent.click(screen.getByRole('checkbox',{name:/View workforce records/}));expect(screen.getByRole('checkbox',{name:/Add workforce records/})).not.toBeChecked();
  fireEvent.click(screen.getByRole('button',{name:'Preview permission changes'}));await waitFor(()=>expect(f.preview).toHaveBeenCalledOnce());
  expect(f.preview.mock.calls[0][0].command).toMatchObject({kind:'replaceGroupGrants',grants:[{capabilityId:'workforce.view',companyId:companyB}]});
 });
 it('tenant action cells retain tenant scope while a company is selected',async()=>{
  const f=fixture(true);f.chooseReaders();f.view.rerender(f.tree({...f.props,capabilities:[...f.props.capabilities,...(['view','add','edit','delete'] as const).map(operation=>({id:'settings.'+operation,label:operation+' tenant settings',scope:'tenant' as const,supported:true}))]}));
  fireEvent.click(screen.getByRole('checkbox',{name:'add tenant settings'}));fireEvent.click(screen.getByRole('button',{name:'Preview permission changes'}));
  await waitFor(()=>expect(f.preview).toHaveBeenCalledOnce());expect(f.preview.mock.calls[0][0].command).toMatchObject({kind:'replaceGroupGrants',grants:expect.arrayContaining([{capabilityId:'settings.view',companyId:null},{capabilityId:'settings.add',companyId:null}])});
 });
 it('renders real function rows and clears dependent submenu grants when a parent View is removed',async()=>{
  const f=fixture(true);f.chooseReaders();
  const descriptors=FINANCIAL_LETTER_FUNCTIONS.filter(row=>row.key==='payroll.process');expect(descriptors).toHaveLength(1);
  const children=functionActionCapabilities(descriptors).map(capability=>({...capability,supported:true,label:'Payroll Process · '+capability.id.slice(capability.id.lastIndexOf('.')+1)}));
  const family=(['view','add','edit','delete'] as const).map(operation=>({id:'payroll.'+operation,label:operation+' payroll',scope:'company' as const,supported:true}));
  f.view.rerender(f.tree({...f.props,capabilities:[...f.props.capabilities,...family,...children]}));
  expect(screen.getByRole('region',{name:'Payroll'})).toBeTruthy();
  fireEvent.click(screen.getByRole('checkbox',{name:'Payroll Process · add'}));
  expect(screen.getByRole('checkbox',{name:'Payroll Process · view'})).toBeChecked();
  expect(screen.getByRole('checkbox',{name:'view payroll'})).toBeChecked();
  expect(screen.getByRole('checkbox',{name:'add payroll'})).toBeChecked();
  fireEvent.click(screen.getByRole('checkbox',{name:'view payroll'}));
  expect(screen.getByRole('checkbox',{name:'Payroll Process · add'})).not.toBeChecked();
  expect(screen.getByRole('checkbox',{name:'Payroll Process · view'})).not.toBeChecked();
  // The add/clear round trip restores the initial draft; a real additional change enables preview.
  expect(screen.getByRole('button',{name:'Preview permission changes'})).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox',{name:'View workforce records'}));
  fireEvent.click(screen.getByRole('button',{name:'Preview permission changes'}));
  await waitFor(()=>expect(f.preview).toHaveBeenCalledOnce());
  expect(f.preview.mock.calls[0][0].command).toMatchObject({kind:'replaceGroupGrants',grants:[{capabilityId:'workforce.view',companyId:companyB}]});
 });
 it('preserves permissions in another company when changing the selected scope',async()=>{
  const f=fixture();f.chooseReaders();fireEvent.click(screen.getByRole('checkbox',{name:/View workforce records/}));
  fireEvent.click(screen.getByRole('button',{name:'Preview permission changes'}));
  await waitFor(()=>expect(f.preview).toHaveBeenCalledTimes(1));
  expect(f.preview.mock.calls[0][0]).toEqual({expectedRevision:id(8),command:{kind:'replaceGroupGrants',groupId:readers,grants:[{capabilityId:'workforce.view',companyId:companyB}]}});
 });
 it('discards a slow preview after another draft edit rather than enabling stale confirmation',async()=>{
  const f=fixture();let resolve!:(value:AccessEditorResult<AccessConfigurationPreview>)=>void;
  f.preview.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));f.chooseReaders();
  fireEvent.change(screen.getByRole('textbox',{name:'Group name'}),{target:{value:'First draft'}});
  fireEvent.click(screen.getByRole('button',{name:'Preview name change'}));
  fireEvent.change(screen.getByRole('textbox',{name:'Group name'}),{target:{value:'Changed draft'}});
  resolve({ok:true,value:{revision:id(8),fingerprint:'b'.repeat(64),changes:[],changesUnrestrictedScope:false}});
  await waitFor(()=>expect(screen.queryByText('Preparing access preview…')).toBeNull());
  expect(screen.queryByRole('button',{name:'Confirm access change'})).toBeNull();expect(f.save).not.toHaveBeenCalled();
 });
 it('clears a finished preview when scope changes and explains role-derived membership',async()=>{
  const f=fixture();f.chooseReaders();fireEvent.change(screen.getByRole('textbox',{name:'Group name'}),{target:{value:'New readers'}});
  fireEvent.click(screen.getByRole('button',{name:'Preview name change'}));await screen.findByRole('button',{name:'Confirm access change'});
  fireEvent.change(screen.getByRole('combobox',{name:'Company scope'}),{target:{value:companyB}});
  expect(screen.queryByRole('button',{name:'Confirm access change'})).toBeNull();
  fireEvent.change(screen.getByRole('combobox',{name:'Company scope'}),{target:{value:companyA}});
  fireEvent.change(screen.getByRole('combobox',{name:'User'}),{target:{value:worker}});
  expect(screen.getByText(/This membership comes from Users & roles/)).toBeTruthy();
  expect(screen.queryByRole('button',{name:'Preview removing membership'})).toBeNull();
 });
 it('confirms the exact preview once and leaves stale-save errors visible for a reload',async()=>{
  const f=fixture();let resolve!:(value:AccessEditorResult<{revision:string}>)=>void;
  f.save.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));f.chooseReaders();
  fireEvent.change(screen.getByRole('textbox',{name:'Group name'}),{target:{value:'New readers'}});fireEvent.click(screen.getByRole('button',{name:'Preview name change'}));
  const confirm=await screen.findByRole('button',{name:'Confirm access change'});fireEvent.click(confirm);fireEvent.click(confirm);
  expect(f.save).toHaveBeenCalledTimes(1);expect(f.save.mock.calls[0][0]).toEqual({expectedRevision:id(8),command:{kind:'renameGroup',groupId:readers,name:'New readers'},previewFingerprint:'b'.repeat(64)});
  resolve({ok:false,code:'changed'});await screen.findByRole('alert');expect(screen.getByRole('button',{name:'Reload access'})).toBeTruthy();expect(screen.queryByRole('button',{name:'Confirm access change'})).toBeNull();
 });
 it('resets private drafts when the actor or fresh scope fingerprint changes',async()=>{
  const f=fixture();f.chooseReaders();fireEvent.change(screen.getByRole('textbox',{name:'Group name'}),{target:{value:'Private unsaved draft'}});fireEvent.click(screen.getByRole('button',{name:'Preview name change'}));await screen.findByRole('button',{name:'Confirm access change'});
  f.view.rerender(f.tree({...f.props,scopeFingerprint:'c'.repeat(64)}));expect(screen.queryByRole('button',{name:'Confirm access change'})).toBeNull();expect(screen.queryByDisplayValue('Private unsaved draft')).toBeNull();
 });
});
