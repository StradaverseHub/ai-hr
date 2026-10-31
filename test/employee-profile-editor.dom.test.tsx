import React from 'react';
import {beforeEach,describe,it,expect,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import viMessages from '../messages/vi.json';
import type {EssWorkspace} from '../core/profile-edit';
import type {readOwnProfileFacts} from '../core/profile-view';
import {personnelField} from '../lib/personnel-field-registry';
import {__resetUnsavedGuards} from '../lib/unsaved-changes';
const mocks=vi.hoisted(()=>({save:vi.fn(),history:vi.fn(),refresh:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:mocks.refresh})}));
vi.mock('../app/(app)/me/profile-edit-actions',()=>({saveMyProfileEditAction:mocks.save,readMyProfileMovementAction:mocks.history}));
import {ProfileEditor} from '../app/(app)/me/profile-editor';
const phone='profile.contact_and_permanent_address.phone',preferred='profile.personal_details.preferredname',familyName='family.family_and_dependents.fullname',bankAccount='bank_statutory.bank_information.bankaccountno';
const recordId='00000000-0000-4000-8000-000000000002';
function workspace():EssWorkspace{return {employmentId:'00000000-0000-4000-8000-000000000001',personId:recordId,country:'MY',values:{[phone]:'0110000000',[preferred]:'Recorded name',[bankAccount]:'•••• 1234'},baselines:{[phone]:'phone-proof',[preferred]:'name-proof',[bankAccount]:'bank-proof'},registers:[{kind:'dependent',id:recordId,primary:false,values:{[familyName]:'Recorded child'},baselines:{[familyName]:'child-proof'}}],editable:[phone,preferred,familyName,bankAccount],legacyPrimaryEditable:[],addressReview:false,legacyAddress:{},statutoryAvailable:true};}
const facts:Awaited<ReturnType<typeof readOwnProfileFacts>>={values:{},records:[],choices:{},service:{group:{years:1,months:0,days:0},company:{years:1,months:0,days:0}},header:{name:'Fictional employee',employeeCode:'SYNTH',company:'Fictional company',department:null,position:null,superior:null,status:'active',photo:false,service:{years:1,months:0,days:0}},modules:{payroll:true,leave:true,attendance:true}};
const catalogues={en,ms,zh,ta,th,vi:viMessages};
function mount(locale:keyof typeof catalogues='en',view=workspace(),onError:(error:unknown)=>void=(error:unknown)=>{throw error;}){return render(<NextIntlClientProvider locale={locale} messages={catalogues[locale]} onError={onError}><ProfileEditor workspace={view} facts={facts} extraPanels={{}} history={[]}/></NextIntlClientProvider>);}
function panel(tab:keyof typeof en.people.detail.tabs){fireEvent.click(screen.getByRole('tab',{name:en.people.detail.tabs[tab]}));return screen.getByRole('tabpanel',{name:en.people.detail.tabs[tab]});}
beforeEach(()=>{cleanup();__resetUnsavedGuards();vi.clearAllMocks();mocks.save.mockResolvedValue({ok:true,value:{saved:[phone],waiting:[familyName],requestId:recordId}});});
describe('My Profile single cross-tab editor',()=>{
 it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('renders all eleven canonical tabs and the single edit course in %s',locale=>{
  const errors:unknown[]=[];mount(locale,workspace(),error=>errors.push(error));
  const words=catalogues[locale];expect(screen.getAllByRole('tab')).toHaveLength(11);for(const key of ['profile','family','job','careerMovement','attendance','bankStatutory','payroll','leave','documents','qualification','others'] as const)expect(screen.getByRole('tab',{name:words.people.detail.tabs[key]})).toBeTruthy();
  expect(screen.getByRole('button',{name:words.essProfile.requestEdit})).toBeTruthy();expect(errors).toEqual([]);expect(screen.queryByText(words.people.detail.emergency.remarks)).toBeNull();
 });
 it('submits only touched fields across tabs with the exact captured register ID and baselines',async()=>{
  mount();fireEvent.click(screen.getByRole('button',{name:en.essProfile.requestEdit}));
  fireEvent.change(within(panel('profile')).getByLabelText(en.people.detail.phone),{target:{value:'0120000000'}});
  fireEvent.change(within(panel('family')).getByLabelText(en.people.detail.family.name),{target:{value:'Changed child'}});
  fireEvent.click(screen.getByRole('button',{name:en.essProfile.save}));
  await waitFor(()=>expect(mocks.save).toHaveBeenCalledTimes(1));
  expect(mocks.save.mock.calls[0][0]).toEqual({employmentId:workspace().employmentId,proposal:{v:2,fields:[{fieldId:phone,before:'phone-proof',value:'0120000000'}],registers:[{kind:'dependent',id:recordId,clientId:recordId,fields:[{fieldId:familyName,before:'child-proof',value:'Changed child'}]}]}});
  await waitFor(()=>expect(mocks.refresh).toHaveBeenCalledTimes(1));
 });
 it('cancel and a no-op save call no mutation owner, while a failed save retains entered input',async()=>{
  mount();fireEvent.click(screen.getByRole('button',{name:en.essProfile.requestEdit}));fireEvent.click(screen.getByRole('button',{name:en.essProfile.save}));expect(mocks.save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:en.essProfile.requestEdit}));fireEvent.change(within(panel('profile')).getByLabelText(en.people.detail.preferredName),{target:{value:'Unsaved fixture'}});fireEvent.click(screen.getByRole('button',{name:en.essProfile.cancel}));expect(mocks.save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:en.essProfile.requestEdit}));const input=within(panel('profile')).getByLabelText(en.people.detail.preferredName);expect(input).toHaveValue('Recorded name');fireEvent.change(input,{target:{value:'Retained fixture'}});
  mocks.save.mockResolvedValueOnce({ok:false,code:'stale',fieldIds:[preferred]});fireEvent.click(screen.getByRole('button',{name:en.essProfile.save}));await waitFor(()=>expect(screen.getByRole('alert')).toBeTruthy());expect(input).toHaveValue('Retained fixture');expect(mocks.refresh).not.toHaveBeenCalled();
 });
 it('does not submit masked values as replacements and blocks repeat clicks during an unresolved save',async()=>{
  mount();fireEvent.click(screen.getByRole('button',{name:en.essProfile.requestEdit}));const input=within(panel('bankStatutory')).getByLabelText(en.people.detail.bankAccount);expect(input).toHaveValue('');expect(input).toHaveAttribute('placeholder','•••• 1234');
  fireEvent.change(input,{target:{value:'9876543210'}});let finish:(value:unknown)=>void=()=>{};mocks.save.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));const save=screen.getByRole('button',{name:en.essProfile.save});fireEvent.click(save);fireEvent.click(save);expect(mocks.save).toHaveBeenCalledTimes(1);expect(mocks.save.mock.calls[0][0].proposal.fields).toEqual([{fieldId:bankAccount,before:'bank-proof',value:'9876543210'}]);finish({ok:false,code:'stale',fieldIds:[bankAccount]});await waitFor(()=>expect(screen.getByRole('alert')).toBeTruthy());
 });
 it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('shows disabled blank custom-holder fields without change warnings in read-only or untouched edit mode in %s',locale=>{
  const view=workspace(),words=catalogues[locale];
  for(const [field,flag]of [['customHolderName','enableCustomHolderName'],['customHolderId','enableCustomHolderId']]as const){
   const id=`bank_statutory.bank_information.${field.toLowerCase()}`,flagId=`bank_statutory.bank_information.${flag.toLowerCase()}`;
   view.values[id]=null;view.values[flagId]=false;view.baselines[id]='holder-proof';view.baselines[flagId]='flag-proof';view.editable.push(id,flagId);
  }
  mount(locale,view);fireEvent.click(screen.getByRole('tab',{name:words.people.detail.tabs.bankStatutory}));const tab=screen.getByRole('tabpanel',{name:words.people.detail.tabs.bankStatutory});
  expect(within(tab).getByText(words.people.detail.customHolderName)).toBeTruthy();expect(within(tab).getByText(words.people.detail.customHolderId)).toBeTruthy();
  expect(within(tab).queryAllByText(words.essProfile.bankNotApplicable)).toHaveLength(0);
  fireEvent.click(screen.getByRole('button',{name:words.essProfile.requestEdit}));
  expect(within(tab).getByLabelText(words.people.detail.enableCustomHolderName)).toHaveValue('false');expect(within(tab).getByLabelText(words.people.detail.enableCustomHolderId)).toHaveValue('false');
  expect(within(tab).queryByLabelText(words.people.detail.customHolderName)).toBeNull();expect(within(tab).queryByLabelText(words.people.detail.customHolderId)).toBeNull();
  expect(within(tab).queryAllByText(words.essProfile.bankNotApplicable)).toHaveLength(0);expect(mocks.save).not.toHaveBeenCalled();
 });
 it.each([['customHolderName','enableCustomHolderName'],['customHolderId','enableCustomHolderId']] as const)('makes %s editable only for its effective enabled switch and retains a touched value after disabling',async(field,flag)=>{
  const id=`bank_statutory.bank_information.${field.toLowerCase()}`,flagId=`bank_statutory.bank_information.${flag.toLowerCase()}`,view=workspace();view.values[id]=null;view.values[flagId]=false;view.baselines[id]='holder-proof';view.baselines[flagId]='flag-proof';view.editable.push(id,flagId);
  mount('en',view);fireEvent.click(screen.getByRole('button',{name:en.essProfile.requestEdit}));const tab=panel('bankStatutory');
  expect(within(tab).queryByLabelText(en.people.detail[field])).toBeNull();expect(within(tab).queryAllByText(en.essProfile.bankNotApplicable)).toHaveLength(0);
  const toggle=within(tab).getByLabelText(en.people.detail[flag]);fireEvent.change(toggle,{target:{value:'true'}});fireEvent.change(within(tab).getByLabelText(en.people.detail[field]),{target:{value:'Entered holder'}});
  fireEvent.change(toggle,{target:{value:'false'}});expect(within(tab).queryByLabelText(en.people.detail[field])).toBeNull();expect(within(tab).getByText('Entered holder')).toBeTruthy();expect(within(tab).getAllByText(en.essProfile.bankNotApplicable)).toHaveLength(1);
  mocks.save.mockResolvedValueOnce({ok:false,code:'invalid',fieldIds:[id]});fireEvent.click(screen.getByRole('button',{name:en.essProfile.save}));await waitFor(()=>expect(mocks.save).toHaveBeenCalledTimes(1));
  expect(mocks.save.mock.calls[0][0].proposal.fields).toEqual([{fieldId:id,before:'holder-proof',value:'Entered holder'}]);expect(within(tab).getByText('Entered holder')).toBeTruthy();
  fireEvent.change(toggle,{target:{value:'true'}});expect(within(tab).getByLabelText(en.people.detail[field])).toHaveValue('Entered holder');expect(within(tab).queryAllByText(en.essProfile.bankNotApplicable)).toHaveLength(0);
  fireEvent.change(toggle,{target:{value:'false'}});const retained=within(tab).getByText('Entered holder').parentElement;expect(retained).not.toBeNull();fireEvent.click(within(retained!).getByRole('button',{name:en.essProfile.undo}));expect(within(tab).queryByText('Entered holder')).toBeNull();expect(within(tab).queryAllByText(en.essProfile.bankNotApplicable)).toHaveLength(0);
 });
 it('shows a saved None tax circumstance with an explanation and no numeric category edit',()=>{
  const view=workspace(),id='bank_statutory.income_tax_pcb.taxcategory';view.values[id]=2;view.values['bank_statutory.income_tax_pcb.taxcircumstance']='none';view.editable.push(id);
  mount('en',view);fireEvent.click(screen.getByRole('button',{name:en.essProfile.requestEdit}));const tab=panel('bankStatutory');expect(within(tab).queryByLabelText(en.people.detail.taxCategoryNumeric)).toBeNull();expect(within(tab).getByText(en.essProfile.taxNotApplicable)).toBeTruthy();
 });
 it('takes a changed canonical choice owner from the same shared vocabulary as Personnel',()=>{
  const field=personnelField(preferred)!,before={type:field.type,allowedValuesOwner:field.allowedValuesOwner};
  try{Object.assign(field,{type:'choice',allowedValuesOwner:'person.gender'});mount();fireEvent.click(screen.getByRole('button',{name:en.essProfile.requestEdit}));const select=within(panel('profile')).getByLabelText(en.people.detail.preferredName);const options=within(select).getAllByRole('option').map(option=>(option as HTMLOptionElement).value);expect(options).toContain('male');expect(options).toContain('female');expect(options).toContain('undisclosed');}
  finally{Object.assign(field,before);}
 });
 it('keeps View Only visible with no editable control and consumes changed canonical label/type/required metadata',()=>{
  const field=personnelField(preferred)!;const before={label:field.label,labelKey:field.labelKey,type:field.type,form:field.form};
  try{Object.assign(field,{label:'Canonical changed label',labelKey:'',type:'number',form:{...field.form,required:{record:true}}});mount();fireEvent.click(screen.getByRole('button',{name:en.essProfile.requestEdit}));const input=within(panel('profile')).getByLabelText('Canonical changed label');expect(input).toHaveAttribute('type','number');expect(input).toHaveAttribute('aria-required','true');cleanup();const view=workspace();view.editable=[];mount('en',view);expect(screen.getByRole('button',{name:en.essProfile.requestEdit})).toBeDisabled();expect(screen.queryByLabelText('Canonical changed label')).toBeNull();}
  finally{Object.assign(field,before);}
 });
 it('keeps an automatic qualifying-child count read-only even when the administrator permits the field',()=>{
  const id='bank_statutory.income_tax_pcb.numchildren',view=workspace();view.values[id]=3;view.baselines[id]='stored-count-proof';view.editable.push(id);view.fieldReadOnlyReasons={[id]:'derivedChildCount'};
  mount('en',view);fireEvent.click(screen.getByRole('button',{name:en.essProfile.requestEdit}));const tab=panel('bankStatutory');
  expect(within(tab).queryByLabelText(en.people.detail.childrenPhysical)).toBeNull();expect(within(tab).getByText('3')).toBeTruthy();expect(within(tab).getByText(en.essProfile.childCountDerived)).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:en.essProfile.save}));expect(mocks.save).not.toHaveBeenCalled();
 });

});

it('omits explicitly hidden tabs and their supplied panels rather than keeping private markup mounted',()=>{
 const view=workspace();view.visible=[];view.editable=[];view.legacyPrimaryEditable=[];
 render(<NextIntlClientProvider locale="en" messages={en}><ProfileEditor workspace={view} facts={facts} hiddenTabs={['Profile','Payroll']} defaultTab="profile" extraPanels={{profile:<p>PRIVATE PROFILE PANEL</p>,payroll:<p>PRIVATE PAY PANEL</p>}} history={[]}/></NextIntlClientProvider>);
 expect(screen.queryByRole('tab',{name:en.people.detail.tabs.profile})).toBeNull();expect(screen.queryByRole('tab',{name:en.people.detail.tabs.payroll})).toBeNull();
 expect(document.body.textContent).not.toContain('PRIVATE PROFILE PANEL');expect(document.body.textContent).not.toContain('PRIVATE PAY PANEL');expect(screen.getByRole('tab',{name:en.people.detail.tabs.family})).toHaveAttribute('aria-selected','true');
});
