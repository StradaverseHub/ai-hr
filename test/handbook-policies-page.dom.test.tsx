/** @vitest-environment jsdom */
/** AI v2 Phase 2, P2-5 — AI Centre › Policies (the Living Handbook), rendered from fictional reads (core/handbook/policies.ts
 * policiesView is replaced by fixtures; the real service is covered by test/handbook-policies.test.ts).
 *
 * Per role: the tab for everyone between Operations and Insights; an employee reads the approved text only (no values,
 * no drift, no approval); a company administrator edits a draft, confirms values and sends it; the author of a settings
 * change sees that another administrator must approve it; a second group administrator approves; drift shows both
 * values with "Use the handbook" and "Update the handbook"; the claims service's simulation says it calculated the
 * figures. Every locale renders with no missing message and never says Noveri; every control keeps a 44px target on a
 * coarse pointer. Phase 2 hardening: each enforceable setting the text mentions shows how it is covered (a confirmed
 * value, or "text only, not enforced" with who marked it), and sending waits for every one; a disagreement between the
 * text and what the system will enforce is listed and approval waits; anyone who contributed to a settings change is
 * told another group administrator must approve it; text drift shows the words with no resolution buttons. Expected
 * text is written out by hand. */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen,within} from '@testing-library/react';
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
const LOCALES=['en','ms','zh','vi','ta','th'] as const;
const CATALOGUES={en,ms,zh,vi:vi_,ta,th};
const messagesFor=(locale:Locale)=>withAiCentre(locale,CATALOGUES[locale] as Record<string,unknown>);
const state=vi.hoisted(()=>({locale:'en' as 'en'|'ms'|'zh'|'vi'|'ta'|'th',view:null as unknown,reads:[] as unknown[]}));
vi.mock('next/link',()=>({default:({children,prefetch:_prefetch,...props}:any)=><a {...props}>{children}</a>}));
vi.mock('next/cache',()=>({revalidatePath:vi.fn()}));
vi.mock('next/navigation',()=>({redirect:vi.fn(),usePathname:()=>'/assistant',useSearchParams:()=>new URLSearchParams(),useRouter:()=>({refresh:vi.fn(),push:vi.fn()})}));
vi.mock('next-intl/server',async()=>{
 const {createTranslator:translator,createFormatter:formatter}=await import('next-intl');
 const {withAiCentre:merge}=await import('./helpers/ai-centre-messages');
 const all={en:(await import('../messages/en.json')).default,ms:(await import('../messages/ms.json')).default,zh:(await import('../messages/zh.json')).default,
  vi:(await import('../messages/vi.json')).default,ta:(await import('../messages/ta.json')).default,th:(await import('../messages/th.json')).default};
 return {getTranslations:async(namespace:any)=>translator({locale:state.locale,messages:merge(state.locale,all[state.locale] as any) as any,namespace,onError:error=>{throw error;}}),
  getFormatter:async()=>formatter({locale:state.locale,timeZone:'Asia/Kuala_Lumpur'}),getLocale:async()=>state.locale};
});
vi.mock('../app/assistant/policy-actions',()=>Object.fromEntries(['applyScheduledPolicyValueAction','approvePolicyAction','createPolicyAction','decidePolicyValueAction',
 'draftFromVersionAction','markTextOnlyAction','prepareFromDriftAction','readPolicyValuesAction','returnPolicyAction','saveDraftAction','submitPolicyAction'].map(name=>[name,vi.fn()])));
vi.mock('../core/handbook/policies',()=>({policiesView:async(_session:unknown,input:unknown)=>{state.reads.push(input);return state.view;}}));
import {AiCentrePolicies} from '../components/ai-centre/policies';
import {AiCentreTabs} from '../components/ai-centre/centre-tabs';
import {resolveServerTree} from './helpers/server-tree';

const C1='00000000-0000-4000-8000-0000000000c1',C2='00000000-0000-4000-8000-0000000000c2',P1='00000000-0000-4000-8000-0000000000d1',P2='00000000-0000-4000-8000-0000000000d2';
const V1='00000000-0000-4000-8000-0000000000e1',V0='00000000-0000-4000-8000-0000000000e0';
const COMPANIES=[{id:C1,name:'Fictional Alpha Sdn Bhd'},{id:C2,name:'Fictional Beta Sdn Bhd'}];
const BODY='Staff using their own car for work are reimbursed RM 0.60 per km for the first 500 km in a month and RM 0.45 per km after that. Claims must be submitted within 30 days.';
const span=(quote:string,part:string)=>({start:BODY.indexOf(quote),end:BODY.indexOf(quote)+quote.length,quote,part});
const VALUES=[
 {id:'00000000-0000-4000-8000-0000000000f1',setting:'claims.mileage_rates',target:{},targetName:'Mileage',value:{bands:[{fromKm:0,toKm:500,ratePerKm:0.6},{fromKm:500,toKm:null,ratePerKm:0.45}]},
  spans:[span('RM 0.60 per km','band.0.rate'),span('first 500 km','band.0.limit'),span('RM 0.45 per km','band.1.rate')],source:'model',decision:'confirmed',now:null,nowDefaulted:false,differs:true},
 {id:'00000000-0000-4000-8000-0000000000f2',setting:'claims.submit_within_days',target:{claimType:'MILEAGE'},targetName:'Mileage',value:{days:30},spans:[span('within 30 days','days')],
  source:'model',decision:null,now:{days:90},nowDefaulted:false,differs:true},
];
const LIST=[{id:P1,area:'claims',title:'Claims: mileage',inForce:null,open:{version:1,status:'draft'},drift:0},{id:P2,area:'leave',title:'Leave',inForce:7,open:null,drift:1}];
const version=(over:Record<string,unknown>={})=>({id:V1,version:1,status:'draft',effectiveFrom:'2027-01-01',origin:'written',authorName:'Aisyah Fictional',authorIsViewer:false,submittedByViewer:false,contributedByViewer:false,
 submittedAt:null,approvedAt:null,changesSettings:null,body:BODY,companies:[C1,C2],...over});
const detail=(over:Record<string,unknown>={},versionOver:Record<string,unknown>={})=>({id:P1,area:'claims',title:'Claims: mileage',current:version(versionOver),inForceId:null,
 versions:[version(versionOver)],values:VALUES,settings:['claims.mileage_rates','claims.submit_within_days'],sharedOk:true,canEdit:true,approvals:[],applications:[],drift:[],
 mentions:[],mismatches:[],
 impact:{from:'2025-11-01',to:'2026-11-01',mileage:{claimTypeId:'x',claims:412,changed:37,deltaSen:-1240000},deadline:{claimTypeId:'x',days:30,claims:412,late:6},people:4},...over});
const admin=(selected:unknown,isGroupAdmin=false)=>({role:'admin',today:'2026-11-03',companies:COMPANIES,isGroupAdmin,list:LIST,selected});
const SESSIONS={
 employee:{tenantId:'t',userId:'u1',roles:['employee'],grants:[{role:'employee',companyId:C1}]},
 hrAdmin:{tenantId:'t',userId:'u2',roles:['hr_admin'],grants:[{role:'hr_admin',companyId:C1}]},
 groupAdmin:{tenantId:'t',userId:'u3',roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]},
} as const;
const wrap=(locale:Locale,node:ReactNode)=>render(<NextIntlClientProvider locale={locale} messages={messagesFor(locale) as never} onError={error=>{throw error;}} timeZone="Asia/Kuala_Lumpur">
 <main className="relative min-w-0"><div className="min-w-0">{node}</div></main></NextIntlClientProvider>);
const text=(el:Node|null|undefined)=>(el?.textContent??'').replace(/\s+/g,' ').trim();
/** Text with a space between separate text nodes (adjacent elements, such as a badge after a title, or two buttons). */
const words=(el:Node|null|undefined)=>{if(!el)return '';const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT),out:string[]=[];while(walker.nextNode())out.push(walker.currentNode.textContent??'');return out.join(' ').replace(/\s+/g,' ').trim();};
const page=async(session:unknown,query:Record<string,string>={})=>resolveServerTree(<AiCentrePolicies session={session as never} query={query} />);
afterEach(()=>{cleanup();state.locale='en';state.view=null;state.reads=[];});

describe('the Policies tab',()=>{
 it.each([[false],[true]] as const)('is offered to everyone, between Operations and Insights (administrator %s)',(isAdmin)=>{
  wrap('en',<AiCentreTabs active="policies" isAdmin={isAdmin} />);
  const nav=screen.getByRole('navigation',{name:'AI Centre sections'});
  const links=within(nav).getAllByRole('link').map(link=>[text(link),link.getAttribute('href')]);
  expect(links).toEqual(isAdmin
   ?[['Ask','/assistant'],['Operations','/control-tower/loops'],['Insights','/assistant?view=insights'],['Policies','/policies'],
    ['Administration','/control-tower/agents/features'],['How it works','/assistant?view=how']]
   :[['Ask','/assistant'],['Policies','/policies'],['How it works','/assistant?view=how']]);
  expect(within(nav).getByRole('link',{current:'page'})).toHaveAttribute('href','/policies');
 });
});

describe('an employee',()=>{
 it('reads the approved text of their company\'s policies, and nothing a draft or an approval holds',async()=>{
  state.view={role:'reader',today:'2026-11-03',list:[{id:P2,area:'leave',title:'Leave',inForce:7,open:null,drift:0}],
   selected:{id:P2,area:'leave',title:'Leave',version:7,effectiveFrom:'2026-01-01',body:'Annual leave is 14 days a year.',settingNotes:[]}};
  const rendered=wrap('en',await page(SESSIONS.employee,{policy:P2}));
  expect(state.reads).toEqual([{policy:P2}]);
  expect(screen.getByRole('heading',{level:1,name:'Policies'})).toBeTruthy();
  expect(words(rendered.container.querySelector('[data-policy-list]'))).toBe('Handbook Leave Leave v7');
  expect(text(rendered.container.querySelector('[data-policy-status]'))).toBe('Version 7 · in force since Jan 1, 2026');
  expect(text(rendered.container.querySelector('[data-policy-text]'))).toBe('Annual leave is 14 days a year.');
  for(const selector of ['[data-policy-enforce]','[data-policy-drift]','[data-policy-approval]','[data-policy-impact]','[data-policy-new]','form'])
   expect(rendered.container.querySelector(selector),selector).toBeNull();
  expect(rendered.container.querySelector('[data-policy-badge="drift"]')).toBeNull();
  expect(rendered.container.querySelector('[data-policy-setting-notes]')).toBeNull();
 });
 it('sees the current setting beside an approved figure the system no longer applies, with the approved text unchanged',async()=>{
  const body='Mileage is reimbursed at RM1.00/km. Claims must be submitted within 30 days.';
  state.view={role:'reader',today:'2026-11-03',list:[{id:P1,area:'claims',title:'Mileage',inForce:2,open:null,drift:0}],
   selected:{id:P1,area:'claims',title:'Mileage',version:2,effectiveFrom:'2026-01-01',body,settingNotes:[
    {setting:'claims.mileage_rates',target:{},targetName:'Mileage',quote:'RM1.00/km',current:{bands:[{fromKm:0,toKm:null,ratePerKm:0.6}]},unavailable:false},
    {setting:'claims.submit_within_days',target:{claimType:'MILEAGE'},targetName:'Mileage',quote:'within 30 days',current:null,unavailable:true}]}};
  const rendered=wrap('en',await page(SESSIONS.employee,{policy:P1}));
  expect(text(rendered.container.querySelector('[data-policy-text]'))).toBe(body);
  expect([...rendered.container.querySelectorAll('[data-policy-setting-note]')].map(li=>[li.getAttribute('data-policy-setting-note'),text(li)])).toEqual([
   ['claims.mileage_rates','“RM1.00/km” (Mileage rates): the current setting is RM 0.60 per km from 0 km; HR has been told the handbook differs.'],
   ['claims.submit_within_days','“within 30 days”: the current setting could not be read just now. Ask your HR team before relying on this figure.']]);
  // A plain note in the page's own muted text: no new colour, nothing to press.
  expect(rendered.container.querySelector('[data-policy-setting-notes]')!.className).toBe('space-y-1 text-sm text-muted-foreground');
  expect(rendered.container.querySelector('[data-policy-setting-notes] button, [data-policy-setting-notes] form')).toBeNull();
 });
});

describe('an administrator\'s draft',()=>{
 it('shows the words with each value highlighted, what the system will enforce, the claims service\'s simulation and the approval rule',async()=>{
  state.view=admin(detail());
  const rendered=wrap('en',await page(SESSIONS.hrAdmin,{policy:P1}));
  expect(text(rendered.container.querySelector('[data-policy-status]'))).toBe('Draft v1 · written by Aisyah Fictional · applies to all 2 companies from Jan 1, 2027');
  expect([...rendered.container.querySelectorAll('[data-policy-span]')].map(mark=>text(mark))).toEqual(['RM 0.60 per km','first 500 km','RM 0.45 per km','within 30 days']);
  expect(text(rendered.container.querySelector('[data-policy-text]'))).toBe(BODY);
  const rows=[...rendered.container.querySelectorAll('[data-policy-enforce] tbody tr')].map(row=>[...row.querySelectorAll('td')].map(cell=>words(cell)));
  expect(rows).toEqual([
   ['Rate, 0 to 500 km','None (any amount)','RM 0.60 per km','Confirm Reject'],
   ['Rate after 500 km','RM 0.45 per km'],
   // The monthly wording of the mock-up's policy is shown as written, never as enforced: the claims service prices each claim.
   ['Shown as written. The claims service prices each claim\'s own distance against these bands and keeps no monthly total, so a monthly limit in your text is not enforced.'],
   ['Submit within (Mileage)','90 days','30 days','Confirm Reject']]);
  expect(rendered.container.querySelector('[data-policy-decision="confirmed"] button[aria-pressed="true"]')?.textContent).toBe('Confirm');
  expect(text(rendered.container.querySelector('[data-policy-enforce]'))).toContain('AI Centre read these 2 values from the highlighted words. You confirm each one; the owner service applies it after approval.');
  const impact=rendered.container.querySelector('[data-policy-impact]')!;
  expect(text(impact.querySelector('h4'))).toBe('If this had applied from Nov 2025 to Oct 2026');
  expect([...impact.querySelectorAll('[data-stat-cells] > div')].map(cell=>words(cell))).toEqual(['of 412 mileage claims would change 37','less paid in total RM 12,400.00',
   'of 412 claims late under the 30-day rule 6','people affected 4']);
  expect(text(impact.querySelector('[data-policy-impact-owner]'))).toBe('Calculated by the claims service on the last 12 months of real claims. AI Centre did not work out any amount.');
  expect(text(rendered.container.querySelector('[data-policy-rule]'))).toBe('When you send it, a group administrator approves it. A change to what the system enforces needs a second administrator: someone who did not write or send it.');
  // One value is undecided, so it cannot be sent yet.
  const send=screen.getByRole('button',{name:'Send for approval'});expect(send).toBeDisabled();
  expect(screen.getByRole('link',{name:'Edit text'})).toHaveAttribute('href',`/policies?policy=${P1}&edit=1`);
  expect(screen.getByRole('button',{name:'Read the values'})).toBeTruthy();
  expect(words(rendered.container.querySelector('[data-policy-list]'))).toBe('Handbook Leave Leave v7 1 drift Claims Claims: mileage draft New policy');
  for(const control of [...rendered.container.querySelectorAll('button, a[href], input, select, textarea')].filter(el=>!(el as HTMLInputElement).type||(el as HTMLInputElement).type!=='hidden'))
   expect(control.className,control.outerHTML.slice(0,80)).toMatch(/min-h-11|min-h-9|pointer-coarse:min-h-11/);
 });
 it('keeps a policy the system cannot enforce as text, marked not enforced yet',async()=>{
  state.view=admin(detail({area:'other',title:'Dress code',settings:[],values:[],impact:null},{body:'Smart casual from Monday to Thursday.'}));
  const rendered=wrap('en',await page(SESSIONS.hrAdmin,{policy:P1}));
  expect(words(rendered.container.querySelector('[data-policy-not-enforced]'))).toBe('Not enforced yet This policy is kept as text. AI Centre answers questions from its approved version; the system does not enforce it yet.');
  expect(screen.queryByRole('button',{name:'Read the values'})).toBeNull();
  expect(rendered.container.querySelector('[data-policy-impact]')).toBeNull();
 });
 it('offers the new policy form with the companies the administrator holds',async()=>{
  state.view=admin(null);
  const rendered=wrap('en',await page(SESSIONS.hrAdmin,{new:'1'}));
  const form=rendered.container.querySelector('[data-policy-form="new"]')!;
  expect([...form.querySelectorAll('input[name="companies"]')].map(box=>(box as HTMLInputElement).value)).toEqual([C1,C2]);
  expect([...form.querySelectorAll('select[name="area"] option')].map(o=>text(o))).toEqual(['Leave','Attendance and overtime','Claims','Allowances','People','Other']);
  expect(screen.getByRole('button',{name:'Save draft'})).toBeTruthy();
 });
});

describe('approval',()=>{
 const sent={status:'submitted',changesSettings:true,submittedAt:new Date('2026-11-03T02:00:00Z')};
 it('tells the author of a settings change that another group administrator must approve it',async()=>{
  state.view=admin(detail({values:VALUES.map(v=>({...v,decision:'confirmed'}))},{...sent,authorIsViewer:true,submittedByViewer:true}),true);
  const rendered=wrap('en',await page(SESSIONS.groupAdmin,{policy:P1}));
  expect(text(rendered.container.querySelector('[data-policy-rule]'))).toBe('This version changes what the system enforces, so a second administrator, who did not write or send it, must approve it before it applies.');
  expect(text(rendered.container.querySelector('[data-policy-second]'))).toBe('You wrote or sent this change, so another group administrator must approve it.');
  expect(screen.queryByRole('button',{name:'Approve and apply'})).toBeNull();
  expect(screen.queryByRole('button',{name:'Send for approval'})).toBeNull();
  expect(screen.queryByRole('button',{name:'Confirm'})).toBeNull();
 });
 it('offers a second group administrator Approve and apply, or Return to draft; a company administrator only waits',async()=>{
  state.view=admin(detail({values:VALUES.map(v=>({...v,decision:'confirmed'}))},sent),true);
  wrap('en',await page(SESSIONS.groupAdmin,{policy:P1}));
  expect(screen.getByRole('button',{name:'Approve and apply'})).toBeTruthy();
  expect(screen.getByRole('button',{name:'Return to draft'})).toBeTruthy();
  cleanup();
  state.view=admin(detail({values:VALUES.map(v=>({...v,decision:'confirmed'}))},sent),false);
  const rendered=wrap('en',await page(SESSIONS.hrAdmin,{policy:P1}));
  expect(screen.queryByRole('button',{name:'Approve and apply'})).toBeNull();
  expect(text(rendered.container.querySelector('[data-policy-approval]'))).toContain('Waiting for a group administrator to approve it.');
 });
 it('shows what each owner did once approved, and a text-only version needs one approval',async()=>{
  state.view=admin(detail({values:VALUES.map(v=>({...v,decision:'confirmed'})),inForceId:V1,impact:null,
   approvals:[{decision:'approved',approverName:'Brandon Fictional',submission:1,at:new Date('2026-11-03T02:00:00Z')}],
   applications:[{valueId:VALUES[0]!.id,setting:'claims.mileage_rates',status:'applied',applyOn:'2027-01-01',before:null,after:VALUES[0]!.value,ownerMessage:null,at:new Date()},
    {valueId:VALUES[1]!.id,setting:'claims.submit_within_days',status:'refused',applyOn:'2027-01-01',before:{days:90},after:null,ownerMessage:'Maximum receipt age must be a positive whole number of days',at:new Date()}],
   versions:[version({status:'approved',changesSettings:false}),version({id:V0,version:0,status:'approved'})]},{status:'approved',changesSettings:false,approvedAt:new Date()}),true);
  const rendered=wrap('en',await page(SESSIONS.groupAdmin,{policy:P1}));
  expect(text(rendered.container.querySelector('[data-policy-rule]'))).toBe('This version changes text only, so one approval publishes it.');
  expect(text(rendered.container.querySelector('[data-policy-approval] ul'))).toBe('Approved by Brandon Fictional on Nov 3, 2026');
  expect([...rendered.container.querySelectorAll('[data-policy-application]')].map(li=>text(li))).toEqual([
   'Mileage rates: applied by the claims service from Jan 1, 2027.','Submission window (Mileage): the claims service refused it: Maximum receipt age must be a positive whole number of days']);
  expect(screen.getByRole('button',{name:'Make this the draft'})).toBeTruthy();
 });
});

describe('drift',()=>{
 it('shows both values and offers Use the handbook and Update the handbook',async()=>{
  state.view=admin(detail({inForceId:V1,impact:null,values:VALUES.map(v=>({...v,decision:'confirmed'})),
   drift:[{kind:'value',valueId:VALUES[0]!.id,setting:'claims.mileage_rates',target:{},targetName:'Mileage',handbook:VALUES[0]!.value,quote:null,system:{bands:[{fromKm:0,toKm:null,ratePerKm:0.55}]},companies:[C1,C2]}]},
   {status:'approved',changesSettings:true,approvedAt:new Date()}),true);
  const rendered=wrap('en',await page(SESSIONS.groupAdmin,{policy:P1}));
  const drift=rendered.container.querySelector('[data-policy-drift]')!;
  expect(text(drift.querySelector('h4'))).toBe('Where the handbook and the system disagree');
  expect(text(drift.querySelector('[data-policy-drift-item] p'))).toBe('Mileage rates: the handbook says RM 0.60 per km from 0 to 500 km; RM 0.45 per km from 500 km; the claims service says RM 0.55 per km from 0 km. Applies to all 2 companies.');
  expect(within(drift as HTMLElement).getByRole('button',{name:'Use the handbook'})).toBeTruthy();
  expect(within(drift as HTMLElement).getByRole('button',{name:'Update the handbook'})).toBeTruthy();
 });
});

const MENTIONS=[{setting:'claims.mileage_rates',confirmed:false,textOnly:{byName:'Brandon Fictional',at:new Date('2026-11-03T02:00:00Z')}},
 {setting:'claims.submit_within_days',confirmed:false,textOnly:null},{setting:'leave.entitlement_days',confirmed:true,textOnly:null}];
const MISMATCHES=[{setting:'claims.mileage_rates',target:{},targetName:'Mileage',quote:'RM1.00/km',source:'text',valueId:null,enforced:{bands:[{fromKm:0,toKm:null,ratePerKm:0.6}]}}];
const TEXT_DRIFT={kind:'text',valueId:null,setting:'claims.mileage_rates',target:{},targetName:'Mileage',handbook:null,quote:'RM1.00/km',system:{bands:[{fromKm:0,toKm:null,ratePerKm:0.6}]},companies:[C1,C2]};

describe('Phase 2 hardening',()=>{
 it('a draft shows each mentioned setting\'s cover, offers Keep as text only, and waits to be sent until every one is covered',async()=>{
  state.view=admin(detail({values:VALUES.map(v=>({...v,decision:'confirmed'})),mentions:MENTIONS,mismatches:MISMATCHES}));
  const rendered=wrap('en',await page(SESSIONS.hrAdmin,{policy:P1}));
  const mentions=rendered.container.querySelector('[data-policy-mentions]')!;
  expect([...mentions.querySelectorAll('[data-policy-mention]')].map(li=>[li.getAttribute('data-policy-mention-state'),words(li)])).toEqual([
   ['text_only','Mileage rates · text only, not enforced (marked by Brandon Fictional on Nov 3, 2026) Undo text only'],
   ['needed','Claim submission windows · confirm a value for it, or keep it as text only, before sending Keep as text only'],
   ['confirmed','Leave entitlements · enforced from this policy once approved']]);
  expect([...mentions.querySelectorAll('form')].map(form=>[...form.querySelectorAll('input[type="hidden"]')].map(i=>[(i as HTMLInputElement).name,(i as HTMLInputElement).value])
   .filter(([name])=>name==='setting'||name==='marked'))).toEqual([[['setting','claims.mileage_rates'],['marked','false']],[['setting','claims.submit_within_days'],['marked','true']]]);
  // Every value is decided, but one mentioned setting is neither confirmed nor text only.
  expect(screen.getByRole('button',{name:'Send for approval'})).toBeDisabled();
  const mismatch=rendered.container.querySelector('[data-policy-mismatch]')!;
  expect(text(mismatch.querySelector('h4'))).toBe('Where your text disagrees with what the system will enforce');
  expect(text(mismatch.querySelector('[data-policy-mismatch-item]'))).toBe('“RM1.00/km” (Mileage rates): the claims service will enforce RM 0.60 per km from 0 km.');
  expect(text(mismatch)).toContain('Approval waits until they agree. Change the text, or confirm a value so that it is applied.');
  for(const control of [...rendered.container.querySelectorAll('button, a[href], input, select, textarea')].filter(el=>!(el as HTMLInputElement).type||(el as HTMLInputElement).type!=='hidden'))
   expect(control.className,control.outerHTML.slice(0,80)).toMatch(/min-h-11|min-h-9|pointer-coarse:min-h-11/);
 });
 it('a version waiting with a disagreement offers no approval to anyone, and says why',async()=>{
  state.view=admin(detail({mentions:MENTIONS.slice(0,1),mismatches:MISMATCHES},{status:'submitted',changesSettings:false}),true);
  const rendered=wrap('en',await page(SESSIONS.groupAdmin,{policy:P1}));
  expect(text(rendered.container.querySelector('[data-policy-blocked]'))).toBe('It cannot be approved while its text disagrees with what the system will enforce. Return it to draft to change the text.');
  expect(screen.queryByRole('button',{name:'Approve'})).toBeNull();
  expect(screen.queryByRole('button',{name:'Keep as text only'})).toBeNull();
  expect(screen.queryByRole('button',{name:'Undo text only'})).toBeNull();
 });
 it('tells a group administrator who contributed to a settings change, without writing or sending it, that another must approve it',async()=>{
  state.view=admin(detail({values:VALUES.map(v=>({...v,decision:'confirmed'}))},{status:'submitted',changesSettings:true,contributedByViewer:true}),true);
  const rendered=wrap('en',await page(SESSIONS.groupAdmin,{policy:P1}));
  expect(text(rendered.container.querySelector('[data-policy-second]'))).toBe('You wrote or sent this change, so another group administrator must approve it.');
  expect(screen.queryByRole('button',{name:'Approve and apply'})).toBeNull();
 });
 it('shows text drift with the handbook\'s words and what employees are told, and no resolution buttons for it',async()=>{
  state.view=admin(detail({inForceId:V1,impact:null,values:[],drift:[TEXT_DRIFT]},{status:'approved',changesSettings:false,approvedAt:new Date()}),true);
  const rendered=wrap('en',await page(SESSIONS.groupAdmin,{policy:P1}));
  const item=rendered.container.querySelector('[data-policy-drift-kind="text"]')!;
  expect(text(item.querySelector('p'))).toBe('Mileage rates: the handbook says “RM1.00/km”; the claims service says RM 0.60 per km from 0 km. Applies to all 2 companies.');
  expect(text(item.querySelector('[data-policy-drift-text-note]'))).toBe('Employees who ask AI Centre are given the system\'s setting, not this figure. Edit the text to match, or confirm a value in a new draft.');
  expect(within(item as HTMLElement).queryByRole('button')).toBeNull();
 });
});

describe('every locale',()=>{
 it.each(LOCALES.map(locale=>[locale]))('%s renders every Policies state with no missing message and never says Noveri',async(locale)=>{
  state.locale=locale;
  const views=[admin(detail()),admin(detail({values:VALUES.map(v=>({...v,decision:'confirmed'}))},{status:'submitted',changesSettings:true,authorIsViewer:true}),true),
   admin(detail({drift:[{kind:'value',valueId:VALUES[0]!.id,setting:'claims.mileage_rates',target:{},targetName:'Mileage',handbook:VALUES[0]!.value,quote:null,system:null,companies:[C1]},TEXT_DRIFT],inForceId:V1,
    applications:[{valueId:VALUES[1]!.id,setting:'claims.submit_within_days',status:'scheduled',applyOn:'2026-11-01',before:{days:90},after:{days:30},ownerMessage:null,at:new Date()}],
    values:VALUES.map(v=>({...v,decision:'confirmed'}))},{status:'approved',changesSettings:true,approvedAt:new Date()}),true),
   admin(null),{role:'reader',today:'2026-11-03',list:[],selected:null},
   admin(detail({mentions:MENTIONS,mismatches:MISMATCHES},{status:'submitted',changesSettings:false}),true),admin(detail({mentions:MENTIONS,mismatches:MISMATCHES})),
   admin(detail({values:VALUES.map(v=>({...v,decision:'confirmed'}))},{status:'submitted',changesSettings:true,contributedByViewer:true}),true),
   {role:'reader',today:'2026-11-03',list:[{id:P1,area:'claims',title:'Mileage',inForce:2,open:null,drift:0}],selected:{id:P1,area:'claims',title:'Mileage',version:2,effectiveFrom:'2026-01-01',
    body:'Mileage is reimbursed at RM1.00/km.',settingNotes:[{setting:'claims.mileage_rates',target:{},targetName:'Mileage',quote:'RM1.00/km',current:{bands:[{fromKm:0,toKm:null,ratePerKm:0.6}]},unavailable:false},
     {setting:'claims.submit_within_days',target:{},targetName:null,quote:'within 30 days',current:null,unavailable:true}]}}];
  const extra=[{saved:'text_only',error:'unmarked'},{saved:'text_only_withdrawn',error:'mismatch'}];
  for(const [i,view] of views.entries()){
   state.view=view;
   const rendered=wrap(locale,await page(i===4||i===8?SESSIONS.employee:SESSIONS.groupAdmin,{policy:P1,saved:'read',n:'2',r:'1',error:'same_administrator',...(i===3?{new:'1'}:{}),...(i>=5?extra[i%2]:{})}));
   expect(rendered.container.textContent).not.toMatch(/Noveri/);
   expect(rendered.container.textContent).not.toMatch(/aiCentre\.policies/);
   cleanup();
  }
 });
});
