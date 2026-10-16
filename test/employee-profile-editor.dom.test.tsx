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
vi.mock('../app/me/profile-edit-actions',()=>({saveMyProfileEditAction:mocks.save,readMyProfileMovementAction:mocks.history}));
import {ProfileEditor} from '../app/me/profile-editor';
const phone='profile.contact_and_permanent_address.phone',preferred='profile.personal_details.preferredname',familyName='family.family_and_dependents.fullname',bankAccount='bank_statutory.bank_information.bankaccountno';
const recordId='00000000-0000-4000-8000-000000000002';
function workspace():EssWorkspace{return {employmentId:'00000000-0000-4000-8000-000000000001',personId:recordId,country:'MY',values:{[phone]:'0110000000',[preferred]:'Recorded name',[bankAccount]:'•••• 1234'},baselines:{[phone]:'phone-proof',[preferred]:'name-proof',[bankAccount]:'bank-proof'},registers:[{kind:'dependent',id:recordId,primary:false,values:{[familyName]:'Recorded child'},baselines:{[familyName]:'child-proof'}}],editable:[phone,preferred,familyName,bankAccount],legacyPrimaryEditable:[],addressReview:false,legacyAddress:{},statutoryAvailable:true};}
const facts:Awaited<ReturnType<typeof readOwnProfileFacts>>={values:{},records:[],choices:{},service:{group:{years:1,months:0,days:0},company:{years:1,months:0,days:0}},header:{name:'Fictional employee',employeeCode:'SYNTH',company:'Fictional company',department:null,position:null,superior:null,status:'active',photo:false,service:{years:1,months:0,days:0}},modules:{payroll:true,leave:true,attendance:true}};
const catalogues={en,ms,zh,ta,th,vi:viMessages};
function mount(locale:keyof typeof catalogues='en',view=workspace(),onError=(error:unknown)=>{throw error;}){return render(<NextIntlClientProvider locale={locale} messages={catalogues[locale]} onError={onError}><ProfileEditor workspace={view} facts={facts} extraPanels={{}} history={[]}/></NextIntlClientProvider>);}
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
});
