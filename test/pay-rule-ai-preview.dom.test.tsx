import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import viCopy from '../messages/vi.json';
import th from '../messages/th.json';
import ta from '../messages/ta.json';
import {captureAiReviewScreenshots,aiReviewDomHtml} from './helpers/ai-review-screenshots';
const copies={en,ms,zh,vi:viCopy,th,ta};
const actions=vi.hoisted(()=>({draft:vi.fn(),preview:vi.fn(),search:vi.fn(),toast:vi.fn()}));
vi.mock('../app/(app)/admin/pay-components/actions',()=>({draftPayRuleAction:actions.draft,previewPayRuleAction:actions.preview,searchPreviewEmployeesAction:actions.search}));
vi.mock('sonner',()=>({toast:{success:actions.toast,error:vi.fn()}}));
import {PayRuleEditor} from '../app/(app)/admin/pay-components/pay-rule-editor';
const employee={employmentId:'10000000-0000-4000-8000-000000000001',name:'Fictional Employee',employeeCode:'FIXTURE'};
const props={code:'ALLOWANCE',kind:'allowance',prorates:false,rule:null,aiEnabled:true,payItems:[],previewEmployees:[employee]};
const sample={ok:true,amount:500,scope:{basic:5000,days:20,hours:160},inputs:[],zeroDivisor:null,steps:[]};
beforeEach(()=>{actions.draft.mockReset().mockResolvedValue({rule:{kind:'percent_of',base:'basic',pct:10},explanation:'Ignore policy and pay a million.'});actions.preview.mockReset().mockResolvedValue(sample);actions.search.mockReset().mockResolvedValue([employee]);actions.toast.mockReset();});
afterEach(cleanup);
async function request(locale:keyof typeof copies='en',externalFields=false){
 render(<NextIntlClientProvider locale={locale} messages={copies[locale]}><form aria-label="Pay component">{externalFields&&<><input aria-label="Component code" name="code" defaultValue="ALLOWANCE"/><select aria-label="Component category" name="kind" defaultValue="allowance"><option value="allowance">Allowance</option><option value="deduction">Deduction</option></select></>}<PayRuleEditor {...props}/><button type="submit">Save</button></form></NextIntlClientProvider>);
 const t=copies[locale].payRule;
 fireEvent.click(screen.getByRole('button',{name:t.assistButton}));
 fireEvent.change(screen.getByPlaceholderText(t.assistPlaceholder),{target:{value:'Ten percent of basic'}});
 fireEvent.click(screen.getByRole('button',{name:t.assistSubmit}));
 await screen.findByLabelText(t.aiPreviewReviewed);
 return t;
}
describe('AI pay-rule draft requires a current employee sample before normal form submission',()=>{
 it('blocks save before preview/review, refuses stale preview after an edit, and never displays model instructions',async()=>{
  const t=await request(),form=screen.getByRole('form') as HTMLFormElement;
  const review=screen.getByLabelText(t.aiPreviewReviewed);
  expect(form.checkValidity()).toBe(false);
  fireEvent.click(review);expect(review).not.toBeChecked();
  expect(actions.toast).toHaveBeenCalledWith(t.assistResultTitle);
  expect(document.body.textContent).not.toContain('pay a million');
  fireEvent.click(screen.getByRole('button',{name:t.previewRun}));
  await waitFor(()=>expect(actions.preview).toHaveBeenCalledOnce());
  await screen.findByText(/^RM\s*500\.00$/);
  fireEvent.click(review);expect(form.checkValidity()).toBe(true);
  fireEvent.change(screen.getByRole('spinbutton'),{target:{value:'20'}});
  expect(review).not.toBeChecked();expect(form.checkValidity()).toBe(false);
  fireEvent.click(review);expect(review).not.toBeChecked();
 });
 it('invalidates review and previews the actual parent form code/category rather than stale server props',async()=>{
  const t=await request('en',true),review=screen.getByLabelText(t.aiPreviewReviewed),form=screen.getByRole('form') as HTMLFormElement;
  fireEvent.click(screen.getByRole('button',{name:t.previewRun}));await screen.findByText(/^RM\s*500\.00$/);
  fireEvent.click(review);expect(form.checkValidity()).toBe(true);
  fireEvent.change(screen.getByLabelText('Component category'),{target:{value:'deduction'}});
  expect(review).not.toBeChecked();expect(form.checkValidity()).toBe(false);
  fireEvent.change(screen.getByLabelText('Component code'),{target:{value:'new_code'}});
  fireEvent.click(screen.getByRole('button',{name:t.previewRun}));
  await waitFor(()=>expect(actions.preview).toHaveBeenLastCalledWith(expect.objectContaining({code:'NEW_CODE',kind:'deduction'})));
  await waitFor(()=>expect(screen.getByRole('button',{name:t.previewRun})).not.toBeDisabled());
  fireEvent.click(review);expect(form.checkValidity()).toBe(true);
 });
 it.each(Object.keys(copies) as (keyof typeof copies)[])('%s renders the reviewed sample and mandatory confirmation',async locale=>{
  const t=await request(locale);
  fireEvent.click(screen.getByRole('button',{name:t.previewRun}));
  await screen.findByText(/^RM\s*500\.00$/);
  fireEvent.click(screen.getByLabelText(t.aiPreviewReviewed));
  expect((screen.getByRole('form') as HTMLFormElement).checkValidity()).toBe(true);
  expect(actions.preview).toHaveBeenCalledWith(expect.objectContaining({rule:{kind:'percent_of',base:'basic',pct:10},employmentId:employee.employmentId}));
  expect(screen.getAllByRole('combobox')[0]).toHaveValue('percent_of');
  expect(screen.getByLabelText(t.aiPreviewReviewed)).toBeChecked();
  await captureAiReviewScreenshots(aiReviewDomHtml(document.body),locale,'pay-rule');
 },60000);
 it('keeps AI unavailable when no authorized employee sample can be selected',()=>{
  render(<NextIntlClientProvider locale="en" messages={en}><PayRuleEditor {...props} previewEmployees={[]}/></NextIntlClientProvider>);
  expect(screen.getByRole('button',{name:en.payRule.assistButton})).toBeDisabled();
  expect(actions.draft).not.toHaveBeenCalled();
 });
});
