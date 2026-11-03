/** AI v2 Phase 2, P2-6 — the learning loops' pure rules, on fictional fixtures with real-looking values. No database.
 *
 *  1. Redaction removes names, ids and figures (Latin and other scripts), keeps product and calendar words, and leaves no
 *     digit or "@"; fictionalisation replaces every placeholder.
 *  2. Which turns are gaps, and their intent: a gated turn never is.
 *  3. The quality figures and the gap backlog against hand-worked values; the loop correction trend.
 *  4. The export holds no tenant id and no placeholder, and says what a developer must still do.
 *  5. The closed vocabularies match migration 0972's CHECK lists; nothing in core/learning writes the eval set, the prompt,
 *     a guard, a permission or a disclosure rule; no HR-staff ratio in any locale's copy.
 * Expected values are written out by hand. */
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {describe,expect,it} from 'vitest';
import {REDACTION_VERSION,fictionalise,looksRedacted,placeholderLetters,redact} from '../core/learning/redact';
import {areaOfWords,gapKindOf,gapTurnOf,intentOf,type GapTurn} from '../core/learning/gaps';
import {computeQuality,gapBacklog,loopCorrectionTrend} from '../core/learning/quality-math';
import {candidateFileName,exportCandidate} from '../core/learning/export';
import {CANDIDATE_STATES,EVAL_FACTORS,EVAL_KINDS,GAP_KINDS,GAP_STATUSES,LEARNING_LOCALES,LEARNING_ROLES,REVIEW_DECISIONS,SIGNAL_KINDS} from '../core/learning/types';
import {SMART_EVAL_FACTORS} from '../core/improvement/smart-eval-score';
import {CAPABILITY_AREAS} from '../core/semantic-model/entities-catalogue';

const root=join(__dirname,'..');
const SQL=readFileSync(join(root,'db/migrations/0972_teras_learning_loops.sql'),'utf8');

describe('redaction',()=>{
 it('replaces names, identity card numbers, staff ids, e-mails, phones, money, dates, times and figures',()=>{
  const out=redact('Can Siti Rahman take annual leave on 2026-11-14? Her IC is 900101-14-5678, staff no EMP00123, email siti.rahman@acme-fictional.com.my, call +60 12-345 6789. Claim RM1,250.50 at 6:10pm for 3 nights.');
  expect(out.text).toBe('Can {{NAME_A}} {{NAME_B}} take annual leave on {{DATE_A}}? Her IC is {{ID_A}}, staff no {{ID_B}}, email {{EMAIL_A}}, call {{PHONE_A}}. Claim {{AMOUNT_A}} at {{TIME_A}} for {{NUMBER_A}} nights.');
  expect(out.replaced).toEqual({EMAIL:1,LINK:0,AMOUNT:1,ID:2,DATE:1,TIME:1,PHONE:1,NUMBER:1,NAME:2});
  expect(looksRedacted(out.text)).toBe(true);
 });
 it('keeps product, calendar and language words, acronyms and the first word of a sentence',()=>{
  expect(redact('Is my Annual Leave approved for Friday in December? What about EPF and SOCSO?').text)
   .toBe('Is my Annual Leave approved for Friday in December? What about EPF and SOCSO?');
  expect(redact('Boleh saya mohon cuti pada hari Jumaat untuk Encik Ahmad? Gaji saya 3500').text)
   .toBe('Boleh saya mohon cuti pada hari Jumaat untuk Encik {{NAME_A}}? Gaji saya {{NUMBER_A}}');
 });
 it('replaces known names in any script, and the same original keeps its placeholder',()=>{
  expect(redact('帮我查一下王小明的工资12345吗',{knownNames:['王小明']}).text).toBe('帮我查一下{{NAME_A}}的工资{{NUMBER_A}}吗');
  expect(redact('Is Aina Fictional away? Aina said 2 days, Wei said 2 days',{knownNames:['Aina Fictional']}).text)
   .toBe('Is {{NAME_A}} away? {{NAME_B}} said {{NUMBER_A}} days, {{NAME_C}} said {{NUMBER_A}} days');
  // A family name that is also an honorific elsewhere is still a name: "Tan" is not kept.
  expect(redact('Please ask Tan about it').text).toBe('Please ask {{NAME_A}} about it');
 });
 it('leaves no digit in any script and no "@", and cuts long text outside a placeholder',()=>{
  for(const text of ['ลา ๓ วัน','விடுப்பு ௩ நாள்','２０２６年','mail me at someone @ host'])expect(looksRedacted(redact(text).text),text).toBe(true);
  // Forty characters end inside "{{NAME_A}}", so the cut falls before it.
  expect(redact('x'.repeat(30)+' Ali '+'y'.repeat(400),{maxLength:40}).text).toBe('x'.repeat(30)+'…');
  expect(redact('x'.repeat(30)+' Ali '+'y'.repeat(400),{maxLength:45}).text).toBe('x'.repeat(30)+' {{NAME_A}} yyy…');
 });
 it('letters, not digits, number the placeholders; fictionalising replaces every one',()=>{
  expect([1,2,26,27,52,53].map(placeholderLetters)).toEqual(['A','B','Z','AA','AZ','BA']);
  expect(fictionalise('Can {{NAME_A}} claim {{AMOUNT_A}} on {{DATE_A}} for {{NAME_B}}?')).toBe('Can Siti Fictional claim RM100.00 on next Friday for Wei Fictional?');
  expect(fictionalise(redact('Email ali@acme-fictional.com or call 012-3456789 about EMP00123').text)).toBe('Email someone@fictional.test or call 012-000 0000 about EMP-FICTIONAL-1');
  expect(REDACTION_VERSION).toBe(1);
 });
});

const turn=(over:Partial<GapTurn>={}):GapTurn=>({mode:'answer',sensitive:false,refused:false,crisis:false,fallback:false,offered:['product_guidance'],calls:[],suggested:false,...over});
describe('gaps',()=>{
 it('classifies honest gaps, capability questions and requests with no route',()=>{
  expect(gapKindOf(turn({mode:'honest_gap'}))).toBe('cannot_answer');
  expect(gapKindOf(turn({mode:'honest_gap',offered:['product_guidance','product_capabilities']}))).toBe('not_supported');
  const noMatch=[{tool:'suggest_action',status:'refused',refusal:'no_match'}];
  expect(gapKindOf(turn({mode:'honest_gap',calls:noMatch}))).toBe('no_route');
  expect(gapKindOf(turn({mode:'refuse',calls:[{tool:'suggest_action',status:'refused',refusal:'not_available'}]}))).toBe('no_route');
  // Answered ("nothing pending matches") or asked back: not a gap. A card or suggestion: not a gap.
  expect(gapKindOf(turn({mode:'answer',calls:noMatch}))).toBeNull();
  expect(gapKindOf(turn({mode:'clarify',calls:noMatch}))).toBeNull();
  expect(gapKindOf(turn({mode:'guide',calls:noMatch,suggested:true}))).toBeNull();
  expect(gapKindOf(turn({mode:'guide',calls:[{tool:'suggest_action',status:'refused',refusal:'unavailable'}]}))).toBeNull();
  expect(gapKindOf(turn({mode:'answer'}))).toBeNull();
 });
 it('reads a wiring turn as a gap only when every field says so; a turn it cannot read is not one',()=>{
  expect(gapTurnOf({mode:'honest_gap',sensitive:false,refused:false,crisis:false,fallback:false,suggestion:null,proposals:[],
   trace:{offered:['product_capabilities'],calls:[{tool:'suggest_action',status:'refused',refusal:'no_match'}]}}))
   .toEqual({mode:'honest_gap',sensitive:false,refused:false,crisis:false,fallback:false,offered:['product_capabilities'],
    calls:[{tool:'suggest_action',status:'refused',refusal:'no_match'}],suggested:false});
  // Missing fields: treated as gated, so never a gap.
  expect(gapKindOf(gapTurnOf({mode:'honest_gap'}))).toBeNull();
  expect(gapKindOf(gapTurnOf({mode:'honest_gap',sensitive:false,trace:null}))).toBe('cannot_answer');
  expect(gapTurnOf({mode:'honest_gap',sensitive:false,proposals:[{}]}).suggested).toBe(true);
 });
 it('never treats a gated turn or the fixed fallback as a gap',()=>{
  for(const gated of [{sensitive:true},{refused:true},{crisis:true},{fallback:true}])
   expect(gapKindOf(turn({mode:'honest_gap',offered:['product_capabilities'],...gated}))).toBeNull();
 });
 it('groups by the area the words name, in each language, else the reads, else general',()=>{
  expect([
   'Can you file my overtime claim?','boleh saya tuntut resit parking','我想报销出租车','tôi muốn xem bảng lương','ขอดูสลิปเงินเดือน','என் விடுப்பு எத்தனை',
   'what is the training budget','How do I reset my password','Show me the org chart',
  ].map(areaOfWords)).toEqual(['claims','claims','claims','payroll','payroll','leave',null,'security','organisation']);
  expect(intentOf('not_supported','Can you run a recruitment campaign?',['leave'])).toEqual({area:'leave',intentKey:'not_supported:leave'});
  expect(intentOf('cannot_answer','Who won the match?',[])).toEqual({area:'general',intentKey:'cannot_answer:general'});
  // Every area the lexicon names is a product area.
  for(const area of ['claims','leave','attendance','payroll','lifecycle','performance','rewards','approvals','reports','knowledge','security','notifications','organisation','people'])
   expect(CAPABILITY_AREAS).toContain(area);
 });
});

describe('the quality figures',()=>{
 const A='company-a',B='company-b';
 const signals=[
  // In the period (last 30 days to 2026-11-03: from 2026-10-05).
  {companyId:A,kind:'card_confirmed' as const,date:'2026-10-20',count:6},{companyId:A,kind:'card_edited' as const,date:'2026-10-21',count:2},
  {companyId:B,kind:'card_discarded' as const,date:'2026-11-02',count:2},{companyId:A,kind:'answer_helpful' as const,date:'2026-10-10',count:3},
  {companyId:B,kind:'answer_unhelpful' as const,date:'2026-11-01',count:1},{companyId:A,kind:'recommendation_rejected' as const,date:'2026-10-11',count:5},
  // Before the period: the trend only.
  {companyId:A,kind:'card_confirmed' as const,date:'2026-09-15',count:1},{companyId:A,kind:'card_edited' as const,date:'2026-09-16',count:1},
 ];
 const loopCards=[{companyId:A,resolution:'as_prepared' as const,date:'2026-10-25',count:8},{companyId:B,resolution:'changed' as const,date:'2026-10-26',count:2},
  {companyId:A,resolution:'as_prepared' as const,date:'2026-08-03',count:4}];
 const gaps=[{companyId:A,intentKey:'not_supported:payroll',role:'employee' as const,date:'2026-10-12',count:4},
  {companyId:B,intentKey:'not_supported:payroll',role:'manager' as const,date:'2026-10-13',count:1},
  {companyId:A,intentKey:'cannot_answer:leave',role:'employee' as const,date:'2026-10-14',count:3},
  {companyId:A,intentKey:'no_route:claims',role:'hr_admin' as const,date:'2026-11-01',count:2},
  {companyId:A,intentKey:'no_route:claims',role:'employee' as const,date:'2026-09-01',count:9}];
 const statuses=[{companyId:A,intentKey:'cannot_answer:leave',status:'planned' as const,duplicateOf:null},
  {companyId:B,intentKey:'not_supported:payroll',status:'wont_do' as const,duplicateOf:null}];

 it('counts the period and works out each share by hand',()=>{
  const figures=computeQuality({period:'last30',today:'2026-11-03',signals,loopCards,gaps,statuses});
  // Helpful 3 of 3+1 marked.
  expect(figures.helpful).toEqual({part:3,whole:4,share:0.75});
  // Decided: chat 6+2+2=10, loop 8+2=10 -> 20. Unchanged 6+8=14; edited 2+2=4; discarded 2.
  expect(figures.prepared).toEqual({decided:20,chatCards:10,loopCards:10,unchanged:{part:14,whole:20,share:0.7},edited:{part:4,whole:20,share:0.2},
   discarded:{part:2,whole:20,share:0.1}});
  // Open intents in the period: A not_supported:payroll (open), A no_route:claims (open); A leave is planned, B payroll won't do.
  // Gap questions in the period 4+1+3+2=10; on open intents 4+2=6.
  expect(figures.gaps).toEqual({openIntents:2,questions:10,openQuestions:{part:6,whole:10,share:0.6}});
 });
 it('draws the trend from every month shown, with no share for an empty month',()=>{
  const figures=computeQuality({period:'last30',today:'2026-11-03',signals,loopCards,gaps,statuses});
  expect(figures.trend).toEqual([
   {month:'2026-06',unchanged:0,decided:0,share:null},{month:'2026-07',unchanged:0,decided:0,share:null},
   {month:'2026-08',unchanged:4,decided:4,share:1},{month:'2026-09',unchanged:1,decided:2,share:0.5},
   {month:'2026-10',unchanged:14,decided:18,share:14/18},{month:'2026-11',unchanged:0,decided:2,share:0}]);
 });
 it('says nothing is known when nothing was decided or marked',()=>{
  const figures=computeQuality({period:'quarter',today:'2026-11-03',signals:[],loopCards:[],gaps:[],statuses:[]});
  expect(figures.helpful.share).toBeNull();expect(figures.prepared.unchanged.share).toBeNull();expect(figures.gaps.openQuestions.share).toBeNull();
  expect(figures.gaps.openIntents).toBe(0);
 });
 it('groups the backlog by intent, ranks it, and keeps each company\'s status',()=>{
  expect(gapBacklog({period:'last30',today:'2026-11-03',gaps,statuses})).toEqual([
   {intentKey:'not_supported:payroll',kind:'not_supported',area:'payroll',count:5,roles:['employee','manager'],
    statuses:[{companyId:A,status:'open',duplicateOf:null},{companyId:B,status:'wont_do',duplicateOf:null}],status:null,rank:1},
   {intentKey:'cannot_answer:leave',kind:'cannot_answer',area:'leave',count:3,roles:['employee'],statuses:[{companyId:A,status:'planned',duplicateOf:null}],status:'planned',rank:2},
   {intentKey:'no_route:claims',kind:'no_route',area:'claims',count:2,roles:['hr_admin'],statuses:[{companyId:A,status:'open',duplicateOf:null}],status:'open',rank:3},
  ]);
 });
 it('trends each loop\'s corrections by month',()=>{
  expect(loopCorrectionTrend([{loop:'loop_missed_clock_outs',companyId:A,month:'2026-10',decided:200,corrected:1},
   {loop:'loop_missed_clock_outs',companyId:B,month:'2026-10',decided:50,corrected:4},{loop:'loop_payroll_inputs',companyId:A,month:'2026-11',decided:3,corrected:0}],['2026-10','2026-11']))
   .toEqual([{loop:'loop_missed_clock_outs',months:[{month:'2026-10',decided:250,corrected:5,share:0.02},{month:'2026-11',decided:0,corrected:0,share:null}]},
    {loop:'loop_payroll_inputs',months:[{month:'2026-10',decided:0,corrected:0,share:null},{month:'2026-11',decided:3,corrected:0,share:0}]}]);
 });
});

describe('the export',()=>{
 const candidate={id:'0f1e2d3c-4b5a-4968-8776-655443322110',role:'hr_admin' as const,locale:'ms' as const,kind:'honest_gap' as const,factor:'capability' as const,
  question:'Boleh anda proses gaji {{NAME_A}} untuk {{DATE_A}}?',expectation:'Says it cannot run payroll for {{NAME_A}} in chat and links the payroll page.',approvedOn:'2026-11-03',
  origin:'gap' as const,intentKey:'not_supported:payroll'};
 it('is one eval set entry with fictional values, no placeholder and no tenant id',()=>{
  const file=exportCandidate(candidate);
  expect(file).toContain("{id:'cand-hr-admin-0f1e2d3c',role:'hr_admin',turns:[{id:'cand-hr-admin-0f1e2d3c-1',question:'Boleh anda proses gaji Siti Fictional untuk next Friday?',locale:'ms',");
  expect(file).toContain("ideal:'Says it cannot run payroll for Siti Fictional in chat and links the payroll page.'}]},");
  expect(file).toContain("source:{kind:'reconstructed',issues:[],from:'Tenant eval candidate, approved 2026-11-03 (gap not_supported:payroll).'}");
  expect(file).toContain("// Fictional values replaced the tenant's date, name: set the fixture facts to match, or edit them.");
  expect(file).not.toMatch(/\{\{/);expect(file).not.toContain(candidate.id);
  expect(candidateFileName(candidate)).toBe('eval-candidate-0f1e2d3c4b5a.ts');
 });
 it('says when the eval set does not take the locale yet, and escapes quotes',()=>{
  const file=exportCandidate({...candidate,locale:'th',question:"It's {{NAME_A}}'s leave",origin:'signal',signalKind:'answer_unhelpful',intentKey:null});
  expect(file).toContain("// The eval set does not take 'th' yet: extend SmartEvalLocale");
  expect(file).toContain("question:'It\\'s Siti Fictional\\'s leave'");
  expect(file).toContain('(signal answer_unhelpful)');
 });
});

describe('the boundaries the owner set',()=>{
 const listIn=(name:string)=>{const m=new RegExp(`${name} text NOT NULL CHECK \\(${name} IN \\(([^)]*)\\)\\)`).exec(SQL);return m?m[1].split(',').map(v=>v.trim().replace(/'/g,'')):null;};
 it('the closed vocabularies are the migration\'s CHECK lists and the eval set\'s own',()=>{
  expect(listIn('kind')).toEqual([...SIGNAL_KINDS]);
  expect(listIn('role')).toEqual([...LEARNING_ROLES]);expect(listIn('locale')).toEqual([...LEARNING_LOCALES]);
  expect(listIn('decision')).toEqual([...REVIEW_DECISIONS]);
  expect([...GAP_KINDS].sort()).toEqual(['cannot_answer','no_route','not_supported']);
  expect(SQL).toContain("kind text NOT NULL CHECK (kind IN ('cannot_answer','no_route','not_supported')),");
  expect(SQL).toContain(`status IN (${GAP_STATUSES.map(v=>`'${v}'`).join(',')})`);
  expect(SQL).toContain(`kind IN (${EVAL_KINDS.map(v=>`'${v}'`).join(',')})`);
  expect(SQL).toContain(`factor IN (${EVAL_FACTORS.map(v=>`'${v}'`).join(',')})`);
  expect(SQL).toContain(`state IN (${CANDIDATE_STATES.map(v=>`'${v}'`).join(',')})`);
  expect([...EVAL_FACTORS]).toEqual([...SMART_EVAL_FACTORS]);
 });
 it('every table is FORCE row-level security with grants, and only an expired example is ever deleted',()=>{
  const tables=[...SQL.matchAll(/CREATE TABLE public\.(\w+)/g)].map(m=>m[1]);
  expect(tables).toEqual(['teras_learning_signal','teras_learning_signal_review','teras_gap_occurrence','teras_gap_example','teras_gap_status','teras_eval_candidate']);
  for(const table of tables){
   expect(SQL).toContain(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY;`);
   expect(SQL).toContain(`REVOKE ALL ON public.${table} FROM PUBLIC,ai_hr_app;`);
   expect(SQL).toMatch(new RegExp(`GRANT SELECT,INSERT(,DELETE|,UPDATE)? ON public\\.${table} TO ai_hr_app;`));
  }
  expect(SQL).toContain('GRANT SELECT,INSERT,DELETE ON public.teras_gap_example TO ai_hr_app;');
  expect(SQL).toContain('USING (tenant_id=app.current_tenant_id() AND app.teras_learning_admin(company_id) AND (expires_at<=now() OR NOT app.teras_gap_example_kept(tenant_id,at)));');
  // The read policy cannot repeat the expiry (a DELETE naming its rows must pass it too), so the one reader deletes the
  // expired examples first and filters on both conditions in every read.
  expect(SQL).toContain('CREATE POLICY teras_gap_example_read ON public.teras_gap_example FOR SELECT TO ai_hr_app\n USING (tenant_id=app.current_tenant_id() AND app.teras_learning_admin(company_id));');
  const quality=readFileSync(join(root,'core/learning/quality.ts'),'utf8');
  expect(quality).toContain('const exampleKept=(e:typeof terasGapExample)=>sql`(${e.expiresAt}>now() and app.teras_gap_example_kept(${e.tenantId},${e.at}))`;');
  expect(quality.match(/exampleKept\(e\)/g)).toHaveLength(3);
  expect(quality.match(/\.from\(e\)/g)).toHaveLength(2);
  // Every insert of a signal or a gap, and a mark's reason, names its own, open (not private to the asker) turn.
  expect(SQL.match(/app\.teras_learning_own_record\(record_id,company_id\)/g)).toHaveLength(4);
  // A gap example follows the asker's chat: written only for their own chat, removed with it.
  expect(SQL).toContain('chat_id uuid NOT NULL REFERENCES public.teras_chat(id) ON DELETE CASCADE,');
  expect(SQL).toContain('AND EXISTS(SELECT 1 FROM public.teras_chat c WHERE c.id=teras_gap_example.chat_id AND c.tenant_id=teras_gap_example.tenant_id\n   AND c.app_user_id=app.current_user_id()));');
  // An answer's mark: only its reason may be updated, by a column grant.
  expect(SQL).toContain('GRANT UPDATE (reason) ON public.teras_learning_signal TO ai_hr_app;');
  expect(SQL).toContain('AND r.asked_by_user_id=app.current_user_id() AND r.private_to_asker IS FALSE AND r.company_id=p_company)');
  // The journal places it by number.
  const journal=JSON.parse(readFileSync(join(root,'db/migrations/meta/_journal.json'),'utf8')) as {entries:{idx:number;when:number;tag:string}[]};
  expect(journal.entries.find(entry=>entry.tag==='0972_teras_learning_loops')).toMatchObject({idx:776,when:1793330000372});
 });
 it('learning reads and records only: it never writes the eval set, the harness, a guard, a permission or a disclosure rule',()=>{
  const files=readdirSync(join(root,'core/learning')).filter(name=>name.endsWith('.ts'));
  expect(files.sort()).toEqual(['access.ts','ask.ts','capture.ts','export.ts','gaps.ts','proposals.ts','quality-math.ts','quality.ts','recommendation-signal.ts','redact.ts','review.ts','signals.ts','types.ts']);
  for(const name of files){
   const text=readFileSync(join(root,'core/learning',name),'utf8').replace(/\/\*[\s\S]*?\*\//g,'').replace(/^\s*\/\/.*$/gm,'');
   expect(text,name).not.toMatch(/from ['"](?:node:)?(?:fs|child_process|net|http|https)['"]/);
   expect(text,name).not.toMatch(/core\/harness\/(?:spec|tools|runner)|request-gate|semantic-model\/(?:types|disclosure)|lib\/permissions|access-configuration|mandates\/job-types/);
   // It names the eval set's file in the export's own instructions, and never imports or writes it.
   expect(text,name).not.toMatch(/from ['"][^'"]*assistant-smart-eval-set|writeFile|appendFile/);
   // Its only database writes are the learning tables and, through their owners, the payroll loop settings.
   for(const m of text.matchAll(/tx\.(?:insert|update|delete)\((\w+)\)/g))expect(['terasLearningSignal','terasGapOccurrence','terasGapExample','terasLearningSignalReview',
    'terasEvalCandidate','g','c','e','s','terasGapStatus'],`${name}: ${m[0]}`).toContain(m[1]);
  }
 });
 it('no HR-staff ratio in any locale\'s AI quality copy',()=>{
  const RATIO=[/per\s*100\b/i,/per\s+hundred/i,/staff\s+per\b/i,/staff[-\s]+to[-\s]+employee/i,/\bratio\b/i,/\bFTE\b/,/full[-\s]time\s+equivalent/i,
   /setiap\s+100/i,/nisbah/i,/每\s*(百|100)/,/比率/,/tỷ\s*lệ/i,/trên\s+100/i,/விகிதம்/,/อัตราส่วน/,/ต่อ\s*100/];
  for(const locale of ['en','ms','zh','vi','ta','th']){
   const quality=JSON.stringify((JSON.parse(readFileSync(join(root,`messages/ai-centre/${locale}.json`),'utf8')) as {aiCentre:{quality:unknown}}).aiCentre.quality);
   expect(quality.length).toBeGreaterThan(2000);
   for(const pattern of RATIO)expect(quality,`${locale} ${pattern}`).not.toMatch(pattern);
   expect(quality).not.toMatch(/Noveri/);
  }
 });
});
