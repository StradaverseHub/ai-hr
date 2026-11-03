/** @vitest-environment jsdom */
/** AI v2 Phase 2, P2-6 — AI Centre › Insights › AI quality, rendered from a fictional read (core/learning/quality.ts is
 * replaced by a fixture; the real service is covered by test/learning-loops.test.ts and the arithmetic by
 * test/learning-loops-rules.test.ts).
 *
 * Who sees it: HR and group administrators. An employee's or a manager's Insights page has no AI quality section and reads
 * nothing of it. In the section: the four figures, each a percentage with its counts; the confirmed-unchanged share by
 * month drawn to scale from 0 to 100%; the biggest gaps with their redacted examples and status; the corrections to
 * review, with "Make an eval candidate" and "Dismiss"; the candidates with their state's actions; the loops' proposals with
 * approve, reject and revert; each loop's corrections by month; the method note. Owner rule: no ratio of HR staff to
 * employees appears on the rendered page, in any language. Every locale renders with no missing message and never says
 * Noveri; every control keeps a 44px target on a coarse pointer. Expected text is written out by hand. */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen,within} from '@testing-library/react';
import type {ReactNode} from 'react';
import {NextIntlClientProvider} from 'next-intl';
import {withAiCentre} from './helpers/ai-centre-messages';
import {resolveServerTree} from './helpers/server-tree';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import vi_ from '../messages/vi.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';

type Locale='en'|'ms'|'zh'|'vi'|'ta'|'th';
const LOCALES=['en','ms','zh','vi','ta','th'] as const;
const CATALOGUES={en,ms,zh,vi:vi_,ta,th};
const messagesFor=(locale:Locale)=>withAiCentre(locale,CATALOGUES[locale] as Record<string,unknown>) as Record<string,any>;
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
vi.mock('../app/assistant/learning-actions',()=>Object.fromEntries(['approveCandidateAction','decideProposalAction','dismissSignalAction','editCandidateAction','exportCandidateAction',
 'promoteSignalAction','reopenCandidateAction','reopenSignalAction','revertProposalAction','setGapStatusAction','withdrawCandidateAction','recordCardSignalAction','markAnswerAction'].map(name=>[name,vi.fn()])));
vi.mock('../core/learning/quality',async()=>({aiQuality:async(_session:unknown,input:unknown)=>{state.reads.push(['quality',input]);return state.view;}}));
// The rest of Insights, as markers or empty reads (their own tests: capacity-ledger-page.dom.test.tsx, before-payroll.dom.test.tsx).
vi.mock('../components/ai-centre/capacity-ledger',()=>({CapacityLedgerSection:()=><section data-capacity-ledger-marker/>}));
vi.mock('../core/pre-salary/person-items',()=>({readMyPayrollReadiness:async()=>{state.reads.push(['readiness']);return null;}}));
vi.mock('../app/assistant/loop-clock-out-actions',()=>({confirmMissedClockOutAction:vi.fn()}));
vi.mock('../app/assistant/payroll-readiness-actions',()=>({answerTp3PreviousEmployerAction:vi.fn()}));
import {AiQualitySection} from '../components/ai-centre/ai-quality';
import {AiCentreInsights} from '../components/ai-centre/insights';
import {isAdmin} from '../lib/authz-model';

const C1='00000000-0000-4000-8000-0000000000c1',C2='00000000-0000-4000-8000-0000000000c2';
const S1='00000000-0000-4000-8000-0000000000d1',S2='00000000-0000-4000-8000-0000000000d2',K1='00000000-0000-4000-8000-0000000000e1',K2='00000000-0000-4000-8000-0000000000e2';
const D1='00000000-0000-4000-8000-0000000000f1';
const COMPANIES=[{id:C1,name:'Fictional Alpha Sdn Bhd'},{id:C2,name:'Fictional Beta Sdn Bhd'}];
const share=(part:number,whole:number)=>({part,whole,share:whole?part/whole:null});
const view=(over:Record<string,unknown>={})=>({period:'last30',periodFrom:'2026-10-05',today:'2026-11-03',companies:COMPANIES,companyId:null,
 figures:{helpful:share(18,24),prepared:{decided:40,chatCards:15,loopCards:25,unchanged:share(30,40),edited:share(6,40),discarded:share(4,40)},
  gaps:{openIntents:2,questions:12,openQuestions:share(9,12)},
  trend:[['2026-06',0,0],['2026-07',0,0],['2026-08',0,0],['2026-09',6,8],['2026-10',27,36],['2026-11',3,4]].map(([month,unchanged,decided])=>({month,unchanged,decided,share:decided?(unchanged as number)/(decided as number):null}))},
 gaps:[
  {intentKey:'not_supported:payroll',kind:'not_supported',area:'payroll',count:7,roles:['employee','manager'],statuses:[{companyId:C1,status:'open',duplicateOf:null}],status:'open',rank:1,
   examples:['Can you show me the payslip of {{NAME_A}} {{NAME_B}}?','Boleh anda jalankan gaji bulan ini?']},
  {intentKey:'cannot_answer:leave',kind:'cannot_answer',area:'leave',count:3,roles:['employee'],statuses:[{companyId:C1,status:'planned',duplicateOf:null},{companyId:C2,status:'open',duplicateOf:null}],status:null,rank:2,examples:[]},
 ],
 corrections:[
  {id:S1,companyId:C1,kind:'card_edited',action:'leave.apply',area:'leave',role:'employee',locale:'ms',at:new Date('2026-11-01T02:00:00Z'),reason:null,example:null},
  {id:S2,companyId:C2,kind:'answer_unhelpful',action:'answer',area:'payroll',role:'manager',locale:'en',at:new Date('2026-10-30T02:00:00Z'),reason:'not_what_asked',example:'How much is {{NAME_A}} paid?'},
 ],
 candidates:[
  {id:K1,companyId:C1,signalId:S1,intentKey:null,role:'employee',locale:'en',kind:'do',factor:'doing',question:'Can {{NAME_A}} take leave next Friday?',expectation:'Prepares the leave card.',
   state:'draft',version:2,changedAt:new Date('2026-11-02T02:00:00Z'),approvedAt:null,exportedAt:null},
  {id:K2,companyId:C1,signalId:null,intentKey:'not_supported:payroll',role:'hr_admin',locale:'en',kind:'honest_gap',factor:'capability',question:'Can you run payroll for me?',
   expectation:'Says it cannot and links the payroll page.',state:'approved',version:3,changedAt:new Date('2026-11-02T03:00:00Z'),approvedAt:new Date('2026-11-02T03:00:00Z'),exportedAt:null},
 ],
 proposals:[
  {state:'open',companyId:C1,loop:'loop_salary_payroll',kind:'threshold',proposalKey:'a'.repeat(64),decisionId:null,fromThresholdBp:1500,toThresholdBp:2300,pattern:null,
   evidence:{windowDays:30,flags:5,expected:5,problems:0,expectedShareBp:10000,smallestProblemBp:null},decidedAt:null},
  {state:'applied',companyId:C2,loop:'loop_salary_payroll',kind:'exclusion',proposalKey:null,decisionId:D1,fromThresholdBp:1500,toThresholdBp:null,pattern:'cause:salary_change',
   evidence:{windowDays:30,flags:6,expected:6,problems:0,expectedShareBp:10000,smallestProblemBp:null},decidedAt:new Date('2026-10-28T02:00:00Z')},
 ],
 patternNames:{},
 loopCorrections:[{loop:'loop_missed_clock_outs',months:[['2026-09',0,0],['2026-10',250,2],['2026-11',40,0]].map(([month,decided,corrected])=>({month,decided,corrected,share:decided?(corrected as number)/(decided as number):null}))}],
 ...over});

const TENANT='00000000-0000-4000-8000-0000000000a1';
const SESSIONS={
 employee:{tenantId:TENANT,userId:'00000000-0000-4000-8000-000000000001',roles:['employee'],grants:[{role:'employee',companyId:C1}]},
 manager:{tenantId:TENANT,userId:'00000000-0000-4000-8000-000000000002',roles:['employee','manager'],grants:[{role:'manager',companyId:C1}]},
 hrAdmin:{tenantId:TENANT,userId:'00000000-0000-4000-8000-000000000003',roles:['hr_admin'],grants:[{role:'hr_admin',companyId:C1}]},
 groupAdmin:{tenantId:TENANT,userId:'00000000-0000-4000-8000-000000000004',roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]},
} as const;
const wrap=(locale:Locale,node:ReactNode)=>render(<NextIntlClientProvider locale={locale} messages={messagesFor(locale) as never} onError={error=>{throw error;}} timeZone="Asia/Kuala_Lumpur">
 <main className="relative min-w-0"><div className="min-w-0">{node}</div></main></NextIntlClientProvider>);
const text=(el:Node|null|undefined)=>(el?.textContent??'').replace(/\s+/g,' ').trim();
const section=async(query:Record<string,string>={},session:unknown=SESSIONS.groupAdmin)=>AiQualitySection({session:session as never,query});
const cells=(row:Element)=>[...row.querySelectorAll('th,td')].map(cell=>text(cell));
afterEach(()=>{cleanup();state.locale='en';state.view=null;state.reads=[];});

/** Owner rule (3 November 2026): no "HR staff per 100 employees" ratio on any screen HR uses, in any language. */
const RATIO=[/per\s*100\b/i,/per\s+hundred/i,/staff\s+per\b/i,/staff[-\s]+to[-\s]+employee/i,/\bratio\b/i,/\bFTE\b/,/full[-\s]time\s+equivalent/i,
 /setiap\s+100/i,/nisbah/i,/每\s*(百|100)/,/比率/,/tỷ\s*lệ/i,/trên\s+100/i,/விகிதம்/,/อัตราส่วน/,/ต่อ\s*100/];

describe('who sees AI quality',()=>{
 it.each([['employee',false],['manager',false],['hrAdmin',true],['groupAdmin',true]] as const)('%s: the section is for administrators only, and nothing is read for anyone else',async(role,admitted)=>{
  state.view=view();
  const session=SESSIONS[role] as never;
  expect(isAdmin(session)).toBe(admitted);
  const rendered=wrap('en',await resolveServerTree(<AiCentreInsights session={session} scopeIds={[C1]} isAdmin={isAdmin(session)} qualityQuery={{qperiod:'quarter'}} />));
  if(admitted){
   expect(rendered.container.querySelectorAll('[data-ai-quality]')).toHaveLength(1);
   expect(screen.getByRole('heading',{level:2,name:'AI quality'})).toBeTruthy();
   expect(state.reads).toEqual([['readiness'],['quality',{period:'quarter',companyId:undefined}]]);
   // After the HR capacity ledger.
   const ledger=rendered.container.querySelector('[data-capacity-ledger-marker]')!,quality=rendered.container.querySelector('[data-ai-quality]')!;
   expect(ledger.compareDocumentPosition(quality)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }else{
   expect(rendered.container.querySelector('[data-ai-quality]')).toBeNull();
   expect(state.reads).toEqual([['readiness']]);
  }
  for(const pattern of RATIO)expect(rendered.container.textContent??'').not.toMatch(pattern);
 });
});

describe('AI quality, as an administrator',()=>{
 it('shows the four figures, each a percentage with its counts',async()=>{
  state.view=view();
  const rendered=wrap('en',await section({qperiod:'last30'}));
  expect(text(rendered.container)).toContain('How people used AI Centre’s answers and prepared actions in your companies, what it could not do, and what the loops propose.');
  expect([...rendered.container.querySelectorAll('[data-stat-cells] > div')].map(cell=>[text(cell.querySelector('dt')),text(cell.querySelector('dd'))])).toEqual([
   ['Answers marked helpful','75%18 of 24 marked answers'],
   ['Prepared actions confirmed unchanged','75%30 of 40; edited 15% (6)'],
   ['Prepared actions discarded','10%4 of 40'],
   ['Open gaps','275% of questions it could not meet: 9 of 12'],
  ]);
  // The period links keep the company filter, and the current one is marked.
  const periods=within(rendered.container.querySelector('[data-quality-period]') as HTMLElement).getAllByRole('link');
  expect(periods.map(link=>[text(link),link.getAttribute('href'),link.getAttribute('aria-current')])).toEqual([
   ['Last 30 days','/assistant?view=insights&qperiod=last30#ai-quality','true'],['This quarter','/assistant?view=insights&qperiod=quarter#ai-quality',null],
   ['This year','/assistant?view=insights&qperiod=year#ai-quality',null]]);
  // Two companies: the filter lists both.
  const filter=rendered.container.querySelector('[data-quality-company-filter] select') as HTMLSelectElement;
  expect([...filter.options].map(option=>[option.value,option.textContent])).toEqual([['','All 2 companies'],[C1,'Fictional Alpha Sdn Bhd'],[C2,'Fictional Beta Sdn Bhd']]);
 });

 it('draws the confirmed-unchanged share by month from 0 to 100%, with a description for screen readers',async()=>{
  state.view=view();
  const rendered=wrap('en',await section());
  const chart=within(rendered.container.querySelector('[data-quality-chart]') as HTMLElement).getByRole('img');
  expect(chart.getAttribute('aria-label')).toBe('Share of prepared actions confirmed unchanged, by month: June no data; July no data; August no data; September 75% (6 of 8); October 75% (27 of 36); November 75% (3 of 4).');
  // Drawn to scale against 100: the top gridline is 100, and a 75% bar is three quarters of the plot's height.
  const ticks=[...chart.querySelectorAll('text')].map(node=>node.textContent);
  expect(ticks.slice(0,5)).toEqual(['0','25','50','75','100']);
  const bars=[...chart.querySelectorAll('rect')];
  expect(bars).toHaveLength(6);
  const plot=220-12-48;
  expect(Number(bars[4].getAttribute('height'))).toBeCloseTo(plot*0.75,5);
  expect(Number(bars[0].getAttribute('height'))).toBe(0);
 });

 it('lists the biggest gaps with their redacted examples, status and duplicate choice',async()=>{
  state.view=view();
  const rendered=wrap('en',await section());
  const rows=[...rendered.container.querySelectorAll('[data-gap-row]')];
  expect(rows.map(cells)).toEqual([
   ['Asked if it can do something in payroll: not yetAsked by: Employee, Manager','7','“Can you show me the payslip of {{NAME_A}} {{NAME_B}}?”“Boleh anda jalankan gaji bulan ini?”',
    expect.stringContaining('Open')],
   ['Could not answer about leaveAsked by: Employee','3','No example kept',expect.stringContaining('Differs by company')],
  ]);
  // The status form posts each company where the intent was asked.
  const forms=rows.map(row=>row.querySelector('[data-gap-status-form]') as HTMLFormElement);
  expect([...forms[1].querySelectorAll<HTMLInputElement>('input[name="companyId"]')].map(input=>input.value)).toEqual([C1,C2]);
  expect((forms[0].querySelector('select[name="status"]') as HTMLSelectElement).value).toBe('open');
  expect([...(forms[0].querySelector('select[name="duplicateOf"]') as HTMLSelectElement).options].map(option=>option.textContent)).toEqual(['Not a duplicate','Could not answer about leave']);
 });

 it('lists corrections to review by signal, role and date, with "Make an eval candidate" and "Dismiss"; never a name',async()=>{
  state.view=view({period:'quarter',companyId:C1});
  const rendered=wrap('en',await section({qperiod:'quarter',qcompany:C1}));
  expect(state.reads).toEqual([['quality',{period:'quarter',companyId:C1}]]);
  expect(text(rendered.container)).toContain('How people used AI Centre’s answers and prepared actions in Fictional Alpha Sdn Bhd,');
  const rows=[...rendered.container.querySelectorAll('[data-correction]')];
  expect(rows.map(row=>cells(row).slice(0,3))).toEqual([
   ['A prepared action was opened to editAbout leave · Malay','Employee','Nov 1, 2026'],
   ['An answer was marked not helpfulAbout payroll · EnglishReason: Not what I asked“How much is {{NAME_A}} paid?”','Manager','Oct 30, 2026']]);
  const promote=within(rows[0] as HTMLElement).getByRole('link',{name:/Make an eval candidate/});
  expect(promote.getAttribute('href')).toBe(`/assistant?view=insights&qperiod=quarter&qcompany=${C1}&qpromote=${S1}#ai-quality-promote`);
  expect(within(rows[0] as HTMLElement).getByRole('button',{name:/Dismiss/})).toBeTruthy();
  expect(text(rendered.container)).not.toMatch(/Fictional Employee|Fictional Manager/);
 });

 it('opens the eval candidate form with the redacted example, and shows each candidate\'s actions by state',async()=>{
  state.view=view();
  const rendered=wrap('en',await section({qpromote:S2}));
  const form=rendered.container.querySelector(`[data-promote-form="${S2}"]`) as HTMLElement;
  expect(within(form).getByRole('heading',{level:4,name:'New eval candidate: An answer was marked not helpful'})).toBeTruthy();
  expect(text(form)).toContain('Recorded as a Manager question in English.');
  expect((within(form).getByLabelText('Question, with fictional details') as HTMLTextAreaElement).value).toBe('How much is {{NAME_A}} paid?');
  expect((within(form).getByLabelText('Kind of reply') as HTMLSelectElement).value).toBe('answer');
  expect((within(form).getByLabelText('What it tests') as HTMLSelectElement).value).toBe('facts');
  expect(text(form)).toContain('When you save, names, ids, figures, dates, e-mail addresses and phone numbers are replaced by placeholders such as NAME_A.');
  const candidates=[...rendered.container.querySelectorAll('[data-candidate]')];
  expect(candidates.map(row=>[row.getAttribute('data-candidate'),[...row.querySelectorAll('a,button')].map(el=>text(el))])).toEqual([
   ['draft',['Edit','Approve redacted text','Withdraw']],['approved',['Export for a developer','Back to draft','Withdraw']]]);
  // An exported candidate is downloaded again from the read-only route; nothing else is offered.
  cleanup();
  state.view=view({candidates:[{...(view().candidates as any[])[1],state:'exported',version:4,exportedAt:new Date('2026-11-03T01:00:00Z')}]});
  const again=wrap('en',await section());
  const row=again.container.querySelector('[data-candidate="exported"]')!;
  expect([...row.querySelectorAll('a,button')].map(el=>[text(el),el.getAttribute('href')])).toEqual([['Download again',`/assistant/learning/export?candidate=${K2}`]]);
 });

 it('lists the loops\' proposals with approve, reject or revert, and each loop\'s corrections by month; promotes nothing',async()=>{
  state.view=view();
  const rendered=wrap('en',await section());
  const proposals=[...rendered.container.querySelectorAll('[data-proposal]')];
  expect(proposals.map(row=>[row.getAttribute('data-proposal'),cells(row).slice(0,3),[...row.querySelectorAll('button')].map(el=>text(el))])).toEqual([
   ['open',['Raise the threshold from ±15% to ±23%Salary payroll loop · Fictional Alpha Sdn Bhd','5 of 5 flags cleared as expected (100%), real problems: 0, last 30 days','Waiting for a decision'],['Approve','Reject']],
   ['applied',['Stop flagging changes explained by Salary changeSalary payroll loop · Fictional Beta Sdn Bhd','6 of 6 flags cleared as expected (100%), real problems: 0, last 30 days','Applied Oct 28, 2026'],['Revert']]]);
  const loops=[...rendered.container.querySelectorAll('[data-loop-correction]')];
  expect(loops.map(cells)).toEqual([['Missed clock-outs','No data yet','0.8%2 of 250','0%0 of 40']]);
  expect(text(rendered.container)).not.toMatch(/Promote|promote a loop/);
 });

 it('explains every figure in the method note, and says "no data yet" rather than zero',async()=>{
  state.view=view({figures:{helpful:share(0,0),prepared:{decided:0,chatCards:0,loopCards:0,unchanged:share(0,0),edited:share(0,0),discarded:share(0,0)},
   gaps:{openIntents:0,questions:0,openQuestions:share(0,0)},trend:[{month:'2026-11',unchanged:0,decided:0,share:null}]},gaps:[],corrections:[],candidates:[],proposals:[],loopCorrections:[]});
  const rendered=wrap('en',await section());
  expect([...rendered.container.querySelectorAll('[data-stat-cells] > div')].map(cell=>text(cell.querySelector('dd')))).toEqual([
   'No data yetNo answer was marked in this period','No data yetNo prepared action was decided in this period','No data yetNo prepared action was decided in this period',
   '0No question it could not answer in this period']);
  for(const empty of ['Nothing AI Centre could not answer or do in this period.','Nothing to review in this period.','No eval candidates yet.','No proposal from the loops.',
   'No loop card or action was decided yet.'])expect(text(rendered.container)).toContain(empty);
  const method=rendered.container.querySelector('[data-quality-method]') as HTMLElement;
  expect(method.querySelectorAll('p')).toHaveLength(10);
  expect(text(method)).toContain('A conversation about a sensitive topic stores no words and is never counted here.');
 });

 it('says what was saved, with Undo after a dismiss, and shows a refusal in plain words',async()=>{
  state.view=view();
  let rendered=wrap('en',await section({qsaved:'dismissed',qsignal:S1}));
  const status=within(rendered.container).getByRole('status');
  expect(text(status)).toBe('Dismissed. It no longer waits for review.Undo');
  expect((status.querySelector('input[name="signalId"]') as HTMLInputElement).value).toBe(S1);
  cleanup();
  rendered=wrap('en',await section({qerror:'not_redacted'}));
  expect(text(rendered.container)).toContain('The text still holds a name, number, id or address after redaction. Rewrite it with fictional details.');
  // An unknown code shows nothing.
  cleanup();
  rendered=wrap('en',await section({qerror:'<script>',qsaved:'pwned'}));
  expect(rendered.container.querySelector('[role="status"]')).toBeNull();
 });

 it.each(LOCALES)('%s: renders every message, never says Noveri, shows no HR-staff ratio and keeps 44px targets',async locale=>{
  state.locale=locale;state.view=view();
  const rendered=wrap(locale,await section({qpromote:S2,qcandidate:K1,qsaved:'candidate'}));
  const all=rendered.container.textContent??'';
  expect(all.length).toBeGreaterThan(1500);
  expect(all).not.toMatch(/Noveri/);
  for(const pattern of RATIO)expect(all,`${locale} ${pattern}`).not.toMatch(pattern);
  expect(rendered.container.querySelector('[data-candidate-edit]')).toBeTruthy();
  for(const el of rendered.container.querySelectorAll('[data-ai-quality] a,[data-ai-quality] button,[data-ai-quality] select,[data-ai-quality] summary,[data-ai-quality] textarea'))
   expect((el as HTMLElement).className,`${locale} ${el.outerHTML.slice(0,80)}`).toContain('pointer-coarse:min-h-11');
 });
});
