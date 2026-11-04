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
 *    the acknowledged blocks (moved from Salary payroll), and every other open exception, with no verdict listed twice. */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen,within} from '@testing-library/react';
import type {ReactNode} from 'react';
import {NextIntlClientProvider} from 'next-intl';
import {withAiCentre} from './helpers/ai-centre-messages';
import en from '../messages/en.json';

const state=vi.hoisted(()=>({session:null as unknown,reads:[] as string[]}));
vi.mock('next/link',()=>({default:({children,prefetch:_prefetch,...props}:any)=><a {...props}>{children}</a>}));
vi.mock('next-intl/server',async()=>{
 const {createTranslator,createFormatter}=await import('next-intl');
 const {withAiCentre:merge}=await import('./helpers/ai-centre-messages');
 const messages=merge('en',(await import('../messages/en.json')).default as any);
 return {getTranslations:async(namespace:any)=>createTranslator({locale:'en',messages:messages as any,namespace,onError:error=>{throw error;}}),
  getFormatter:async()=>createFormatter({locale:'en',timeZone:'Asia/Kuala_Lumpur'})};
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
const row=(verdictId:string,name:string,disposition:'block'|'review')=>({verdictId,employmentId:'e-'+verdictId.slice(-2),batchId:'b-1',payPeriod:'2026-10',disposition,
 computedAt:new Date('2026-10-28T02:00:00Z'),resolution:null,resolvedAt:null,detectorsRun:['missing-bank-profile'],detectorsSkipped:[],employeeName:name,employeeCode:null,
 findings:[{detectorId:'missing-bank-profile',severity:disposition,facts:{bank:'none'},suggestedAction:null,narrative:null}]});
vi.mock('../core/payroll-anomaly',()=>({openExceptionsAcrossRuns:async()=>{state.reads.push('exceptions');return {rows:[row(V.fixed,'Aina Fictional','block'),
 row(V.acked,'Ben Fictional','block'),row(V.open,'Chong Fictional','review')],total:3,blocking:2,cappedOut:false};}}));
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

 it.each(['hrAdmin','groupAdmin'] as const)('%s: the counts over every open exception, then the two groups, then the rest, no verdict twice',async role=>{
  state.session=SESSIONS[role];
  const view=wrap(await ExceptionsPage({searchParams:Promise.resolve({})}));
  expect(state.reads.slice(0,2).sort()).toEqual(['exceptions','proposals']);
  // The acknowledged blocks of each month with an open block, for the companies the viewer may see.
  expect(state.reads[2]).toBe(`acknowledged:2026-10:${COMPANY}`);
  expect(text(view.container.querySelector('[data-exceptions-total]'))).toBe('3');
  expect(text(view.container.querySelector('[data-exceptions-blocking]'))).toBe('2');
  // Cause already fixed: the former Proposed actions, approving exactly what is on screen.
  const fixed=view.container.querySelector('#fixed-causes')!;
  expect(within(fixed as HTMLElement).getByRole('heading',{level:2}).textContent).toBe('Cause already fixed');
  expect([...fixed.querySelectorAll('input[name="verdictId"]')].map(input=>input.getAttribute('value'))).toEqual([V.fixed]);
  expect(within(fixed as HTMLElement).getByRole('button').textContent).toBe('Approve and close 1');
  // Acknowledged: the pre-filled resolve, returning to this page.
  const acked=view.container.querySelector('#acknowledged-blocks')!;
  expect((acked.querySelector('input[readonly]') as HTMLInputElement).value).toBe('Paid in cash at the site office');
  expect([...acked.querySelectorAll('input[type="hidden"]')].map(input=>`${input.getAttribute('name')}=${input.getAttribute('value')}`))
   .toEqual(['back=exceptions','period=2026-10',`target=${COMPANY}`,`verdict=${V.acked}`]);
  // The rest: only the exception in no group, with its three resolutions.
  expect([...view.container.querySelectorAll('[data-exception-row]')].map(el=>el.getAttribute('data-exception-row'))).toEqual([V.open]);
  expect(text(view.container.querySelector('[data-exceptions-grouped]'))).toBe('2 exceptions are listed in the groups above.');
  const rest=view.container.querySelector(`[data-exception-row="${V.open}"]`)!;
  expect([...rest.querySelectorAll('button')].map(button=>button.getAttribute('value'))).toEqual(['accepted','fixed_upstream','false_positive']);
  // No staffing figure on the page, and nothing names the retired overview.
  expect(text(view.container)).not.toMatch(/operators|staffing|headcount|Operations overview/i);
 });

 it('shows the fix approval\'s outcome, and its closed error codes only',async()=>{
  state.session=SESSIONS.hrAdmin;
  const view=wrap(await ExceptionsPage({searchParams:Promise.resolve({closed:'1',stale:'2',fixError:'<script>'})}));
  expect(text(view.container.querySelector('#fixed-causes [role="status"]'))).toContain('Closed 1 exception(s).');
  expect(view.container.textContent).not.toContain('<script>');
 });
});
