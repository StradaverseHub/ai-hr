/** @vitest-environment jsdom */
/** AI v2 P2-2b — the Audit loop's column (components/payroll-audit/audit-loop-column.tsx) and its own page
 * (app/control-tower/loops/loop_payroll_audit/page.tsx), rendered per role from a fictional read
 * (core/payroll-audit/status.ts is replaced by a fixture; the real services are covered by test/payroll-audit-loop.test.ts).
 *
 * The guard is the existing requireAdmin: an employee or a manager is sent away before any read. An HR administrator of one
 * company sees the loop's steps, figures, companies, statutory files, findings with a disposition form, corrections with a
 * root-cause form and the audit pack, and no loop switch; a group administrator also switches the loop. Opening the page is
 * recorded in the payroll access log once per company shown. Expected text is written out from the fixture through the real
 * catalogues; every locale renders with no missing message, says AI Centre and never Noveri, and every control keeps a 44px
 * target on a coarse pointer. */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import type {ReactNode} from 'react';
import {NextIntlClientProvider} from 'next-intl';
import {withAiCentre} from './helpers/ai-centre-messages';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import vi_ from '../messages/vi.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';

type Locale='en'|'ms'|'zh'|'vi'|'ta'|'th';
const CATALOGUES={en,ms,zh,vi:vi_,ta,th};
const messagesFor=(locale:Locale)=>withAiCentre(locale,CATALOGUES[locale] as Record<string,unknown>) as typeof en & {payrollAudit:Record<string,any>};
const state=vi.hoisted(()=>({locale:'en' as 'en'|'ms'|'zh'|'vi'|'ta'|'th',session:null as unknown,reads:[] as string[],access:[] as unknown[],companies:1,auditor:false}));
vi.mock('next/link',()=>({default:({children,...props}:any)=><a {...props}>{children}</a>}));
vi.mock('next-intl/server',async()=>{
 const {createTranslator:translator,createFormatter:formatter}=await import('next-intl');
 const {withAiCentre:merge}=await import('./helpers/ai-centre-messages');
 const all={en:(await import('../messages/en.json')).default,ms:(await import('../messages/ms.json')).default,zh:(await import('../messages/zh.json')).default,
  vi:(await import('../messages/vi.json')).default,ta:(await import('../messages/ta.json')).default,th:(await import('../messages/th.json')).default};
 return {getTranslations:async(namespace:any)=>translator({locale:state.locale,messages:merge(state.locale,all[state.locale] as any) as any,namespace,onError:error=>{throw error;}}),
  getFormatter:async()=>formatter({locale:state.locale,timeZone:'Asia/Kuala_Lumpur'})};
});
vi.mock('next/navigation',()=>({
 redirect:vi.fn((url:string)=>{throw Object.assign(Error('NEXT_REDIRECT'),{url});}),
 notFound:vi.fn(()=>{throw Object.assign(Error('NEXT_NOT_FOUND'),{notFound:true});}),
 usePathname:()=>'/control-tower/loops/loop_payroll_audit',useSearchParams:()=>new URLSearchParams(),useRouter:()=>({refresh:vi.fn(),push:vi.fn()}),
}));
vi.mock('../lib/session',()=>({getSession:async()=>state.session}));
vi.mock('../core/entitlements',()=>({isModuleEnabled:()=>true,isModuleEnabledOrFalse:()=>true}));
vi.mock('../app/control-tower/loops/actions',()=>({setLoopSwitchAction:vi.fn(),setLoopPauseAction:vi.fn()}));
vi.mock('../app/control-tower/loops/loop_payroll_audit/actions',()=>({disposeAuditFindingAction:vi.fn(),recordCorrectionCauseAction:vi.fn(),captureAuditNowAction:vi.fn(),
 setAuditSettingsAction:vi.fn(),grantAuditReaderAction:vi.fn(),revokeAuditReaderAction:vi.fn(),acknowledgeFindingAction:vi.fn()}));
// Phase 2 hardening: a login with a current read-only auditor grant (the database's answer, stood in for here), and the
// auditor's own read of the page (core/payroll-audit/auditor-view.ts, covered by test/payroll-loops-hardening.test.ts).
vi.mock('../core/payroll-audit/reader-grant',()=>({hasAuditReaderGrant:async()=>state.auditor,auditReaderCompaniesTx:async()=>[]}));
vi.mock('../core/payroll-audit/auditor-view',()=>({
 auditorCompanies:async()=>{state.reads.push('auditorCompanies');return [{id:fx.A,name:'Fictional A Sdn Bhd',group:false}];},
 auditorLoopDetail:async(_s:unknown,input:{payPeriod:string;companyIds?:string[]})=>{state.reads.push(`auditorDetail:${input.payPeriod}:${(input.companyIds??[]).join(',')}`);
  return {...fx.detail(1),loop:{on:true,sponsorUserId:null,sponsorName:null},canCapture:false};}}));
vi.mock('../core/payroll-audit/settings',()=>({auditAdministration:async(_s:unknown,input:{companyIds?:string[]})=>{state.reads.push('admin:'+(input.companyIds??[]).join(','));
 return {companies:[{companyId:fx.A,companyName:'Fictional A Sdn Bhd',settings:{bankChangeDays:5,adjustmentThreshold:1800,preparerClosedMode:'finding',version:2},
   readers:[{id:'g-1',appUserId:'00000000-0000-4000-8000-0000000000e1',label:'Lim Fictional · lim@fixture.test',grantedAt:new Date('2026-02-01T02:00:00Z'),grantedBy:'u-1'}]},
  {companyId:fx.B,companyName:'Fictional B Sdn Bhd',settings:{bankChangeDays:7,adjustmentThreshold:1000,preparerClosedMode:'info',version:null},readers:[]}].slice(0,state.companies),
  candidates:[{appUserId:'00000000-0000-4000-8000-0000000000e1',label:'Lim Fictional · lim@fixture.test'},{appUserId:'00000000-0000-4000-8000-0000000000e2',label:'Wong Fictional · wong@fixture.test'},
   {appUserId:'00000000-0000-4000-8000-0000000000e3',label:null}]};}}));
vi.mock('../core/payroll-audit/access-log',()=>({recordPayrollAccess:vi.fn(async(_s:unknown,entry:unknown)=>{state.access.push(entry);return {recorded:true,eventId:'e'};})}));
const fx=vi.hoisted(()=>{
 const A='00000000-0000-4000-8000-0000000000c1',B='00000000-0000-4000-8000-0000000000c2';
 const company=(companyId:string,companyName:string)=>({companyId,companyName,paused:false,
  runs:[{batchId:'00000000-0000-4000-8000-0000000000b1',runType:'regular',runSeq:1,status:'closed',closedAt:new Date('2026-01-26T04:00:00Z'),releasedAt:new Date('2026-01-26T04:00:00Z')}],
  payslips:{total:3,released:3,opened:2},
  // Phase 2 hardening: each form says whether the month requires it (here the company is not liable for the HRD levy).
  statutory:[{form:'epf',required:true,prepared:true,preparedOn:'2026-02-10',beforeDue:true,filed:true,filedOn:'2026-02-12',receipt:true},
   {form:'socso_eis',required:true,prepared:true,preparedOn:'2026-02-16',beforeDue:false,filed:false,filedOn:null,receipt:false},
   {form:'pcb_cp39',required:true,prepared:false,preparedOn:null,beforeDue:null,filed:false,filedOn:null,receipt:false},
   {form:'hrd',required:false,prepared:false,preparedOn:null,beforeDue:null,filed:false,filedOn:null,receipt:false}],
  bank:{files:1,byBank:[{bank:'ocbc_bank',format:'my.ocbc.salary',files:1,records:3,totalCents:1200000}]},
  corrections:{count:1,withoutRootCause:1},findings:{open:1,disposed:1},repeatIssues:['preparer_closed_run'],
  captures:{count:42,lastAt:new Date('2026-02-11T15:00:00Z'),head:'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'},
  settings:{bankChangeDays:7,adjustmentThreshold:1000,preparerClosedMode:'info',version:null},done:false});
 const detail=(count:number)=>{
  const companies=[company(A,'Fictional A Sdn Bhd'),company(B,'Fictional B Sdn Bhd')].slice(0,count);
  const n=companies.length;
  return {payPeriod:'2026-01',dueDate:'2026-02-15',level:'prepare',loop:{on:true,sponsorUserId:'u-1',sponsorName:'Aisyah Fictional'},companies,
   totals:{payslips:3*n,released:3*n,opened:2*n,formsPrepared:2*n,formsFiled:n,forms:3*n,bankFiles:n,corrections:n,correctionsWithoutRootCause:n,openFindings:n,repeatIssues:n,captures:42*n,companiesDone:0},
   canCapture:true,
   findings:[
    {id:'f-1',companyId:A,controlId:'preparer_closed_run',batchId:'00000000-0000-4000-8000-0000000000b1',employmentId:null,personName:null,employeeCode:null,detectedAt:new Date('2026-02-03T01:00:00Z'),
     evidence:{userId:'u-2',runSeq:1,runType:'regular',blocked:false},evidenceHash:'1'.repeat(64),disposition:null,note:null,disposedBy:null,disposedAt:null,acknowledgement:null},
    // Phase 2 hardening: an open finding a standing acknowledgement covers is listed as expected, its disposition pre-filled.
    {id:'f-3',companyId:A,controlId:'pay_without_attendance',batchId:'00000000-0000-4000-8000-0000000000b1',employmentId:'e-3',personName:'Ah Kow Fictional',employeeCode:'E003',
     detectedAt:new Date('2026-02-03T00:30:00Z'),evidence:{detector:'pay-without-attendance',severity:'review',facts:{},period:{},runType:'regular',runSeq:1},evidenceHash:'3'.repeat(64),
     disposition:null,note:null,disposedBy:null,disposedAt:null,acknowledgement:{id:'k-1',scope:'person',reason:'Cash-paid driver, never clocks in',reviewOn:null}},
    {id:'f-2',controlId:'bank_change_before_pay_day',batchId:'00000000-0000-4000-8000-0000000000b1',employmentId:'e-1',personName:'Siti Fictional',employeeCode:'E001',
     detectedAt:new Date('2026-02-02T01:00:00Z'),evidence:{payDay:'2026-01-31',changedOn:'2026-01-28',daysBeforePayDay:3,accountAfterLast4:'5566'},evidenceHash:'2'.repeat(64),
     disposition:'expected',note:'Verified with the employee by phone.',disposedBy:'u-1',disposedAt:new Date('2026-02-04T01:00:00Z')}],
   corrections:[{correctionKey:'status:00000000-0000-4000-8000-0000000000d1',batchId:'00000000-0000-4000-8000-0000000000b1',runType:'regular',runSeq:1,action:'unlock',
    at:new Date('2026-02-05T02:00:00Z'),actorId:'u-2',reason:'Overtime keyed after close',rootCause:null,note:null,recordedBy:null,recordedAt:null,companyId:A,companyName:'Fictional A Sdn Bhd'}]};
 };
 class AuditViewRefused extends Error{constructor(readonly reason:string){super(reason);}}
 return {A,B,detail,AuditViewRefused};
});
vi.mock('../core/payroll-audit/status',()=>({AuditViewRefused:fx.AuditViewRefused,
 defaultAuditPeriod:(today:string)=>{state.reads.push('default:'+today.length);return '2026-01';},
 auditCompanies:async()=>{state.reads.push('companies');return [{id:fx.A,name:'Fictional A Sdn Bhd'},{id:fx.B,name:'Fictional B Sdn Bhd'}].slice(0,state.companies);},
 auditLoopDetail:async(_s:unknown,input:{payPeriod:string;companyIds?:string[]})=>{state.reads.push(`detail:${input.payPeriod}:${(input.companyIds??[]).join(',')}`);return fx.detail(state.companies);}}));
import AuditLoopPage from '../app/control-tower/loops/loop_payroll_audit/page';
import {AuditLoopColumn} from '../components/payroll-audit/audit-loop-column';

const TENANT='00000000-0000-4000-8000-0000000000a1';
const SESSIONS={
 employee:{tenantId:TENANT,userId:'00000000-0000-4000-8000-000000000001',roles:['employee'],grants:[{role:'employee',companyId:fx.A}]},
 manager:{tenantId:TENANT,userId:'00000000-0000-4000-8000-000000000002',roles:['employee','manager'],grants:[{role:'manager',companyId:fx.A}]},
 hrAdmin:{tenantId:TENANT,userId:'00000000-0000-4000-8000-000000000003',roles:['hr_admin'],grants:[{role:'hr_admin',companyId:fx.A}]},
 groupAdmin:{tenantId:TENANT,userId:'00000000-0000-4000-8000-000000000004',roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]},
} as const;
const wrap=(locale:Locale,node:ReactNode)=>render(<NextIntlClientProvider locale={locale} messages={messagesFor(locale) as never} onError={error=>{throw error;}} timeZone="Asia/Kuala_Lumpur">
 <main className="relative min-w-0"><div className="min-w-0">{node}</div></main></NextIntlClientProvider>);
const text=(el:Node|null|undefined)=>(el?.textContent??'').replace(/\s+/g,' ').trim();
const parts=(el:Element)=>[...el.childNodes].map(node=>text(node)).filter(Boolean).join(' ');
const page=async(query:Record<string,string>={})=>AuditLoopPage({searchParams:Promise.resolve(query)});
afterEach(()=>{cleanup();state.locale='en';state.session=null;state.reads=[];state.access=[];state.companies=1;state.auditor=false;});

describe('the Audit loop column',()=>{
 it('shows each item of the approved column from the counts, and the pack for a single company',()=>{
  const view=wrap('en',<AuditLoopColumn summary={fx.detail(1) as never} position={3} />);
  expect(screen.getByRole('heading',{level:3,name:'3 · Audit loop'})).toBeTruthy();
  expect(text(view.container.querySelector('[data-audit-badge]'))).toBe('After pay day');
  expect(text(view.container)).toContain('Done when everything is paid, filed, reconciled and evidenced.');
  expect([...view.container.querySelectorAll('[data-audit-item]')].map(item=>[...item.children].map(text))).toEqual([
   ['Payslips released and opened','3 of 3 released · 2 opened'],
   ['EPF, SOCSO, EIS, PCB, HRD files','2 of 3 prepared · 1 filed · due Feb 15'],
   ['Bank files','1 bank file recorded'],
   ['Corrections after the run','1 · target zero'],
   ['Control checks','1 open finding'],
   ['Who approved what, when','Download audit pack'],
   ['Repeat issues','1 fed to the next Pre-salary loop']]);
  expect(view.container.querySelector('[data-audit-item="approvals"] a')?.getAttribute('href'))
   .toBe(`/control-tower/loops/loop_payroll_audit/pack?company=${fx.A}&period=2026-01`);
  expect(text(view.container)).toContain('Files and filings stay at Prepare: a person submits to EPF, PERKESO and LHDN. The audit pack is read-only evidence for your auditors.');
  const open=screen.getByRole('link',{name:'Open Audit loop'});
  expect(open.getAttribute('href')).toBe(`/control-tower/loops/loop_payroll_audit?period=2026-01&company=${fx.A}`);
  for(const link of view.container.querySelectorAll('a'))expect(link.className).toContain('pointer-coarse:min-h-11');
  expect(text(view.container)).not.toMatch(/RM|1200000|12,000/);
 });

 it('with several companies, points to the pack per company on the loop page',()=>{
  const view=wrap('en',<AuditLoopColumn summary={fx.detail(2) as never} />);
  expect(screen.getByRole('heading',{level:3,name:'Audit loop'})).toBeTruthy();
  expect([...view.container.querySelector('[data-audit-item="approvals"]')!.children].map(text)).toEqual(['Who approved what, when','Audit pack per company']);
  expect(view.container.querySelector('[data-audit-item="approvals"] a')).toBeNull();
  expect(screen.getByRole('link',{name:'Open Audit loop'}).getAttribute('href')).toBe('/control-tower/loops/loop_payroll_audit?period=2026-01');
  expect([...view.container.querySelector('[data-audit-item="statutory"]')!.children].map(text)[1]).toBe('4 of 6 prepared · 2 filed · due Feb 15');
 });
});

describe('the Audit loop page, per role',()=>{
 it.each(['employee','manager'] as const)('%s is refused before any read',async role=>{
  state.session=SESSIONS[role];
  await expect(page()).rejects.toMatchObject({url:'/'});
  expect(state.reads).toEqual([]);
  expect(state.access).toEqual([]);
 });

 it('an HR administrator sees the steps, figures, companies, statutory files, findings and corrections, and no loop switch',async()=>{
  state.session=SESSIONS.hrAdmin;
  const view=wrap('en',await page({period:'2026-01'}));
  expect(state.reads).toEqual(['companies','detail:2026-01:','admin:']);
  // Opening the page is recorded, once per company shown.
  expect(state.access).toEqual([{surface:'audit_view',action:'view',companyId:fx.A,payPeriod:'2026-01'}]);
  expect(screen.getByRole('heading',{level:1,name:'Audit loop'})).toBeTruthy();
  expect(text(view.container.querySelector('[data-page-header]'))).toContain('Done when everything is paid, filed, reconciled and evidenced.');
  expect(text(view.container)).toContain('January 2026: statutory files due Feb 15, 2026.');
  expect([...view.container.querySelectorAll('[data-loop-steps] li')].map(parts)).toEqual([
   '1 · Capture For every run, regular, bonus and off-cycle: its inputs, each change from draft to final with who and why, adjustments, rule versions, exceptions, approvals, bank and statutory files, filings, payslip opens, corrections, who viewed or exported pay data and configuration changes. Each copy is hashed and chained.',
   '2 · Check Seven control checks every night, each with its evidence. Nothing is blocked or changed.',
   '3 · Prepare Findings for a payroll administrator to dispose of, a root cause for each correction, and the audit pack per company.',
   '4 · Verify Payslips released, statutory files prepared before Feb 15, 2026 and filed with a receipt, corrections at zero, and every capture unchanged.']);
  expect([...view.container.querySelectorAll('[data-loop-figures] > div')].map(parts)).toEqual(['42 Captures this month','1 Open findings','1 Corrections after the run','1 of 3 Statutory files filed']);
  const row=view.container.querySelector(`[data-audit-company="${fx.A}"]`)!;
  expect([...row.querySelectorAll('th,td')].map(parts)).toEqual(['Fictional A Sdn Bhd In progress','Salary run 1: closed','3 of 3 released · 2 opened','1 of 3','1 open · 1 disposed',
   '1 1 needs a root cause','42 captures abcdef0123456789','Download Capture and check now']);
  expect(row.querySelector('a')?.getAttribute('href')).toBe(`/control-tower/loops/loop_payroll_audit/pack?company=${fx.A}&period=2026-01`);
  expect([...view.container.querySelectorAll('[data-audit-statutory] tbody tr')].map(tr=>[...tr.querySelectorAll('td')].map(parts))).toEqual([
   ['Fictional A Sdn Bhd','EPF','Feb 10, 2026 Before the due date','Feb 12, 2026 Receipt recorded'],
   ['Fictional A Sdn Bhd','SOCSO and EIS','Feb 16, 2026 After the due date','Not filed yet'],
   ['Fictional A Sdn Bhd','PCB (CP39)','Not prepared yet','Not filed yet'],
   ['Fictional A Sdn Bhd','HRD Corp levy','Not required this month','Not filed yet']]);
  const findings=[...view.container.querySelectorAll('[data-audit-finding]')];
  expect(findings.map(item=>[item.getAttribute('data-audit-finding'),item.getAttribute('data-state')])).toEqual([['preparer_closed_run','open'],['pay_without_attendance','open'],
   ['bank_change_before_pay_day','expected']]);
  expect(text(findings[0])).toContain('The same person processed and closed run 1. Flagged only: there is no second approver.');
  const dispose=findings[0].querySelector('form')!;
  expect([...dispose.querySelectorAll('input[type="hidden"]')].map(input=>`${input.getAttribute('name')}=${input.getAttribute('value')}`)).toEqual(['period=2026-01','finding=f-1']);
  expect([...dispose.querySelectorAll('select option')].map(option=>text(option))).toEqual(['Choose','Expected','Corrected','Not an issue','Escalated']);
  // An open finding with no acknowledgement can be acknowledged as standing "expected" for the company (no person here).
  const acknowledge=findings[0].querySelector('[data-acknowledge-finding]')!;
  expect([...acknowledge.querySelectorAll('input[type="hidden"]')].map(input=>`${input.getAttribute('name')}=${input.getAttribute('value')}`))
   .toEqual(['period=2026-01','control=preparer_closed_run',`target=${fx.A}`]);
  expect([...acknowledge.querySelectorAll('select option')].map(option=>text(option))).toEqual(['for the whole company']);
  expect(acknowledge.querySelector('button')?.getAttribute('aria-label')).toBe('Always expected · Same person processed and closed a run');
  // The acknowledged finding: listed with its reason, its disposition pre-filled from the acknowledgement, no second form.
  expect(text(findings[1].querySelector('[data-finding-acknowledged]'))).toBe('Expected (standing acknowledgement) · Cash-paid driver, never clocks in · for this person');
  expect((findings[1].querySelector('select[name="disposition"]') as HTMLSelectElement).value).toBe('expected');
  expect((findings[1].querySelector('input[name="note"]') as HTMLInputElement).value).toBe('Expected (standing acknowledgement): Cash-paid driver, never clocks in');
  expect(findings[1].querySelector('[data-acknowledge-finding]')).toBeNull();
  expect(findings[2].querySelector('form')).toBeNull();
  expect(text(findings[2])).toContain('Bank account changed on Jan 28, 2026, 3 days before pay day on Jan 31, 2026 (now ending 5566).');
  expect(text(findings[2])).toContain('Siti Fictional · E001');
  expect(text(findings[2])).toContain('Expected · Verified with the employee by phone.');
  const correction=view.container.querySelector('[data-audit-correction]')!;
  expect(correction.getAttribute('data-state')).toBe('missing');
  expect(text(correction)).toContain('Closed run 1 reopened');
  expect(text(correction)).toContain('Reason given: Overtime keyed after close');
  expect([...correction.querySelectorAll('select option')].map(option=>text(option))).toEqual(['Choose','Input arrived late','Input keyed wrongly','Employee data wrong','Pay set-up wrong',
   'Rule or formula','Exception not acted on','Statutory change','Other']);
  expect(text(view.container)).toContain('Never blocks a run: one person processing and closing is flagged only.');
  expect(text(view.container)).toContain('Calls no AI model: every check is a fixed rule.');
  expect(text(view.container)).toContain('Sponsor: Aisyah Fictional');
  expect(text(view.container.querySelector('[data-audit-opens-note]'))).toBe('Payslip opens are counted on the web, including PDF downloads. Opens in the mobile app are not counted yet.');
  // Settings and auditors, for the administrator's company.
  const admin=view.container.querySelector(`[data-audit-admin-company="${fx.A}"]`)!;
  const settings=admin.querySelector('[data-audit-settings]')!;
  expect([...settings.querySelectorAll('input')].map(input=>`${input.getAttribute('name')}=${input.getAttribute('value')??(input as HTMLInputElement).defaultValue}`))
   .toEqual(['period=2026-01',`target=${fx.A}`,'bankChangeDays=5','adjustmentThreshold=1800.00']);
  expect([...settings.querySelectorAll('label')].map(label=>text(label.querySelector('span')))).toEqual(['Bank change window (days before pay day)','Manual adjustment amount that needs a reason',
   'Same login processed and closed a run']);
  // Bounds and the preparer-closed setting (information only, or a finding), with the loosening rule said.
  expect(['min','max'].map(key=>settings.querySelector('input[name="bankChangeDays"]')?.getAttribute(key))).toEqual(['3','30']);
  expect(['min','max'].map(key=>settings.querySelector('input[name="adjustmentThreshold"]')?.getAttribute(key))).toEqual(['100','50000']);
  expect((settings.querySelector('select[name="preparerClosedMode"]') as HTMLSelectElement).value).toBe('finding');
  expect([...settings.querySelectorAll('select[name="preparerClosedMode"] option')].map(option=>text(option))).toEqual(['Information only (no finding)','Open a finding']);
  expect(text(settings)).toContain('loosens a control and needs a group administrator');
  expect(text(settings)).toContain('Version 2');
  expect(settings.querySelector('button')?.getAttribute('aria-label')).toBe('Save · Fictional A Sdn Bhd');
  expect([...admin.querySelectorAll('[data-audit-readers] li')].map(parts)).toEqual(['Lim Fictional · lim@fixture.test given Feb 1, 2026 Revoke']);
  expect(admin.querySelector('[data-audit-readers] button')?.getAttribute('aria-label')).toBe('Revoke · Lim Fictional · lim@fixture.test · Fictional A Sdn Bhd');
  expect([...admin.querySelectorAll('[data-audit-readers] form input')].map(input=>`${input.getAttribute('name')}=${input.getAttribute('value')}`)).toEqual(['period=2026-01','grant=g-1']);
  // The login already granted is not offered again; a login without an employee record is named by its short id.
  expect([...admin.querySelectorAll('[data-audit-grant] option')].map(option=>text(option))).toEqual(['Choose a login','Wong Fictional · wong@fixture.test',
   'Login without an employee record (00000000)']);
  expect(text(view.container)).toContain('Every grant and revocation is recorded.');
  // No loop switch for a company administrator; every control keeps a 44px target on a coarse pointer.
  expect(view.container.querySelector('[data-page-header] form')).toBeNull();
  for(const control of view.container.querySelectorAll('button,select,input:not([type="hidden"])'))expect(control.className,control.outerHTML.slice(0,80)).toContain('pointer-coarse:min-h-11');
 });

 it('a group administrator also switches the loop, and a pause per company is offered',async()=>{
  state.session=SESSIONS.groupAdmin;state.companies=2;
  const view=wrap('en',await page({company:fx.B}));
  expect(state.reads).toEqual(['default:10','companies',`detail:2026-01:${fx.B}`,`admin:${fx.B}`]);
  const form=view.container.querySelector('[data-page-header] form')!;
  expect([...form.querySelectorAll('input')].map(input=>`${input.getAttribute('name')}=${input.getAttribute('value')}`)).toEqual(['loop=loop_payroll_audit','from=detail','enabled=false']);
  expect(form.querySelector('button')?.getAttribute('aria-label')).toBe('Turn off · Audit loop');
  expect([...view.container.querySelectorAll('[data-loop-company] button')].map(button=>button.getAttribute('aria-label'))).toEqual(['Pause · Fictional A Sdn Bhd','Pause · Fictional B Sdn Bhd']);
  expect(state.access).toHaveLength(2);
 });

 it.each(['ms','zh','vi','ta','th'] as const)('%s: the column and the page render translated, with no missing message, saying AI Centre and never Noveri',async locale=>{
  state.locale=locale;state.session=SESSIONS.groupAdmin;
  const copy=messagesFor(locale);
  let view=wrap(locale,<AuditLoopColumn summary={fx.detail(1) as never} position={3} />);
  expect(screen.getByRole('heading',{level:3,name:copy.payrollAudit.column.titleNumbered.replace('{n}','3')})).toBeTruthy();
  expect(text(view.container)).not.toMatch(/noveri/i);
  cleanup();
  view=wrap(locale,await page({period:'2026-01',saved:'disposed'}));
  expect(screen.getByRole('heading',{level:1,name:copy.payrollAudit.name})).toBeTruthy();
  expect(text(view.container)).toContain(copy.payrollAudit.saved.disposed);
  expect(text(view.container)).not.toMatch(/noveri/i);
 });
});

describe('Phase 2 hardening: a read-only auditor',()=>{
 it('opens the page for their granted companies, read-only: no switch, capture, disposition, root cause, settings, grant or pause',async()=>{
  state.session=SESSIONS.employee;state.auditor=true;
  const view=wrap('en',await page({period:'2026-01'}));
  expect(state.reads).toEqual(['auditorCompanies','auditorDetail:2026-01:']);
  expect(state.access).toEqual([{surface:'audit_view',action:'view',companyId:fx.A,payPeriod:'2026-01'}]);
  expect(text(view.container.querySelector('[data-audit-read-only]'))).toBe('You have read-only auditor access to the companies listed here. You can read the evidence and download the audit pack; you cannot change anything.');
  expect(view.container.querySelectorAll('form:not([data-audit-filter])')).toHaveLength(0);
  expect(view.container.querySelector('[data-audit-administration]')).toBeNull();
  expect(view.container.querySelector('[data-loop-company]')).toBeNull();
  // The evidence is there, and the pack downloads.
  expect(view.container.querySelector(`[data-audit-company="${fx.A}"] a`)?.getAttribute('href')).toBe(`/control-tower/loops/loop_payroll_audit/pack?company=${fx.A}&period=2026-01`);
  expect([...view.container.querySelectorAll('[data-audit-finding]')].map(item=>item.getAttribute('data-state'))).toEqual(['open','open','expected']);
  expect(text(view.container.querySelector('[data-audit-finding="preparer_closed_run"]'))).toContain('Open: waiting for a payroll administrator.');
 });

 it('a login with no grant and no administrator role is still sent home before any read',async()=>{
  state.session=SESSIONS.employee;state.auditor=false;
  await expect(page()).rejects.toMatchObject({url:'/'});
  expect(state.reads).toEqual([]);
 });
});

describe('the administration card',()=>{
 it.each(['employee','manager'] as const)('is never read or shown for a %s',async role=>{
  state.session=SESSIONS[role];
  await expect(page({period:'2026-01'})).rejects.toMatchObject({url:'/'});
  expect(state.reads.filter(read=>read.startsWith('admin'))).toEqual([]);
 });
 it('shows defaults for a company with no settings yet',async()=>{
  state.session=SESSIONS.groupAdmin;state.companies=2;
  const view=wrap('en',await page({period:'2026-01'}));
  const second=view.container.querySelector(`[data-audit-admin-company="${fx.B}"]`)!;
  expect(text(second.querySelector('[data-audit-settings]'))).toContain('Defaults until changed');
  expect(text(second)).toContain('No auditor has access.');
 });
});
