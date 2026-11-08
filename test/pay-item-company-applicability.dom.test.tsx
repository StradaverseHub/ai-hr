import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { CompanyApplicability } from '../app/admin/pay-components/company-applicability';
import en from '../messages/en.json';
const companies=[{id:'a',name:'Alpha Company'},{id:'b',name:'Beta Company'}];
const ui=(canEdit=true,initialIds:string[]|null=null)=><NextIntlClientProvider locale="en" messages={en}><form aria-label="Pay Item"><CompanyApplicability companies={companies} initialIds={initialIds} canEdit={canEdit}/></form></NextIntlClientProvider>;
afterEach(cleanup);
describe('Applied for Company control',()=>{
 it('keeps a selected company in the submission when a search temporarily hides its checkbox',()=>{
  render(ui());expect(screen.getByRole('combobox')).toHaveValue('all');
  fireEvent.change(screen.getByRole('combobox'),{target:{value:'selected'}});
  fireEvent.click(screen.getByRole('checkbox',{name:'Alpha Company'}));
  fireEvent.change(screen.getByRole('searchbox'),{target:{value:'Beta'}});
  expect(screen.queryByRole('checkbox',{name:'Alpha Company'})).toBeNull();
  const form=screen.getByRole('form') as HTMLFormElement;
  expect(new FormData(form).getAll('appliedCompanyIds')).toEqual(['a']);
  fireEvent.change(screen.getByRole('combobox'),{target:{value:'all'}});
  expect(new FormData(form).get('appliedCompanyMode')).toBe('all');
  expect(new FormData(form).getAll('appliedCompanyIds')).toEqual([]);
 });
 it('omits applicability from a partial administrator save while showing the saved selection',()=>{
  render(ui(false,['b']));expect(screen.getByRole('combobox')).toBeDisabled();
  expect(screen.getByRole('checkbox',{name:'Beta Company'})).toBeChecked();
  expect(new FormData(screen.getByRole('form') as HTMLFormElement).has('appliedCompanyMode')).toBe(false);
 });
});
