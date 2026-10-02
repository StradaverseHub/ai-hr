import {afterEach,describe,expect,it} from 'vitest';
import {cleanup,fireEvent,render} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {IdentityTaxCard} from '../components/identity-tax-card';
afterEach(cleanup);
function card(scheme:string,confirmationRequired:boolean){
 const rendered=render(<NextIntlClientProvider locale="en" messages={en}><IdentityTaxCard embedded action={()=>{}} employmentId="synthetic-employment" personId="synthetic-person" taxSelection={{companyId:'synthetic-company',companyName:'Synthetic employer',version:1,confirmationRequired}} defaults={{taxNumber:null,taxCategory:1,taxResidency:scheme,numChildren:0,childReliefMode:'manual',employerBearsTax:false,disabledIndividual:false,disabledSpouse:false,childReliefTable:null}}/></NextIntlClientProvider>);
 return {select:rendered.container.querySelector<HTMLSelectElement>('select[name="taxResidency"]')!,form:rendered.container.querySelector<HTMLFormElement>('form')!};
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
 it.each(['unsupported',''])('invalid resolved default %s also requires a real category choice',scheme=>{
  const {select}=card(scheme,false);expect(select.value).toBe('');expect(select.checkValidity()).toBe(false);
 });
});
