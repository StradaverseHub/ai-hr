/** @vitest-environment jsdom */
/** AI Centre restructure (owner decisions 26–29, 4 November 2026): each fact in one place. Rendered with the real tab
 * components and the real Exceptions page, per role, from the same isAdmin and isGroupAdmin predicates the guards use.
 * Fictional data owners only; every expected value is written out.
 *
 *  - The tab bar per role: employee, manager, payroll partner and a read-only auditor get Ask · Policies · How it works;
 *    an HR administrator and a group administrator get Ask · Operations ▾ · Insights · Policies · Administration ▾ ·
 *    How it works. Delegated jobs is hidden for everyone.
 *  - Operations' second row: Loops · Payroll cycle · Exceptions · Record readiness (the payroll pages only with payroll);
 *    Administration's: Workers · Setup · Spend and providers, plus Build list for a group administrator only.
 *  - Exceptions, the one place an exception is resolved: the "cause already fixed" group (the former Proposed actions),
 *    the acknowledged blocks (moved from Salary payroll), and every open exception grouped in plain language (AI-native
 *    batch, 11 November 2026), with no verdict offered for a decision twice. */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen,within} from '@testing-library/react';
import type {ReactNode} from 'react';
import {NextIntlClientProvider} from 'next-intl';
import {withAiCentre} from './helpers/ai-centre-messages';
import en from '../messages/en.json';

const state=vi.hoisted(()=>({session:null as unknown,reads:[] as string[]}));
vi.mock('next/link',()=>({default:({children,prefetch:_prefetch,...props}:any)=><a {...props}>{children}</a>}));
vi.mock('next-intl/server',async()=>{
 const getLocale=async()=>'en';
 const {createTranslator,createFormatter}=await import('next-intl');
 const {withAiCentre:merge}=await import('./helpers/ai-centre-messages');
 const messages=merge('en',(await import('../messages/en.json')).default as any);
 return {getTranslations:async(namespace:any)=>createTranslator({locale:'en',messages:messages as any,namespace,onError:error=>{throw error;}}),
  getFormatter:async()=>createFormatter({locale:'en',timeZone:'Asia/Kuala_Lumpur'}),getLocale};
});
vi.mock('next/navigation',()=>({redirect:vi.fn((url:string)=>{throw Object.assign(Error('NEXT_REDIRECT'),{url});}),usePathname:()=>'/control-tower/exceptions',
 useSearchParams:()=>new URLSearchParams(),useRouter:()=>({refresh:vi.fn(),push:vi.fn()})}));
vi.mock('../lib/session',()=>({getSession:async()=>state.session}));
vi.mock('../core/entitlements',()=>({isModuleEnabled:()=>true,isModuleEnabledOrFalse:()=>true}));
// The three server actions Exceptions posts to, each its owner's existing action.
vi.mock('../app/payroll/actions',()=>({resolveAnomalyAction:vi.fn()}));
vi.mock('../app/control-tower/actions/actions',()=>({approveAgentActionAction:vi.fn()}));
vi.mock('../app/control-tower/loops/payroll-cycle/actions',()=>({resolveAcknowledgedBlockAction:vi.fn()}));
const V={fixed:'00000000-0000-4000-8000-0000000000a1',acked:'00000000-0000-4000-8000-0000000000a2',open:'00000000-0000-4000-8000-0000000000a3'};
const COMPANY='00000000-0000-4000-8000-0000000000c1';
vi.mock('../app/control-tower/exceptions/actions',()=>({markGroupExpectedAction:vi.fn()}));
// The grouped reader (app/control-tower/exceptions/data.ts) is the database's; its rows are fixtured here with the real
// pure grouping (lib/payroll-exceptions), so the page renders exactly what buildGroups describes.
const MISSING='missing-bank-profile.block.payment-method-not-set',SETUP='pay-without-attendance.review.-';
const item=(verdictId:string,name:string,checkId:string,severity:string,variant:string|null,facts:Record<string,unknown>)=>({verdictId,employmentId:'e-'+verdictId.slice(-2),
 batchId:'b-1',disposition:severity==='block'?'block':'review',computedAt:new Date('2026-10-28T02:00:00Z'),payPeriod:'2026-10',checkId,severity,variant,facts,narrative:null,
 name,employeeCode:null,currency:'MYR',signature:[`${checkId}:${severity}:${variant??'-'}`],runClosed:false});
vi.mock('../app/control-tower/exceptions/data',async()=>{
 const {buildGroups,groupKey}=await import('../lib/payroll-exceptions');
 // Built when the page reads, not when the mock is hoisted: the fixture constants exist by then.
 const fixture=()=>({groups:buildGroups([
  {checkId:'pay-without-attendance',severity:'review',variant:null,exceptions:1,people:1,companies:1,runs:1,companyNames:['Fictional Sdn Bhd']},
  {checkId:'missing-bank-profile',severity:'block',variant:'payment-method-not-set',exceptions:2,people:2,companies:1,runs:1,companyNames:['Fictional Sdn Bhd']},
 ]),
 items:[item(V.fixed,'Aina Fictional','missing-bank-profile','block','payment-method-not-set',{netPay:1200,paymentMethod:'unset',reason:'payment-method-not-set'}),
  item(V.acked,'Ben Fictional','missing-bank-profile','block','payment-method-not-set',{netPay:900,paymentMethod:'unset',reason:'payment-method-not-set'}),
  item(V.open,'Chong Fictional','pay-without-attendance','review',null,{netPay:2500,attendanceDays:0,approvedLeaveDays:0})]});
 return {GROUP_PAGE_SIZE:25,payPeriodsOf:async(_s:unknown,ids:string[])=>new Map(ids.map(id=>[id,'2026-10'])),pageReadAdmission:(_s:unknown,read:()=>Promise<unknown>)=>read(),
  groupedExceptions:async(_s:unknown,p:{focus?:{checkId:string;severity:string;variant:string|null}|null})=>{
   state.reads.push(p.focus?`exceptions:${groupKey(p.focus)}`:'exceptions');
   const {groups,items}=fixture();
   const listed=p.focus?items.filter(i=>groupKey(i)===groupKey(p.focus!)):items;
   const map=new Map<string,unknown[]>();for(const i of listed)map.set(groupKey(i),[...(map.get(groupKey(i))??[]),i]);
   return {total:3,blocking:2,buckets:{check:0,missing:2,setup:1},bucketsPartial:false,groups,groupsCapped:false,items:map,blockPeriods:['2026-10']};
  }};
});
vi.mock('../core/agent-actions',()=>({proposeActions:async()=>{state.reads.push('proposals');return [{type:{id:'close_fixed_upstream',blastRadiusCap:25},count:1,overCap:false,
 subjects:[{verdictId:V.fixed,name:'Aina Fictional',detectorId:'missing-bank-profile',cause:'no_bank_account'}]}];}}));
vi.mock('../core/loops/grouped-dispositions',()=>({acknowledgedBlocks:async(_s:unknown,input:{companyIds:string[];payPeriod:string})=>{state.reads.push(`acknowledged:${input.payPeriod}:${input.companyIds.join(',')}`);
 return [{verdictId:V.acked,batchId:'b-1',companyId:COMPANY,employmentId:'e-a2',personName:'Ben Fictional',detectors:['missing-bank-profile'],acknowledgementId:'ack-1',reason:'Paid in cash at the site office'}];}}));
vi.mock('../core/read',()=>({allowedCompanies:async()=>[{id:COMPANY}]}));
import ExceptionsPage from '../app/control-tower/exceptions/page';
import {AiCentreGroupTabs,AiCentreTabs} from '../components/ai-centre/centre-tabs';
import {isAdmin,isGroupAdmin} from '../lib/authz-model';

const TENANT='00000000-0000-4000-8000-0000000000aa';
const SESSIONS={
 employee:{tenantId:TENANT,userId:'00000000-0000-4000-8000-000000000001',roles:['employee'],grants:[{role:'employee',companyId:COMPANY}]},
 manager:{tenantId:TENANT,userId:'00000000-0000-4000-8000-000000000002',roles:['employee','manager'],grants:[{role:'manager',companyId:COMPANY}]},
 payroll:{tenantId:TENANT,userId:'00000000-0000-4000-8000-000000000003',roles:['payroll_partner'],grants:[{role:'payroll_partner',companyId:COMPANY}]},
 hrAdmin:{tenantId:TENANT,userId:'00000000-0000-4000-8000-000000000004',roles:['hr_admin'],grants:[{role:'hr_admin',companyId:COMPANY}]},
 groupAdmin:{tenantId:TENANT,userId:'00000000-0000-4000-8000-000000000005',roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]},
 // A read-only auditor: an employee login with an audit-reader grant (the layout admits them for the Audit loop page only).
 auditor:{tenantId:TENANT,userId:'00000000-0000-4000-8000-000000000006',roles:['employee'],grants:[{role:'employee',companyId:COMPANY}]},
} as const;
type Role=keyof typeof SESSIONS;
const messages=withAiCentre('en',en as Record<string,unknown>);
const wrap=(node:ReactNode)=>render(<NextIntlClientProvider locale="en" messages={messages as never} onError={error=>{throw error;}} timeZone="Asia/Kuala_Lumpur">{node}</NextIntlClientProvider>);
const links=(nav:HTMLElement)=>within(nav).getAllByRole('link').map(link=>[link.textContent,link.getAttribute('href')]);
const text=(el:Element|null)=>(el?.textContent??'').replace(/\s+/g,' ').trim();
afterEach(()=>{cleanup();state.session=null;state.reads=[];});

const EVERYONE=[['Ask','/assistant'],['Policies','/policies'],['How it works','/assistant?view=how']];
const ADMIN=[['Ask','/assistant'],['Operations','/control-tower/loops'],['Insights','/assistant?view=insights'],['Policies','/policies'],
 ['Administration','/control-tower/agents/features'],['How it works','/assistant?view=how']];

describe('each role\'s tab bar',()=>{
 it.each([['employee',false],['manager',false],['payroll',false],['hrAdmin',true],['groupAdmin',true],['auditor',false]] as const)('%s',(role:Role,admitted)=>{
  expect(isAdmin(SESSIONS[role] as never)).toBe(admitted);
  wrap(<AiCentreTabs active="ask" isAdmin={isAdmin(SESSIONS[role] as never)}/>);
  const nav=screen.getByRole('navigation',{name:'AI Centre sections'});
  expect(links(nav)).toEqual(admitted?ADMIN:EVERYONE);
  // Delegated jobs is hidden until it works, for everyone; nobody is linked to the forwarded Overview.
  expect(nav.querySelector('a[href*="view=jobs"],a[href="/control-tower"]')).toBeNull();
  expect(nav.querySelectorAll('[data-centre-group-mark]')).toHaveLength(admitted?2:0);
  for(const link of within(nav).getAllByRole('link'))expect(link.className).toContain('min-h-11');
 });
});

describe('the group tabs\' second rows',()=>{
 it.each([['hrAdmin'],['groupAdmin']] as const)('%s: Operations is Loops · Payroll cycle · Exceptions · Record readiness',(role:Role)=>{
  wrap(<AiCentreGroupTabs group="operations" active="loops" payroll groupAdmin={isGroupAdmin(SESSIONS[role] as never)}/>);
  expect(links(screen.getByRole('navigation',{name:'Operations sections'}))).toEqual([['Loops','/control-tower/loops'],
   ['Payroll cycle','/control-tower/loops/payroll-cycle'],['Exceptions','/control-tower/exceptions'],['Record readiness','/control-tower/readiness']]);
 });
 it('without payroll the payroll pages leave the row',()=>{
  wrap(<AiCentreGroupTabs group="operations" active="readiness" payroll={false}/>);
  expect(links(screen.getByRole('navigation',{name:'Operations sections'}))).toEqual([['Loops','/control-tower/loops'],['Record readiness','/control-tower/readiness']]);
 });
 it.each([['hrAdmin',false],['groupAdmin',true]] as const)('%s: Administration, with the Build list only for a group administrator',(role:Role,group)=>{
  expect(isGroupAdmin(SESSIONS[role] as never)).toBe(group);
  wrap(<AiCentreGroupTabs group="administration" active="workers" payroll={false} groupAdmin={isGroupAdmin(SESSIONS[role] as never)}/>);
  const row=links(screen.getByRole('navigation',{name:'Administration sections'}));
  expect(row).toEqual([['Workers','/control-tower/agents/features'],['Setup','/control-tower/agents'],['Spend and providers','/control-tower/agents/allowances'],
   ...(group?[['Build list','/control-tower/agents/build-list']]:[])]);
 });
});

describe('Exceptions, the one place an exception is resolved (owner decision 28)',()=>{
 it.each(['employee','manager','payroll','auditor'] as const)('%s is refused before anything is read',async role=>{
  state.session=SESSIONS[role];
  await expect(ExceptionsPage({searchParams:Promise.resolve({})})).rejects.toMatchObject({url:'/'});
  expect(state.reads).toEqual([]);
 });

 it.each(['hrAdmin','groupAdmin'] as const)('%s: the counts over every open exception, the two groups, then every pattern in plain words',async role=>{
  state.session=SESSIONS[role];
  const view=wrap(await ExceptionsPage({searchParams:Promise.resolve({})}));
  expect(state.reads.slice(0,2).sort()).toEqual(['exceptions','proposals']);
  // The acknowledged blocks of each month with an open block, for the companies the viewer may see.
  expect(state.reads[2]).toBe(`acknowledged:2026-10:${COMPANY}`);
  const head=view.container.querySelector('[data-exceptions-total]')!;
  expect([head.getAttribute('data-exceptions-total'),head.getAttribute('data-exceptions-blocking')]).toEqual(['3','2']);
  expect(text(head)).toBe('3 waiting · 2 from blocking checks · grouped into 2 patterns');
  expect([...view.container.querySelectorAll('[data-exceptions-bucket]')].map(text)).toEqual([
   '0look like real pay errors · check each one','2missing details · one fix per person','1look like your setup, not errors']);
  // Cause already fixed: the former Proposed actions, approving exactly what is on screen.
  const fixed=view.container.querySelector('#fixed-causes')!;
  expect(within(fixed as HTMLElement).getByRole('heading',{level:2}).textContent).toBe('Cause already fixed');
  expect([...fixed.querySelectorAll('input[name="verdictId"]')].map(input=>input.getAttribute('value'))).toEqual([V.fixed]);
  expect(within(fixed as HTMLElement).getByRole('button').textContent).toBe('Approve and close 1');
  expect(text(fixed.querySelector('[data-fix-subject] p:nth-child(1)'))).toBe('Aina FictionalOctober 2026');
  expect(text(fixed.querySelector('[data-fix-subject] p:nth-child(2)'))).toBe('No bank account to pay into · bank account now on file');
  // Acknowledged: the pre-filled resolve, returning to this page.
  const acked=view.container.querySelector('#acknowledged-blocks')!;
  expect((acked.querySelector('input[readonly]') as HTMLInputElement).value).toBe('Paid in cash at the site office');
  expect([...acked.querySelectorAll('input[type="hidden"]')].map(input=>`${input.getAttribute('name')}=${input.getAttribute('value')}`))
   .toEqual(['back=exceptions','period=2026-10',`target=${COMPANY}`,`verdict=${V.acked}`]);
  // The patterns, worst bucket first: missing details (blocking) before the set-up pattern.
  expect([...view.container.querySelectorAll('[data-exceptions-pattern]')].map(el=>el.getAttribute('data-exceptions-pattern'))).toEqual([MISSING,SETUP]);
  const missing=view.container.querySelector(`[data-exceptions-pattern="${MISSING}"]`)!;
  expect(text(missing.querySelector('h2'))).toBe('We don’t know how to pay these people · 2 people');
  expect(text(missing.querySelector('[data-group-tag]'))).toBe('Blocks payroll');
  expect(within(missing as HTMLElement).getAllByRole('link').map(a=>[a.textContent,a.getAttribute('href')])).toEqual([
   ['Fix the records',`/control-tower/exceptions?group=${encodeURIComponent(MISSING)}#exceptions-group`],
   ['Set how they’re paid','/admin/personnel/e-a1?tab=payroll'],['Set how they’re paid','/admin/personnel/e-a2?tab=payroll'],
   ['See who has been asked for details','/control-tower/readiness']]);
  expect(text(missing.querySelector(`[data-exception-preview="${V.fixed}"] > span`)))
   .toBe('Aina Fictional · October 2026 · Their record doesn’t say how they’re paid. Take-home pay: RM 1,200.00.');
  // A blocking pattern offers no bulk decision and no resolution form on the overview.
  expect(missing.querySelector('form')).toBeNull();
  const setup=view.container.querySelector(`[data-exceptions-pattern="${SETUP}"]`)!;
  expect(text(setup.querySelector('[data-group-tag]'))).toBe('Looks like setup');
  expect(within(setup as HTMLElement).getAllByRole('link')[0].textContent).toBe('Review and mark as expected');
  expect(text(setup)).toContain('Companies: Fictional Sdn Bhd');
  expect(text(setup)).toContain('Chong Fictional · October 2026 · Paid RM 2,500.00, with no attendance and no approved leave this month.');
  // Plain words only: no check ids, field names or internal terms on the page.
  expect(text(view.container)).not.toMatch(/missing-bank-profile|pay-without-attendance|paymentMethod|netPay|verdict|detector|[0-9a-f]{8}-[0-9a-f]{4}-/i);
  // No staffing figure on the page, and nothing names the retired overview.
  expect(text(view.container)).not.toMatch(/operators|staffing|headcount|Operations overview/i);
 });

 it('a set-up pattern opens into its list: one bulk "Mark as expected" for what is on screen, and each one\'s three resolutions',async()=>{
  state.session=SESSIONS.hrAdmin;
  const view=wrap(await ExceptionsPage({searchParams:Promise.resolve({group:SETUP})}));
  expect(state.reads).toContain(`exceptions:${SETUP}`);
  const focus=view.container.querySelector('[data-exceptions-focus]')!;
  const bulk=focus.querySelector('[data-bulk-expect]')!;
  expect([...bulk.querySelectorAll('input[type="hidden"]')].map(input=>`${input.getAttribute('name')}=${input.getAttribute('value')}`))
   .toEqual([`group=${SETUP}`,`verdictId=${V.open}`]);
  expect((bulk.querySelector('input[name="note"]') as HTMLInputElement).required).toBe(true);
  expect(within(bulk as HTMLElement).getByRole('button').textContent).toBe('Mark this one as expected');
  const rowEl=focus.querySelector(`[data-exception-row="${V.open}"]`)!;
  expect([...rowEl.querySelectorAll('button')].map(button=>button.getAttribute('value'))).toEqual(['accepted','fixed_upstream','false_positive']);
  expect([...rowEl.querySelectorAll('input[type="hidden"]')].map(input=>`${input.getAttribute('name')}=${input.getAttribute('value')}`))
   .toEqual(['batchId=b-1',`verdictId=${V.open}`,'returnTo=tower']);
 });

 it('a blocking pattern opens into a one-by-one list: never a bulk form, and what is offered above is pointed there',async()=>{
  state.session=SESSIONS.hrAdmin;
  const view=wrap(await ExceptionsPage({searchParams:Promise.resolve({group:MISSING})}));
  const focus=view.container.querySelector('[data-exceptions-focus]')!;
  expect(focus.querySelector('[data-bulk-expect]')).toBeNull();
  expect(focus.querySelector(`[data-exception-row="${V.fixed}"] [data-offered-above]`)).not.toBeNull();
  expect(focus.querySelector(`[data-exception-row="${V.fixed}"] form`)).toBeNull();
  expect(focus.querySelector(`[data-exception-row="${V.acked}"] [data-offered-above]`)).not.toBeNull();
 });

 it('says the bulk outcome and its closed error codes only',async()=>{
  state.session=SESSIONS.hrAdmin;
  let view=wrap(await ExceptionsPage({searchParams:Promise.resolve({expected:'4',expectedSkipped:'1',expectedDecided:'2',expectedSuperseded:'1',expectedNotYours:'1'})}));
  expect([...view.container.querySelectorAll('[data-bulk-result] p')].map(text)).toEqual(['4 exceptions were marked as expected.',
   '1 was left open because it had changed or isn’t yours to decide.','2 had already been decided by someone else, so those decisions stand.',
   '1 was checked again since this page opened, so it is left open. The new result is listed instead.',
   '1 is for a payroll you don’t manage, so it was left open.']);
  cleanup();
  view=wrap(await ExceptionsPage({searchParams:Promise.resolve({bulkError:'<script>'})}));
  expect(view.container.textContent).not.toContain('<script>');
  cleanup();
  view=wrap(await ExceptionsPage({searchParams:Promise.resolve({bulkError:'blocking'})}));
  expect(view.container.textContent).toContain('Exceptions that block a run are never cleared in one go. Check each one.');
 });

 it('shows the fix approval\'s outcome, and its closed error codes only',async()=>{
  state.session=SESSIONS.hrAdmin;
  const view=wrap(await ExceptionsPage({searchParams:Promise.resolve({closed:'1',stale:'2',fixError:'<script>'})}));
  expect(text(view.container.querySelector('#fixed-causes [role="status"]'))).toContain('Closed 1 exception(s).');
  expect(view.container.textContent).not.toContain('<script>');
 });
});
