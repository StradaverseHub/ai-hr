import {afterEach,describe,expect,it} from 'vitest';
import {cleanup,fireEvent,render} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {IdentityTaxCard} from '../components/identity-tax-card';
afterEach(cleanup);
function view(scheme:string,confirmationRequired:boolean,companyId='synthetic-company',version=1){
 return <NextIntlClientProvider locale="en" messages={en}><IdentityTaxCard embedded action={()=>{}} employmentId="synthetic-employment" personId="synthetic-person" taxSelection={{companyId,companyName:'Synthetic employer',version,confirmationRequired}} defaults={{taxNumber:null,taxCategory:1,taxResidency:scheme,numChildren:0,childReliefMode:'manual',employerBearsTax:false,disabledIndividual:false,disabledSpouse:false,childReliefTable:null}}/></NextIntlClientProvider>;
}
function card(scheme:string,confirmationRequired:boolean){
 const rendered=render(view(scheme,confirmationRequired));
 return {...rendered,select:rendered.container.querySelector<HTMLSelectElement>('select[name="taxResidency"]')!,form:rendered.container.querySelector<HTMLFormElement>('form')!};
}
describe('Personnel requires an explicit category for unresolved employer contexts',()=>{
 it.each(['resident','non_resident','rep','knowledge_worker','c_suite','unsupported',''])('unresolved %s starts empty and invalid until HR makes one category choice',scheme=>{
  const {select,form}=card(scheme,true);
  expect(select.value).toBe('');expect(select.required).toBe(true);expect(select.checkValidity()).toBe(false);
  expect(select.selectedOptions[0].disabled).toBe(true);expect(select.selectedOptions[0].textContent).toBe(en.people.detail.taxSelectionChoose);
  expect(String(new FormData(form).get('taxResidency')??'')).toBe('');
  fireEvent.change(select,{target:{value:'knowledge_worker'}});
  expect(select.checkValidity()).toBe(true);expect(new FormData(form).get('taxResidency')).toBe('knowledge_worker');
 });
 it.each(['resident','non_resident','rep','knowledge_worker','c_suite'])('resolved %s retains its authoritative category',scheme=>{
  const {select,form}=card(scheme,false);
  expect(select.value).toBe(scheme);expect(select.checkValidity()).toBe(true);expect(new FormData(form).get('taxResidency')).toBe(scheme);
 });
 it.each(['company','version','confirmation'] as const)('changed %s context resets a prior incentive draft alongside hidden scope',change=>{
  const {rerender,container,select,form}=card('rep',false);
  fireEvent.change(select,{target:{value:'c_suite'}});
  fireEvent.change(container.querySelector<HTMLInputElement>('input[name="taxNumber"]')!,{target:{value:'Keep unrelated draft'}});
  // A refresh of the SAME owner must preserve an unsaved selection and unrelated field edits.
  rerender(view('rep',false));
  expect(container.querySelector('select[name="taxResidency"]')).toBe(select);
  expect(select.value).toBe('c_suite');
  expect(new FormData(form).get('taxNumber')).toBe('Keep unrelated draft');
  const companyId=change==='company'?'new-company':'synthetic-company';
  const version=change==='version'?2:1;
  const confirmation=change==='confirmation';
  rerender(view('rep',confirmation,companyId,version));
  const next=container.querySelector<HTMLSelectElement>('select[name="taxResidency"]')!;
  expect(next).not.toBe(select);expect(next.value).toBe(confirmation?'':'rep');expect(next.checkValidity()).toBe(!confirmation);
  const payload=new FormData(form);
  expect(payload.get('expectedTaxCompanyId')).toBe(companyId);expect(payload.get('expectedTaxSelectionVersion')).toBe(String(version));
  expect(String(payload.get('taxResidency')??'')).toBe(confirmation?'':'rep');
  fireEvent.change(next,{target:{value:'non_resident'}});
  expect(next.checkValidity()).toBe(true);expect(new FormData(form).get('taxResidency')).toBe('non_resident');
 });
 it('a new resolved revision resets the draft to its authoritative selection',()=>{
  const {rerender,container,select}=card('rep',false);fireEvent.change(select,{target:{value:'c_suite'}});
  rerender(view('knowledge_worker',false,'synthetic-company',2));
  const next=container.querySelector<HTMLSelectElement>('select[name="taxResidency"]')!;
  expect(next).not.toBe(select);expect(next.value).toBe('knowledge_worker');expect(next.checkValidity()).toBe(true);
 });
 it.each(['unsupported',''])('invalid resolved default %s also requires a real category choice',scheme=>{
  const {select}=card(scheme,false);expect(select.value).toBe('');expect(select.checkValidity()).toBe(false);
 });
});
