import {afterEach,it,expect,vi} from 'vitest';
import {cleanup,render,screen,fireEvent,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import viMessages from '../messages/vi.json';
import {aiReviewDomHtml,captureAiReviewScreenshots} from './helpers/ai-review-screenshots';
import {personnelFormulaLibraryFixture} from './pay-formula-personnel-fixture';
import {FormulaSampleTest} from '../app/payroll/formula-builder/formula-guidance';
import {PersonnelFormulaLibrary} from '../app/payroll/formula-builder/personnel-library';
import type {PersonnelFormulaLibraryField} from '../lib/pay-formula-personnel';
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn()})}));
vi.mock('../app/payroll/formula-builder/actions',()=>({registerPersonnelFormulaFieldAction:vi.fn()}));
afterEach(cleanup);
const company:PersonnelFormulaLibraryField={fieldId:'employment.organisation_assignment.companyname',key:'companyId',label:'Company',labelKey:'unknown',section:'Organisation assignment',group:'profile',type:'choice',history:'dated',sensitivity:'personnel',grain:'single',unavailableReason:null,description:'Verified legal employer',formulaType:'string',functionCode:'EmployeeProfile',dateBasis:'effective-date',enabled:true,listValues:[{value:'company-uuid',label:'Example company · company-uuid'}]};
it('inserts the typed source and permitted stable literal and keeps unsupported fields visible with a reason',()=>{
 const insert=vi.fn();render(<NextIntlClientProvider locale="en" messages={en}><PersonnelFormulaLibrary fields={[company,{...company,fieldId:'repeat',key:'repeat',label:'Emergency contacts',grain:'many',enabled:false,unavailableReason:'repeating',listValues:[]}]} search="" category="" disabled={false} onInsert={insert}/></NextIntlClientProvider>);
 const field=screen.getByRole('heading',{name:'Company'}).closest('article')!;fireEvent.click(within(field).getByRole('button',{name:en.payFormula.personnelLibrary.insertField}));expect(insert).toHaveBeenLastCalledWith(expect.objectContaining({kind:'call',code:'EmployeeProfile',args:[expect.objectContaining({value:{type:'string',value:'companyId'}})]}));
 fireEvent.click(screen.getByText(en.payFormula.personnelLibrary.permittedValues));fireEvent.click(screen.getByRole('button',{name:'Example company · company-uuid'}));expect(insert).toHaveBeenLastCalledWith(expect.objectContaining({kind:'literal',value:{type:'string',value:'company-uuid'}}));
 const repeat=screen.getByRole('heading',{name:'Emergency contacts'}).closest('article')!;expect(within(repeat).getByText(en.payFormula.personnelLibrary.reasons.repeating)).toBeVisible();expect(within(repeat).getByRole('button').hasAttribute('disabled')).toBe(true);
});

const catalogues={en,ms,zh,ta,th,vi:viMessages};
it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('%s captures the real Personnel library and registration controls in desktop and mobile Chrome',async locale=>{
 const messages=catalogues[locale],copy=messages.payFormula.personnelLibrary;
 const view=render(<NextIntlClientProvider locale={locale} messages={messages} timeZone="Asia/Kuala_Lumpur"><main className="mx-auto min-w-0 max-w-3xl space-y-4"><h1 className="text-xl font-semibold">{messages.payFormula.variables}</h1><section className="min-w-0 rounded-xl border border-border bg-card p-4"><PersonnelFormulaLibrary fields={personnelFormulaLibraryFixture()} search="" category="" disabled={false} onInsert={()=>{}}/></section></main></NextIntlClientProvider>);
 const inserts=screen.getAllByRole<HTMLButtonElement>('button',{name:copy.insertField});expect(inserts.some(button=>button.disabled)).toBe(true);expect(inserts.some(button=>!button.disabled)).toBe(true);
 const fixture='Real PersonnelFormulaLibrary component and registration form; fictional metadata-only list values; no authenticated employee/server journey';
 await captureAiReviewScreenshots(aiReviewDomHtml(view.container),locale,'formula-personnel-library',fixture,'atelier');
 fireEvent.click(screen.getByRole('button',{name:copy.register}));expect(screen.getByRole('combobox',{name:copy.source})).toBeVisible();expect(screen.getByRole('checkbox',{name:copy.enabled})).toBeChecked();
 await captureAiReviewScreenshots(aiReviewDomHtml(view.container),locale,'formula-personnel-registry',fixture,'atelier');
},120_000);

it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('%s labels new Personnel sample fields through the shared translated descriptor',locale=>{
 const errors=vi.fn(),messages=catalogues[locale],source='If {#EmployeeInformation}("profile.personal_details.fullname") = "Fictional" Then\nReturn 1\nElse\nReturn 0\nEnd If';
 render(<NextIntlClientProvider locale={locale} messages={messages} timeZone="Asia/Kuala_Lumpur" onError={errors}><FormulaSampleTest text={source}/></NextIntlClientProvider>);
 expect(screen.getByRole('textbox',{name:messages.people.detail.fullNameIc})).toBeVisible();expect(errors).not.toHaveBeenCalled();
});
