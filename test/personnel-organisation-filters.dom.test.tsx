import {afterEach,expect,it} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import viMessages from '../messages/vi.json';
import {PersonnelOrganisationFilters,PersonnelPrivateSearch} from '../app/admin/personnel/organisation-filters';
import {EmployeeRow} from '../app/admin/personnel/employee-row';
import {FilterChips,type FilterField} from '../components/filter-panel';
import {aiReviewDomHtml,captureAiReviewScreenshots} from './helpers/ai-review-screenshots';
const catalogues={en,ms,zh,ta,th,vi:viMessages};
afterEach(cleanup);
const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222',c='33333333-3333-4333-8333-333333333333';
it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('%s renders one private employee search, scoped three-level company tree, removable chips and full BU names',async locale=>{
 const messages=catalogues[locale],copy=messages.personnelOrganisationFilters,base=messages.people.list;
 const longUnit=copy.businessUnit+' · Fictional shared manufacturing and property services organisation';
 const companies=[{id:a,name:'Fictional Company One',parentCompanyId:'root',parentCompany:'Fictional Group',businessGroupId:'root',businessGroup:'Fictional Group',businessUnitId:'unit',businessUnit:longUnit},{id:b,name:'Fictional Company Two',parentCompanyId:'root',parentCompany:'Fictional Group',businessGroupId:'root',businessGroup:'Fictional Group',businessUnitId:'unit',businessUnit:longUnit},{id:c,name:'Fictional Other Group Company',parentCompanyId:null,parentCompany:null,businessGroupId:'other',businessGroup:'Fictional Other Group',businessUnitId:null,businessUnit:null}];
 const multi=(name:string,label:string,options:{value:string;label:string}[]):FilterField=>({kind:'multi',name,label,ariaLabel:label,options,removeAriaLabel:base.removeFilter.replace('{label}',label)});
 const fields:FilterField[]=[multi('companies',base.company,companies.map(company=>({value:company.id,label:company.name}))),multi('bu',copy.businessUnit,[{value:'unit',label:longUnit}]),multi('grade',copy.jobGrade,[{value:'H',label:'H'},{value:'12',label:'12'}]),multi('quality',copy.quality,[{value:'missing_business_unit',label:copy.missing_business_unit},{value:'missing_job_grade',label:copy.missing_job_grade},{value:'company_not_in_structure',label:copy.company_not_in_structure}]),{kind:'date',name:'joinedFrom',label:copy.joinedFrom,ariaLabel:copy.joinedFrom,removeAriaLabel:copy.joinedFrom}];
 const values={companies:[a],grade:['12'],joinedFrom:'2026-01-01'},labels={filter:base.filter,apply:base.applyFilters,clearAll:base.clearAllFilters,activeCount:'3',selectAll:copy.selectAll,deselectAll:copy.deselectAll};
 const view=render(<NextIntlClientProvider locale={locale} messages={messages}><main className="min-w-0 space-y-4"><h1 className="text-xl font-semibold">{base.title}</h1><PersonnelPrivateSearch parameters={[["companies",a],["grade","12"],["search",'x'.repeat(43)]]} active labels={{label:copy.search,placeholder:copy.searchPlaceholder,submit:copy.searchButton,privateHint:copy.privateHint,active:copy.privateActive,clear:copy.clearSearch,share:copy.shareView}}/><div className="flex justify-end"><PersonnelOrganisationFilters fields={fields} values={values} companies={companies} labels={labels} companySearchLabel={copy.companySearch} duplicateHint={copy.duplicateHint} canInspectDuplicates/></div><FilterChips action="/admin/personnel" fields={fields} values={values} labels={labels}/><div className="overflow-x-auto"><table className="w-full"><tbody><EmployeeRow employmentId="fixture" name="Fictional employee" status="active" statusLabel="Active" columns={['name','businessUnit']} text={{businessUnit:longUnit}}/></tbody></table></div></main></NextIntlClientProvider>);
 expect(view.container.querySelectorAll('input[name="term"]')).toHaveLength(1);expect(view.container.querySelector('form[action="/admin/personnel/search"]')).toHaveAttribute('method','post');
 fireEvent.change(screen.getByRole('searchbox',{name:copy.search}),{target:{value:'FICTIONAL-PASSPORT-123'}});expect(screen.getByRole('link',{name:copy.shareView}).getAttribute('href')).not.toContain('PASSPORT');expect(screen.getByRole('link',{name:copy.shareView}).getAttribute('href')).not.toContain('search=');
 await captureAiReviewScreenshots(aiReviewDomHtml(view.container),locale,'personnel-organisation-results','Actual Personnel private-search and full Business Unit cell components; fictional records; no authenticated staging acceptance','atelier');
 fireEvent.click(screen.getByText(base.filter));await waitFor(()=>expect(document.querySelector('form[action="/admin/personnel"]')).not.toBeNull());
 const form=document.querySelector<HTMLFormElement>('form[action="/admin/personnel"]')!,group=form.querySelector<HTMLDetailsElement>('[data-company-group="root"]')!;group.open=true;
 fireEvent.click(within(group).getByRole('button',{name:copy.selectAll}));expect(new FormData(form).getAll('companies').sort()).toEqual([a,b]);
 fireEvent.change(screen.getByRole('searchbox',{name:copy.companySearch}),{target:{value:'Company One'}});expect(new FormData(form).getAll('companies').sort()).toEqual([a,b]);
 fireEvent.change(screen.getByRole('searchbox',{name:copy.companySearch}),{target:{value:''}});
 for(const details of form.querySelectorAll('details'))details.open=true;
 expect(screen.getByText(longUnit,{selector:'span[title]'})).toHaveAttribute('title',longUnit);
 await captureAiReviewScreenshots(aiReviewDomHtml(document.body),locale,'personnel-organisation-filters','Actual Personnel filter/search/row components; fictional scoped companies and employee; no authenticated staging acceptance','atelier');
},120000);

it('keeps a denied duplicate filter fail-closed while offering no unapproved evidence control',async()=>{
 const copy=en.personnelOrganisationFilters,field:FilterField={kind:'multi',name:'quality',label:copy.quality,ariaLabel:copy.quality,options:[{value:'suspected_duplicate',label:copy.suspected_duplicate}],removeAriaLabel:copy.quality};
 const view=render(<NextIntlClientProvider locale="en" messages={en}><PersonnelOrganisationFilters fields={[field]} values={{quality:['suspected_duplicate']}} companies={[]} labels={{filter:'Filter',apply:'Apply',clearAll:'Clear all',activeCount:'1'}} companySearchLabel="Companies" duplicateHint={copy.duplicateUnavailable} canInspectDuplicates={false}/></NextIntlClientProvider>);
 fireEvent.click(screen.getByText('Filter'));await waitFor(()=>expect(document.querySelector('form')).not.toBeNull());
 expect(document.querySelector('input[type="checkbox"][value="suspected_duplicate"]')).toBeNull();expect(new FormData(document.querySelector('form')!).getAll('quality')).toEqual(['suspected_duplicate']);expect(screen.getByText(copy.duplicateUnavailable)).toBeVisible();
});
