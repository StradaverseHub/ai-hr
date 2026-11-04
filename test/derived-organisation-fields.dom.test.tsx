import {afterEach,it,expect,vi} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import viMessages from '../messages/vi.json';
import {aiReviewDomHtml,captureAiReviewScreenshots} from './helpers/ai-review-screenshots';
vi.mock('../app/admin/personnel/derived-organisation-actions',()=>({derivedOrganisationAction:vi.fn()}));
import {DerivedOrganisationFields} from '../components/derived-organisation-fields';
import {DerivedOrganisationPayroll} from '../components/derived-organisation-payroll';
afterEach(cleanup);
const data={managed:true,companyId:'fictional-company',businessUnitId:'fictional-bu',parentCompanyId:null,businessGroupId:'fictional-company',mappingVersionId:'fictional-reviewed-version',status:'ready' as const,reason:null,businessUnitName:'Fictional Operations',parentCompanyName:null,businessGroupName:'Fictional Holdings',asOf:'2026-11-04'};
const catalogues={en,ms,zh,ta,th,vi:viMessages};
it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('%s renders readonly canonical tags, root meaning, dated provenance and named grouping blockers',async locale=>{
 const messages=catalogues[locale],error=vi.fn();
 const view=render(<NextIntlClientProvider locale={locale} messages={messages} onError={error}><main className="mx-auto max-w-3xl space-y-4 p-4"><DerivedOrganisationFields state={{data,loading:false,failed:false}}/><DerivedOrganisationFields state={{data:{...data,status:'pending',businessUnitId:null,businessUnitName:null,businessGroupId:null,businessGroupName:null,reason:'company_not_in_structure'},loading:false,failed:false}}/><DerivedOrganisationPayroll rows={[{employmentId:'fictional-employee',employeeCode:'DEMO-001',name:'Fictional Employee',reason:'company_not_in_structure'}]}/></main></NextIntlClientProvider>);
 expect(screen.queryByRole('combobox')).toBeNull();expect(screen.queryByRole('textbox')).toBeNull();
 expect(screen.getByText(messages.derivedOrganisation.topLevel)).toBeVisible();expect(screen.getByText(/DEMO-001/)).toBeVisible();expect(view.container.textContent).toContain('2026-11-04');expect(view.container.textContent).toContain('fictional-reviewed-version');expect(error).not.toHaveBeenCalled();
 await captureAiReviewScreenshots(aiReviewDomHtml(view.container),locale,'derived-organisation-fields','Actual readonly tag and named blocker components; fictional static metadata, not an authenticated server journey.','atelier');
},120_000);
it('shows preparation, loading and failure states without editable controls',()=>{
 const view=render(<NextIntlClientProvider locale="en" messages={en}><DerivedOrganisationFields state={{data:{...data,status:'legacy',managed:false},loading:false,failed:false}}/><DerivedOrganisationFields state={{data:undefined,loading:true,failed:false}}/><DerivedOrganisationFields state={{data:undefined,loading:false,failed:true}}/></NextIntlClientProvider>);
 expect(screen.getByText(en.derivedOrganisation.preparation)).toBeVisible();expect(screen.getByText(en.derivedOrganisation.loading)).toBeVisible();expect(screen.getByRole('alert')).toHaveTextContent(en.derivedOrganisation.unavailable);expect(view.container.querySelector('input,select,textarea')).toBeNull();
});
