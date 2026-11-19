/** Real interactive components with fictional data. Authenticated route checks live in
 * system-label-exchange-browser.test.ts; these measure narrow layouts and long dialogs. */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {page} from 'vitest/browser';
import {cleanup,fireEvent,render,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import ta from '../messages/ta.json';
import type {RewardDashboard} from '../packs/rewards/service';
import '../app/globals.css';
import '../app/atelier.css';
import '../app/operational-layout.css';
vi.mock('next/navigation',()=>({usePathname:()=>'/admin/personnel',useSearchParams:()=>new URLSearchParams(),useRouter:()=>({push:vi.fn(),replace:vi.fn(),refresh:vi.fn()})}));
vi.mock('../app/rewards/dashboard-actions',()=>({saveDashboardAction:vi.fn()}));
const {RewardsDashboard}=await import('../app/rewards/dashboard');
const {SystemLabelImport}=await import('../components/system-label-import');
const {PersonnelOrganisationFilters}=await import('../app/admin/personnel/organisation-filters');
const empty:RewardDashboard={kind:'annual',year:2026,years:[2026],choice:{version:2,kind:'annual',period:'monthly',businessUnit:'all',companies:[],year:2026},canSelectAll:false,businessUnits:[],companies:[],context:null,figures:null,excluded:[],preparing:[],waiting:[],roles:[],emptyReason:null};
const initialBodyStyle=document.body.getAttribute('style');
afterEach(async()=>{cleanup();vi.unstubAllGlobals();delete document.documentElement.dataset.uiTheme;if(initialBodyStyle===null)document.body.removeAttribute('style');else document.body.setAttribute('style',initialBodyStyle);await page.viewport(1280,720);});
async function screenshot(element:HTMLElement,name:string){
 const shot=await page.screenshot({element,path:`../.vitest-attachments/${name}.png`,base64:true,animations:'disabled',scale:'css'});
 console.info('OPERATIONAL_POLISH_SCREENSHOT '+JSON.stringify({name,source:'candidate components and compiled CSS',fixture:'fictional',base64:shot.base64}));
}
for(const [locale,messages] of [['en',en],['ta',ta]] as const)for(const width of [390,1440])describe(`${locale} at ${width}px`,()=>{
 it('offers one readable empty Rewards message and a reachable All reviews action',async()=>{
  await page.viewport(width,900);document.documentElement.dataset.uiTheme='atelier';document.body.style.margin='0';
  const view=render(<NextIntlClientProvider locale={locale} messages={messages} onError={error=>{throw error;}}><main className="min-w-0 p-4"><h1 className="mb-4 text-xl font-semibold">{messages.nav.rewardsReviewing}</h1><RewardsDashboard value={empty}/></main></NextIntlClientProvider>);
  const action=view.getByRole('link',{name:messages.nav.rewardsAllReviews});
  expect(view.getAllByText(messages.rewardDashboard.empty)).toHaveLength(1);
  expect(action.getAttribute('href')).toBe('/rewards/reviews');
  expect(action.getBoundingClientRect().height).toBeGreaterThanOrEqual(36);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width+1);
  await screenshot(view.container,`rewards-empty-${locale}-${width}`);
 });
 it('keeps Excel actions visible and preserves guidance in the native disclosure',async()=>{
  await page.viewport(width,900);document.documentElement.dataset.uiTheme='atelier';document.body.style.margin='0';
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({jobs:[]}),{headers:{'Content-Type':'application/json'}})));
  const view=render(<NextIntlClientProvider locale={locale} messages={messages} onError={error=>{throw error;}}><main className="p-4"><h1 className="mb-4 text-xl font-semibold">{messages.admin.systemLabels.pageTitle}</h1><SystemLabelImport criteriaHelp={messages.admin.systemLabels.criteriaHelp}/></main></NextIntlClientProvider>);
  const help=view.container.querySelector('details')!;
  expect(help.open).toBe(false);
  const actions=view.getByRole('button',{name:messages.admin.systemLabels.excel.import});
  expect(actions.getBoundingClientRect().right).toBeLessThanOrEqual(width);
  expect(view.container.querySelector('[data-label-import]')!.getBoundingClientRect().height).toBeLessThan(width===390?120:60);
  fireEvent.click(within(help).getByText(messages.admin.systemLabels.excel.file));
  expect(help.open).toBe(true);
  expect(view.getByText(messages.admin.systemLabels.criteriaHelp)).toBeVisible();
  expect(view.getByText(messages.systemLabelExchange.scopeHelp)).toBeVisible();
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width+1);
  await screenshot(view.container,`labels-guidance-${locale}-${width}`);
 });
 it('keeps the Personnel dialog title and Close visible after its long field list scrolls',async()=>{
  await page.viewport(width,900);document.documentElement.dataset.uiTheme='atelier';document.body.style.margin='0';
  const view=render(<NextIntlClientProvider locale={locale} messages={messages} onError={error=>{throw error;}}><PersonnelOrganisationFilters fields={[]} values={{}} companies={[]} labels={{filter:messages.people.list.filter,apply:messages.people.list.applyFilters,clearAll:messages.people.list.clearAllFilters,activeCount:'0'}} companySearchLabel={messages.people.list.controls.companySearch} columnFields={Array.from({length:65},(_,index)=>({key:`field-${index}`,label:`Fictional field ${index+1}`,type:'text'}))}/></NextIntlClientProvider>);
  fireEvent.click(view.getByRole('button',{name:messages.people.list.filter}));
  const dialog=document.querySelector<HTMLElement>('[role="dialog"]')!,close=within(dialog).getByRole('button',{name:messages.common.close}),before=close.getBoundingClientRect().top;
  const form=dialog.querySelector('form')!;expect(form.scrollHeight).toBeGreaterThan(form.clientHeight+100);
  form.scrollTop=form.scrollHeight;
  expect(close.getBoundingClientRect().top).toBe(before);
  expect(close.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
  expect(close.getBoundingClientRect().bottom).toBeLessThanOrEqual(900);
  expect(dialog.getBoundingClientRect().width).toBeLessThanOrEqual(width);
  await screenshot(dialog,`personnel-dialog-${locale}-${width}`);
  fireEvent.click(close);expect(document.querySelector('[role="dialog"]')).toBeNull();
 });
});
