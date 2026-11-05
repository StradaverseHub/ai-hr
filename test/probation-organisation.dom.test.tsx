import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {ScopeFields} from '../app/lifecycle/probation/scope-fields';
import type {ProbationAdministrationOptions} from '../core/probation';
const legacy={businessGroups:[{id:'company-parent',name:'Fictional parent company'}],businessUnits:[{id:'pm-unit',name:'Fictional Personnel Unit',companyId:'employer'}]},next={businessGroups:[{id:'pm-unit',name:'Fictional Personnel Unit'}],businessUnits:[{id:'employer',name:'Fictional Employer',companyId:'employer'}]};
const options:ProbationAdministrationOptions={...next,organisationMapping:'personnel-v2',organisationCatalogs:{'legacy-v1':legacy,'personnel-v2':next},personnelBusinessUnits:legacy.businessUnits,companies:[{id:'employer',name:'Fictional Employer'}],users:[],departments:[],grades:[]};
afterEach(cleanup);
describe('version-pinned Probation rule selectors',()=>{
 it('keeps an untagged historical rule on the legacy identity catalog even after the tenant switches',()=>{
  render(<NextIntlClientProvider locale="en" messages={en}><ScopeFields value={{businessGroupId:'company-parent',businessUnitId:'pm-unit'}} options={options} companyId="employer" disabled={false} change={vi.fn()}/></NextIntlClientProvider>);
  const group=screen.getByRole('combobox',{name:en.probation.facts.businessGroup}),unit=screen.getByRole('combobox',{name:en.probation.facts.businessUnit});
  expect(group).toHaveValue('company-parent');expect(within(group).getByRole('option',{name:'Fictional parent company'})).toBeTruthy();
  expect(unit).toHaveValue('pm-unit');expect(within(unit).queryByRole('option',{name:'Fictional Employer'})).toBeNull();
 });
 it('writes Personnel BU identity for new Business group and Company identity for new Business unit',()=>{
  const change=vi.fn();render(<NextIntlClientProvider locale="en" messages={en}><ScopeFields organisationMapping="personnel-v2" value={{}} options={options} companyId="employer" disabled={false} change={change}/></NextIntlClientProvider>);
  const group=screen.getByRole('combobox',{name:en.probation.facts.businessGroup}),unit=screen.getByRole('combobox',{name:en.probation.facts.businessUnit});
  fireEvent.change(group,{target:{value:'pm-unit'}});expect(change).toHaveBeenLastCalledWith({businessGroupId:'pm-unit'});
  fireEvent.change(unit,{target:{value:'employer'}});expect(change).toHaveBeenLastCalledWith({businessUnitId:'employer'});
  expect(within(group).queryByRole('option',{name:'Fictional parent company'})).toBeNull();
 });
 it('retains a saved retired identity as an explicit saved selection rather than silently clearing it',()=>{
  render(<NextIntlClientProvider locale="en" messages={en}><ScopeFields organisationMapping="personnel-v2" value={{businessGroupId:'retained-group',businessUnitId:'retained-company'}} options={options} companyId="employer" disabled={true} change={vi.fn()}/></NextIntlClientProvider>);
  expect(screen.getByRole('combobox',{name:en.probation.facts.businessGroup})).toHaveValue('retained-group');expect(screen.getByRole('combobox',{name:en.probation.facts.businessUnit})).toHaveValue('retained-company');
 });
});
