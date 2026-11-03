/** AI v2 W5 — the "Why?" panels, rendered: each shows the owner service's figures exactly, in all six locales, with
 * "Ask AI Centre about this" handing the panel's question (never a figure) to AI Centre Ask.
 *
 * The explanations are the real pure owners' output (core/pay-difference.ts, core/leave-balance-explain.ts,
 * core/claim-limit-explain.ts) on fictional figures, worded by components/why/views.ts under the SHIPPING catalogues
 * with next-intl's onError collected and asserted empty. Expected text is written out literally from the fixture. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {createTranslator} from 'next-intl';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import vi_ from '../messages/vi.json';import ta from '../messages/ta.json';import th from '../messages/th.json';
import {withAiCentre} from './helpers/ai-centre-messages';
import {comparePayPeriods,explainPayslipDeduction,type StoredPayslipRow} from '../core/pay-difference';
import {claimLimitExplanation} from '../core/claim-limit-explain';
import type {LeaveBalanceExplanation} from '../core/leave-balance-explain';
import {WhyLink,WhyPanel,type WhyPanelView} from '../components/why/why-panel';
import {claimLimitView,deductionView,leaveBalanceView,payDifferenceView,type Translate} from '../components/why/views';
import {PersonalPayslipStatement} from '../app/me/payslip/statement';
import {data,labels} from './fixtures/payslip-pdf-fixture';
import {ASK_HANDOFF_KEY} from '../lib/today/ask-handoff';

const nav=vi.hoisted(()=>({push:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({push:nav.push})}));

const BASE={en,ms,zh,vi:vi_,ta,th} as Record<string,Record<string,unknown>>;
const LOCALES=['en','ms','zh','vi','ta','th'] as const;
const errors:string[]=[];
const translators=(locale:string)=>{const messages=withAiCentre(locale,BASE[locale]);
 const make=(namespace:string)=>createTranslator({locale,messages:messages as never,namespace:namespace as never,onError:error=>{errors.push(`${locale}: ${error.message}`);}}) as unknown as Translate;
 return {t:make('why'),tp:make('me.payslip')};};

const stat=(over:Record<string,unknown>={})=>({version:'my-2026.1',epfEmployee:550,epfEmployer:650,socsoEmployee:24.75,socsoEmployer:86.65,socsoSkbbk:0,eisEmployee:9.9,eisEmployer:9.9,pcb:120,hrdf:0,
 bases:{epf:5000,epfAdditional:0,socsoEis:5000,pcb:5000,hrdf:5000},salaryBasis:{version:1,basicSalary:5000,effectiveFrom:'2024-01-01'},...over});
const row=(over:Partial<StoredPayslipRow>):StoredPayslipRow=>({companyId:'co',company:'Fictional Ceria Sdn Bhd',payPeriod:'2026-09',runType:'regular',runSeq:1,basic:'5000.00',allowance:'0.00',overtime:'0.00',
 bonus:'0.00',gross:'5000.00',statutory:stat(),otherDeductions:'0.00',totalDeductions:'704.65',net:'4295.35',daysWorked:'30.00',...over});
const OCTOBER=row({payPeriod:'2026-10',otherDeductions:'230.77',totalDeductions:'892.02',net:'4107.98',
 statutory:stat({epfEmployee:528,socsoEmployee:23.75,eisEmployee:9.5,pcb:100,unpaidLeave:{days:1,amount:230.77},bases:{epf:4769.23,epfAdditional:0,socsoEis:4769.23,pcb:4769.23,hrdf:4769.23}})});
const PAY=comparePayPeriods([OCTOBER,row({})]);
const LEAVE:LeaveBalanceExplanation={leaveType:'Annual Leave',cycleStart:'2026-01-01',cycleEnd:'2026-12-31',isCurrentCycle:true,canApplyFor:9.5,entitlementTemplateName:'Fictional Standard',
 entitlementStatus:'generated',withheld:false,carryForwardExpiryDate:'2026-06-30',proration:{annualEntitlementDays:14,prorated:true,displayEntitlementDays:12,roundingApplied:false},
 figures:{entitlement:12,earnedSoFar:10,broughtForward:2,adjustments:0,totalEntitlement:14,taken:3.5,pending:1,forfeited:0,available:9.5}};
const CLAIM=claimLimitExplanation({claimTypeId:'ct',typeCode:'TRV',typeName:'Travel',items:[],annualLimit:2000,usedThisYear:620,reservedThisYear:120,remainingThisYear:1380,monthlyLimit:null,usedThisMonth:0,
 remainingThisMonth:null,perClaimCap:500,lifetimeLimit:null,usedLifetime:0,claimsUsedThisYear:3,maxClaimsPerYear:null,blockLimit:null,usedThisBlock:0,remainingThisBlock:null,blockEndsOn:null,
 policyValidFrom:'2026-01-01',policyGradeScoped:true});
const views=(locale:string):WhyPanelView[]=>{const {t,tp}=translators(locale),f={locale,currency:'MYR'};
 return [payDifferenceView(PAY,f,t,tp),deductionView('epf',explainPayslipDeduction(row({}),'epf')!,'2026-09',f,t,tp),deductionView('unpaidLeave',explainPayslipDeduction(OCTOBER,'unpaidLeave')!,'2026-10',f,t,tp),
  leaveBalanceView(LEAVE,f,t),claimLimitView(CLAIM,f,t)];};
const ASK={label:'Ask AI Centre about this',openingLabel:'Opening AI Centre…'};
const text=(el:Element|null|undefined)=>(el?.textContent??'').replace(/\s+/g,' ').trim();
const show=(view:WhyPanelView,ask:typeof ASK|null=ASK)=>render(<WhyPanel id="why-fixture" view={view} ask={ask} closeHref="/me/payslip?payslipId=ps" closeLabel="Close"/>);

beforeEach(()=>{errors.length=0;nav.push.mockReset();window.sessionStorage.clear();});
afterEach(cleanup);

describe('the pay difference panel',()=>{
 it('shows the payroll service\'s own lines and differences, the recorded cause and the rule, in English',()=>{
  const [pay]=views('en');const view=show(pay);
  const panel=view.container.querySelector('[data-why-panel="pay"]')!;
  expect(text(panel.querySelector('h3'))).toBe('Why October 2026 is different from September 2026');
  expect(text(panel.querySelector('[data-why-lead]'))).toBe('Your net pay was MYR 187.37 lower than in September 2026.');
  const rows=[...panel.querySelectorAll('tbody tr')].map(tr=>[...tr.children].map(text));
  expect(rows).toEqual([
   ['EPF / KWSP','MYR 550.00','MYR 528.00','−MYR 22.00'],['SOCSO / PERKESO','MYR 24.75','MYR 23.75','−MYR 1.00'],['EIS / SIP','MYR 9.90','MYR 9.50','−MYR 0.40'],
   ['PCB / MTD (income tax)','MYR 120.00','MYR 100.00','−MYR 20.00'],['Unpaid leave','MYR 0.00','MYR 230.77','+MYR 230.77'],
   ['Gross pay','MYR 5,000.00','MYR 5,000.00','MYR 0.00'],['Total deductions','MYR 704.65','MYR 892.02','+MYR 187.37'],['Net pay','MYR 4,295.35','MYR 4,107.98','−MYR 187.37']]);
  expect([...panel.querySelectorAll('thead th')].map(text)).toEqual(['Item','September 2026','October 2026','Change']);
  const sections=Object.fromEntries([...panel.querySelectorAll('[data-why-section]')].map(section=>[text(section.querySelector('h4')),[...section.querySelectorAll('li')].map(text)]));
  expect(sections['What the payroll service recorded']).toEqual(['Unpaid leave: 1 day in October 2026, 0 days in September 2026.']);
  expect(sections['Statutory deductions']).toContain('EPF / KWSP was charged on MYR 4,769.23, against MYR 5,000.00 in September 2026.');
  expect(sections['Statutory deductions']).toContain('EPF / KWSP is looked up from its contribution schedule by wage band, so the amount moves in steps.');
  expect(text(panel.querySelector('[data-why-source]'))).toBe('The payroll service calculated every figure here. AI Centre only explains it.');
  expect(within(panel as HTMLElement).getByRole('link',{name:'Close'})).toHaveAttribute('href','/me/payslip?payslipId=ps');
  expect(errors).toEqual([]);
 });
 it('says so when there is no earlier month, and words every panel in all six locales without a missing message',()=>{
  const {t,tp}=translators('en');
  const earliest=payDifferenceView(comparePayPeriods([row({})]),{locale:'en',currency:'MYR'},t,tp);
  const view=show(earliest);
  expect(text(view.container.querySelector('[data-why-lead]'))).toBe('This is your earliest released payslip, so there is no earlier month to compare it with.');
  expect(view.container.querySelector('table')).toBeNull();
  cleanup();
  for(const locale of LOCALES){
   for(const panel of views(locale)){const rendered=show(panel);
    // The figures are the owners' own, formatted the same in every locale.
    const body=text(rendered.container);
    expect(body,`${locale} ${panel.kind}`).not.toMatch(/\{[a-zA-Z]+\}|why\.|me\.payslip\./);
    if(panel.kind==='pay')for(const figure of ['MYR 230.77','−MYR 187.37','MYR 4,107.98'])expect(body,locale).toContain(figure);
    if(panel.kind==='claim')for(const figure of ['MYR 2,000.00','MYR 620.00','MYR 120.00','MYR 1,380.00','MYR 500.00'])expect(body,locale).toContain(figure);
    if(panel.kind==='leave')for(const figure of ['12.00','2.00','14.00','3.50','9.50'])expect(body,locale).toContain(figure);
    cleanup();}
  }
  expect(errors).toEqual([]);
 });
});

describe('the deduction, leave and claim panels',()=>{
 it('explain a statutory line from the payslip\'s own working, and an unpaid-leave line by its days',()=>{
  const [,epf,unpaid]=views('en');
  const view=show(epf);
  const panel=view.container.querySelector('[data-why-panel="deduction"]')!;
  expect(text(panel.querySelector('h3'))).toBe('Why EPF / KWSP is MYR 550.00');
  expect([...panel.querySelectorAll('[data-why-figures] > div')].map(div=>[text(div.querySelector('dt')),text(div.querySelector('dd'))])).toEqual([
   ['Taken from your pay','MYR 550.00'],["Your employer's own share",'MYR 650.00'],['Wage it was charged on','MYR 5,000.00'],['Effective rate (a check figure, not the rule)','11.00%']]);
  expect([...panel.querySelectorAll('[data-why-note]')].map(text)).toEqual(['Statutory rules version my-2026.1.']);
  cleanup();
  const second=show(unpaid).container.querySelector('[data-why-panel="deduction"]')!;
  expect([...second.querySelectorAll('[data-why-figures] > div')].map(div=>text(div))).toEqual(['Days deducted1 day','Unpaid leaveMYR 230.77']);
 });
 it('walk the leave balance to the figure beside its Why?, and the claim limit to what is left',()=>{
  const [,,,leave,claim]=views('en');
  const figures=(container:HTMLElement)=>[...container.querySelectorAll('[data-why-figures] > div')].map(div=>[text(div.querySelector('dt')),text(div.querySelector('dd'))]);
  const l=show(leave).container;
  expect(text(l.querySelector('h3'))).toBe('Your Annual Leave balance');
  expect(figures(l)).toEqual([['Entitlement for the year','12.00 days'],['Earned so far','10.00 days'],['Carried forward','2.00 days'],['Adjustments','0.00 days'],
   ['Total entitlement','14.00 days'],['Taken','3.50 days'],['Waiting for approval','1.00 days'],['Available','9.50 days']]);
  expect([...l.querySelectorAll('[data-why-note]')].map(text)).toEqual(['Entitlement table: Fictional Standard.',
   'You were not employed for the whole leave year, so the full-year 14.00 days was prorated to 12.00 days.','Carried-forward days expire on Jun 30, 2026.']);
  cleanup();
  const c=show(claim).container;
  expect(figures(c)).toEqual([['Yearly limit','MYR 2,000.00'],['Used this year','MYR 620.00'],['Of which waiting for approval','MYR 120.00'],['Left this year','MYR 1,380.00'],['Most for one claim','MYR 500.00']]);
  expect([...c.querySelectorAll('[data-why-note]')].map(text)).toEqual(['These limits come from the policy for your job grade, in force from Jan 1, 2026.',
   'Used counts claims waiting for approval, approved or paid, by the date of the expense. Drafts hold nothing.']);
 });
});

describe('Ask AI Centre about this',()=>{
 it('hands the panel\'s question, with no figure in it, to AI Centre Ask',()=>{
  const [pay]=views('en');show(pay);
  fireEvent.click(screen.getByRole('button',{name:'Ask AI Centre about this'}));
  const handed=JSON.parse(window.sessionStorage.getItem(ASK_HANDOFF_KEY)!) as {q:string};
  expect(handed.q).toBe('Why is my pay for October 2026 different from September 2026?');
  expect(handed.q).not.toMatch(/\d+\.\d\d/);
  expect(nav.push).toHaveBeenCalledWith('/assistant');
 });
 it('is not offered to someone the Assistant cannot answer',()=>{
  const [,,,leave]=views('en');show(leave,null);
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.getByText('The leave service calculated every figure here. AI Centre only explains it.')).toBeVisible();
 });
});

describe('the employee payslip with its Why? links',()=>{
 it('puts a Why? beside a deduction line, outside its label, and the panel and net pay link in place',()=>{
  render(<PersonalPayslipStatement data={data} labels={labels} actions={null} why={{
   deductionLink:label=>label===labels.epf?<WhyLink href="/me/payslip?why=deduction%3Aepf" text="Why?" label={`Why is ${label} this amount?`}/>:null,
   deductionPanel:<p data-fixture-panel>Deduction panel</p>,netLink:<WhyLink href="/me/payslip?why=pay" text="Why is my pay different from last month?"/>,netPanel:null}}/>);
  const deductions=within(screen.getByRole('heading',{name:labels.deductions}).parentElement!);
  // The line's label is still its own text, so every existing reader of the row finds it.
  expect(deductions.getByText(labels.epf)).toBeVisible();
  const link=deductions.getByRole('link',{name:`Why? Why is ${labels.epf} this amount?`});
  expect(link).toHaveAttribute('href','/me/payslip?why=deduction%3Aepf');expect(link).toHaveAttribute('aria-expanded','false');
  expect(deductions.getAllByRole('link')).toHaveLength(1);
  expect(deductions.getByText('Deduction panel')).toBeVisible();
  expect(screen.getByRole('link',{name:'Why is my pay different from last month?'})).toHaveAttribute('href','/me/payslip?why=pay');
 });
});
