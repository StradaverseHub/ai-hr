// @vitest-environment jsdom
import {describe,expect,it} from 'vitest';
import {render,screen,fireEvent,cleanup} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {TaxCategoryField} from '../components/tax-category-field';
import {IdentityTaxCard} from '../components/identity-tax-card';
import {afterEach} from 'vitest';
afterEach(cleanup);
const wrapper=(children:React.ReactNode)=><NextIntlClientProvider locale="en" messages={en}>{children}</NextIntlClientProvider>;
describe('r385 saved circumstance controls',()=>{
 it('widow reload selects its own token and posts existing Category3 separately',()=>{
  const {container}=render(wrapper(<form><TaxCategoryField mode="form" defaultValue={3} circumstance="widow_divorced"/></form>));
  const select=screen.getByRole('combobox',{name:'Tax Category'}) as HTMLSelectElement;
  expect(select.value).toBe('widow_divorced');const data=new FormData(container.querySelector('form')!);
  expect(data.get('taxCategory')).toBe('3');expect(data.get('taxCircumstance')).toBe('widow_divorced');
  fireEvent.change(select,{target:{value:'spouse_working'}});expect(new FormData(container.querySelector('form')!).get('taxCircumstance')).toBe('spouse_working');
 });
 it('None disables residency but submits intentional None; returning taxable makes the existing field available without resurrecting REP',()=>{
  const {container}=render(wrapper(<IdentityTaxCard action={async()=>{}} employmentId="synthetic" personId="synthetic-person" taxSelection={{companyId:'synthetic-company',companyName:'Synthetic',version:1,confirmationRequired:false}} defaults={{taxNumber:null,taxCategory:3,taxCircumstance:'widow_divorced',taxResidency:'rep',numChildren:0,childReliefMode:'manual',employerBearsTax:false,disabledIndividual:false,disabledSpouse:false,childReliefTable:null}}/>));
  const select=screen.getByRole('combobox',{name:'Tax Category'});fireEvent.change(select,{target:{value:'none'}});
  const resident=screen.getByRole('combobox',{name:'Income Tax Resident'}) as HTMLSelectElement;
  expect(resident.disabled).toBe(true);expect(resident.value).toBe('none');expect(new FormData(container.querySelector('form')!).get('taxResidency')).toBe('none');
  fireEvent.change(select,{target:{value:'spouse_working'}});expect(resident.disabled).toBe(false);expect(resident.value).toBe('');expect(resident.required).toBe(true);
 });
});
