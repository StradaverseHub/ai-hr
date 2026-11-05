/** Payroll history learning, P1 and P2 — the pure parts, with no database.
 *
 * Every expected value is written out by hand from the fixtures, never re-derived from the code under test:
 *  1. the maths in integer sen: nearest-rank median, P10 and P90; the non-zero count, month mask and fixed flag; RM text to
 *     sen exactly;
 *  2. provisional vs stable (owner decision, 4 November 2026: evidence from 3, stable from 6), rebasing after a salary change
 *     and contradicted when the two latest months move outside the earlier range;
 *  3. the judgement (within, above, below) and which statuses give an evidence line;
 *  4. the excluded months (problem swing, fixed at the source, correction, manual figure, before a salary change) and the
 *     salary change's first month (from the 1st, or the next month when mid-month);
 *  5. a person's baselines per basis (regular, month total, bonus) from their months, with pay items keyed on the pay
 *     component's id;
 *  6. the small-group rule of the AI read (minimum 5, then complementary suppression);
 *  7. migration 2012's guarantees in its source (FORCE row-level security and exact grants on every table, no agent read of
 *     a baseline, append-only, the cascade and the two deleting functions) and the AI read's declaration (no amount field).
 * The database behaviour is test/payroll-learning.test.ts; the rendered pages test/payroll-learning-pages.dom.test.tsx. */
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {BASELINE_METHOD,CONTRADICTION_MIN_RUNS,EVIDENCE_MIN_RUNS,STABLE_MIN_RUNS,WINDOW_MONTHS,baselineStatus,componentStats,contradicted,givesEvidence,judge,
 nearestRank,suppressSmallCounts,toSen} from '../core/payroll-learning/baseline-math';
import {hasManualFigure,isPartMonth,personMonths,salaryChangeFrom,windowStart} from '../core/payroll-learning/history';
import {CONFIG_EVENT_PREFIXES} from '../core/payroll-audit/capture';
import {LEARNING_MODE_EVENT} from '../core/payroll-learning/mode';
import {LEARNED_LINES,MONTH_EXCLUSIONS,learnBaselines,rowValues,type LearningRow} from '../core/payroll-learning/learn';
import {LEARNING_MODES,SETTABLE_LEARNING_MODES} from '../core/payroll-learning/mode';
import {PAYROLL_LEARNING_ENTITIES,PAYROLL_LEARNING_MODES,PAYROLL_LEARNING_READS} from '../core/semantic-model/entities-payroll-learning';
import {LEARNING_STATUSES} from '../core/payroll-learning/status';
import type {SemanticField} from '../core/semantic-model/types';

const MEAL='0000aaaa-0000-4000-8000-00000000a040',SHIFT='0000aaaa-0000-4000-8000-00000000a041';
const componentIds=new Map([['A0040',MEAL],['A0041',SHIFT]]);
type RowOver=Partial<Pick<LearningRow,'employmentId'|'batchId'|'runType'|'imported'>>&{gross?:string;basic?:string;bonus?:string;statutory?:Record<string,unknown>};
const row=(period:string,net:string,over:RowOver={}):LearningRow=>{
 const {gross,basic,bonus,statutory,...identity}=over;
 return {employmentId:'e1',batchId:`b-${period}-${over.runType??'regular'}`,payPeriod:period,runType:'regular',imported:false,...identity,
  figures:{basic:basic??'5000.00',allowance:'0.00',overtime:'0.00',bonus:bonus??'0.00',gross:gross??'5000.00',statutory:statutory??{},otherDeductions:'0.00',totalDeductions:'0.00',net}};
};

describe('the maths, in integer sen',()=>{
 it('takes nearest-rank order statistics: the median is the lower middle value, P10 and P90 observed values',()=>{
  // Sorted: 400000 400000 405000 410000 410000 415000 420000 (n = 7). Rank ceil(50·7/100) = 4, ceil(10·7/100) = 1,
  // ceil(90·7/100) = 7.
  const sorted=[400000,400000,405000,410000,410000,415000,420000];
  expect([nearestRank(sorted,50),nearestRank(sorted,10),nearestRank(sorted,90)]).toEqual([410000,400000,420000]);
  // n = 6: the median is rank 3 (the lower of the two middle values), never their average.
  expect(nearestRank([100,200,300,400,500,600],50)).toBe(300);
  // n = 20: P10 is rank 2, P90 rank 18.
  const twenty=Array.from({length:20},(_,i)=>(i+1)*1000);
  expect([nearestRank(twenty,10),nearestRank(twenty,90)]).toEqual([2000,18000]);
  expect(()=>nearestRank([],50)).toThrow();expect(()=>nearestRank([1],0)).toThrow();expect(()=>nearestRank([1],50.5)).toThrow();
 });
 it('counts the paid months, marks the calendar months paid and calls a component fixed only when the same in 3 or more months',()=>{
  // January, March and December paid 15000 sen; February nothing.
  expect(componentStats([{month:1,sen:15000},{month:2,sen:0},{month:3,sen:15000},{month:12,sen:15000}]))
   .toEqual({n:4,median:15000,p10:0,p90:15000,nonZero:3,monthMask:0b100000000101,fixed:false});
  expect(componentStats([{month:4,sen:20000},{month:5,sen:20000},{month:6,sen:20000}])).toMatchObject({fixed:true,monthMask:0b111000});
  expect(componentStats([{month:4,sen:20000},{month:5,sen:20000}])).toMatchObject({fixed:false});
  expect(componentStats([])).toEqual({n:0,median:0,p10:0,p90:0,nonZero:0,monthMask:0,fixed:false});
  expect(()=>componentStats([{month:1,sen:1.5}])).toThrow(/whole number of sen/);
 });
 it('turns the payroll owner\'s RM text into sen exactly, never through a float sum',()=>{
  expect([toSen('4295.35'),toSen('0.10'),toSen('7'),toSen('-12.5'),toSen(4295.35),toSen(0.1+0.2),toSen('abc'),toSen(null)]).toEqual([429535,10,700,-1250,429535,30,0,0]);
 });
});

describe('the status: provisional from 3, stable from 6 (owner decision, 4 November 2026)',()=>{
 it('is none under 3, provisional from 3 to 5 and stable from 6, and rebasing under 3 after a salary change',()=>{
  expect([EVIDENCE_MIN_RUNS,STABLE_MIN_RUNS,CONTRADICTION_MIN_RUNS,WINDOW_MONTHS]).toEqual([3,6,5,24]);
  const flat=(n:number)=>Array.from({length:n},()=>400000);
  expect([0,2,3,5,6,9].map(runs=>baselineStatus({runs,mainOrdered:flat(runs),rebased:false}))).toEqual(['none','none','provisional','provisional','stable','stable']);
  expect(baselineStatus({runs:2,mainOrdered:flat(2),rebased:true})).toBe('rebasing');
  expect(baselineStatus({runs:3,mainOrdered:flat(3),rebased:true})).toBe('provisional');
 });
 it('is contradicted when the two latest months are both above (or both below) the range of the months before them',()=>{
  // Earlier 400000 410000 405000 (range 400000 to 410000); then 450000 and 460000, both above.
  expect(contradicted([400000,410000,405000,450000,460000])).toBe(true);
  expect(baselineStatus({runs:5,mainOrdered:[400000,410000,405000,450000,460000],rebased:false})).toBe('contradicted');
  // Both below.
  expect(contradicted([400000,410000,405000,300000,310000])).toBe(true);
  // One above, one within: not contradicted. Four months: too few to say.
  expect(contradicted([400000,410000,405000,450000,405000])).toBe(false);
  expect(contradicted([400000,410000,450000,460000])).toBe(false);
 });
});

describe('the evidence judgement',()=>{
 it('is below P10, above P90 and within inclusive of both ends; only provisional and stable baselines give a line',()=>{
  const stats={p10:400000,p90:420000};
  expect([judge(399999,stats),judge(400000,stats),judge(420000,stats),judge(420001,stats)]).toEqual(['below','within','within','above']);
  expect((['none','provisional','stable','rebasing','contradicted'] as const).map(givesEvidence)).toEqual([false,true,true,false,false]);
 });
});

describe('the excluded months and the salary change',()=>{
 it('starts learning from the latest salary change effective by the as-of month: its own month from the 1st, the next month mid-month',()=>{
  const records=[{validFrom:'2024-01-01',basicSalary:'3000.00'},{validFrom:'2026-05-01',basicSalary:'3500.00'}];
  expect(salaryChangeFrom(records,'2026-08')).toBe('2026-05');
  // A change on the 15th was paid at two rates that month: learning starts the month after.
  expect(salaryChangeFrom([...records,{validFrom:'2026-07-15',basicSalary:'3800.00'}],'2026-08')).toBe('2026-08');
  // A change after the as-of month is not known to it; an unchanged basic salary is no change.
  expect(salaryChangeFrom([...records,{validFrom:'2026-09-01',basicSalary:'4000.00'}],'2026-08')).toBe('2026-05');
  expect(salaryChangeFrom([{validFrom:'2024-01-01',basicSalary:'3000.00'},{validFrom:'2025-01-01',basicSalary:'3000.00'}],'2026-08')).toBeNull();
  expect(salaryChangeFrom([],'2026-08')).toBeNull();
  expect(windowStart('2026-08')).toBe('2024-08');expect(windowStart('2026-01',1)).toBe('2025-12');
 });
 it('sets aside a problem swing, a fix at the source, a correction, a live adjustment run, a manual figure and the months before a salary change',()=>{
  expect(MONTH_EXCLUSIONS).toEqual(['problem_swing','fixed_upstream','correction','manual_figure','before_salary_change','first_month','last_month','part_month']);
  const manual={adjustment:{lines:{epfEmployee:{system:550,applied:600}},reason:'Fictional agreed EPF'}};
  expect(hasManualFigure(manual)).toBe(true);expect(hasManualFigure({})).toBe(false);
  const rows=['2026-01','2026-02','2026-03','2026-04','2026-05','2026-06','2026-07'].map(period=>row(period,'4000.00',period==='2026-06'?{statutory:manual}:{}));
  rows.push(row('2026-07','100.00',{runType:'adjustment',batchId:'b-adj'}));
  const months=personMonths(rows,{problemSwings:new Set(['e1:2026-02']),fixedUpstream:new Set(['e1:2026-03']),corrections:new Set(['e1:2026-04']),
   salaryFrom:new Map([['e1','2026-02']])}).get('e1')!;
  expect(months.map(month=>[month.period,month.excluded])).toEqual([
   ['2026-01',['before_salary_change']],['2026-02',['problem_swing']],['2026-03',['fixed_upstream']],['2026-04',['correction']],
   ['2026-05',[]],['2026-06',['manual_figure']],['2026-07',['correction']]]);
  // An imported adjustment month is history, not a correction.
  const imported=personMonths([row('2026-01','4000.00',{runType:'adjustment',imported:true})],{problemSwings:new Set(),fixedUpstream:new Set(),corrections:new Set(),salaryFrom:new Map()});
  expect(imported.get('e1')![0].excluded).toEqual([]);
 });
});

describe('part months are usual for nobody (coordinator review, 4 November 2026)',()=>{
 it('reads a part month from an unpaid-leave or absence line, or a proration factor under 1, and nothing else',()=>{
  expect(isPartMonth({unpaidLeave:{days:2,amount:300}},'300.00')).toBe(true);
  expect(isPartMonth({absent:{days:1,amount:150}},'150.00')).toBe(true);
  expect(isPartMonth({reportContext:{proration:{payMode:'monthly',factor:0.5}}},'0.00')).toBe(true);
  // A full month: factor 1, a zero unpaid-leave stamp, or no stamp at all.
  expect(isPartMonth({reportContext:{proration:{payMode:'monthly',factor:1}}},'0.00')).toBe(false);
  expect(isPartMonth({unpaidLeave:{days:0,amount:0}},'0.00')).toBe(false);
  expect(isPartMonth({},'0.00')).toBe(false);
 });
 it('sets aside the first and last month with the company and every part month, in every basis',()=>{
  const rows=['2026-01','2026-02','2026-03','2026-04','2026-05','2026-06'].map(period=>row(period,'4000.00',
   period==='2026-03'?{statutory:{unpaidLeave:{days:2,amount:300}}}:period==='2026-04'?{statutory:{reportContext:{proration:{factor:0.6}}}}:{}));
  const months=personMonths(rows,{problemSwings:new Set(),fixedUpstream:new Set(),corrections:new Set(),salaryFrom:new Map(),
   tenure:new Map([['e1',{first:'2026-01',last:'2026-06'}]])}).get('e1')!;
  expect(months.map(month=>[month.period,month.excluded])).toEqual([['2026-01',['first_month']],['2026-02',[]],['2026-03',['part_month']],
   ['2026-04',['part_month']],['2026-05',[]],['2026-06',['last_month']]]);
  // Two clean months are left: nothing is shown for this person yet.
  expect(learnBaselines(months,componentIds).regular).toMatchObject({status:'none',runs:2,excluded:4});
 });
});

describe('a person\'s baselines per basis',()=>{
 const none={problemSwings:new Set<string>(),fixedUpstream:new Set<string>(),corrections:new Set<string>(),salaryFrom:new Map<string,string>()};
 it('learns the regular month, the month total and the bonus months, in sen, with pay items keyed on the component id',()=>{
  // Seven regular months: net 4000.00 4100.00 4050.00 4200.00 4000.00 4150.00 4100.00, each with a 150.00 meal allowance
  // (code A0040) and, in March only, a 200.00 shift allowance (code A0041); a code with no single component (Z9) is left out.
  const nets=['4000.00','4100.00','4050.00','4200.00','4000.00','4150.00','4100.00'];
  const lines=(period:string)=>[{code:'A0040',name:'Meal',amount:150,buckets:[{bucket:'reimburse',amount:150}]},
   ...(period==='2026-03'?[{code:'A0041',name:'Shift',amount:200,buckets:[{bucket:'wage',amount:200}]}]:[]),
   {code:'Z9',name:'Unknown',amount:50,buckets:[{bucket:'wage',amount:50}]}];
  const rows=nets.map((net,i)=>{const period=`2026-0${i+1}`;return row(period,net,{statutory:{componentLines:lines(period)}});});
  // December-style bonus runs in March (1000.00 net) and June (1200.00 net).
  rows.push(row('2026-03','1000.00',{runType:'bonus',gross:'1100.00',basic:'0.00',bonus:'1100.00'}),row('2026-06','1200.00',{runType:'bonus',gross:'1300.00',basic:'0.00',bonus:'1300.00'}));
  const learned=learnBaselines(personMonths(rows,none).get('e1')!,componentIds);
  // Regular: n 7, sorted 400000 400000 405000 410000 410000 415000 420000.
  expect(learned.regular).toMatchObject({basis:'regular',status:'stable',runs:7,excluded:0,throughPeriod:'2026-07'});
  expect(learned.regular.components.net).toEqual({n:7,median:410000,p10:400000,p90:420000,nonZero:7,monthMask:0b1111111,fixed:false});
  expect(learned.regular.components.gross).toMatchObject({median:500000,fixed:true});
  expect(learned.regular.components[`item:${MEAL}`]).toEqual({n:7,median:15000,p10:15000,p90:15000,nonZero:7,monthMask:0b1111111,fixed:true});
  expect(learned.regular.components[`item:${SHIFT}`]).toEqual({n:7,median:0,p10:0,p90:20000,nonZero:1,monthMask:0b100,fixed:false});
  expect(Object.keys(learned.regular.components).filter(key=>key.includes('Z9'))).toEqual([]);
  // Month total: March 405000 + 100000 = 505000, June 415000 + 120000 = 535000; sorted 400000 400000 410000 410000 420000
  // 505000 535000: median rank 4 = 410000, P90 rank 7 = 535000.
  expect(learned.month_total.components.net).toMatchObject({n:7,median:410000,p10:400000,p90:535000});
  // Bonus: the two bonus months only, 100000 and 120000: none (under 3).
  expect(learned.bonus).toMatchObject({status:'none',runs:2,throughPeriod:'2026-06'});
  expect(learned.bonus.components.net).toMatchObject({n:2,median:100000,p10:100000,p90:120000,monthMask:0b100100});
  // The payslip lines come first, in their own order; net and gross always.
  expect(Object.keys(learned.regular.components).slice(0,3)).toEqual(['net','gross','basic']);
  expect(LEARNED_LINES[0]).toBe('net');
 });
 it('learns nothing from an excluded month in any basis, and counts it as excluded',()=>{
  const rows=['2026-01','2026-02','2026-03','2026-04'].map(period=>row(period,'4000.00'));
  rows.push(row('2026-02','900.00',{runType:'bonus'}));
  const months=personMonths(rows,{...none,problemSwings:new Set(['e1:2026-02'])}).get('e1')!;
  const learned=learnBaselines(months,componentIds);
  expect(learned.regular).toMatchObject({status:'provisional',runs:3,excluded:1});
  expect(learned.month_total).toMatchObject({runs:3,excluded:1});
  expect(learned.bonus).toMatchObject({status:'none',runs:0,excluded:1,throughPeriod:null});
  // A salary change that leaves 2 months is rebasing.
  const rebased=learnBaselines(personMonths(rows,{...none,salaryFrom:new Map([['e1','2026-03']])}).get('e1')!,componentIds);
  expect(rebased.regular).toMatchObject({status:'rebasing',runs:2,excluded:2});
 });
 it('reads an imported month\'s own pay item lines, and a kernel run\'s own',()=>{
  const imported=row('2026-01','4000.00',{imported:true,runType:'regular',statutory:{importedLines:[{code:'A0040',name:'Meal',amount:150,buckets:[{bucket:'reimburse',amount:150}]}],
   componentLines:[{code:'A0041',name:'Shift',amount:999,buckets:[{bucket:'wage',amount:999}]}]}});
  expect(Object.fromEntries(rowValues(imported,componentIds))).toMatchObject({net:400000,[`item:${MEAL}`]:15000});
  expect(rowValues(imported,componentIds).has(`item:${SHIFT}`)).toBe(false);
 });
});

describe('the small-group rule of the AI read',()=>{
 it('withholds every count from 1 to 4, then the next smallest while only one is withheld; zero is shown',()=>{
  expect(suppressSmallCounts({stable:12,provisional:3,notYet:7,rebasing:0,contradicted:0})).toEqual({stable:12,provisional:null,notYet:null,rebasing:0,contradicted:0});
  expect(suppressSmallCounts({stable:12,provisional:3,notYet:2,rebasing:0,contradicted:6})).toEqual({stable:12,provisional:null,notYet:null,rebasing:0,contradicted:6});
  expect(suppressSmallCounts({stable:12,provisional:9,notYet:7,rebasing:0,contradicted:0})).toEqual({stable:12,provisional:9,notYet:7,rebasing:0,contradicted:0});
  // A tie for the complement goes to the earlier key.
  expect(suppressSmallCounts({a:4,b:8,c:8})).toEqual({a:null,b:null,c:8});
  expect(suppressSmallCounts({a:4,b:0})).toEqual({a:null,b:0});
  expect(()=>suppressSmallCounts({a:-1})).toThrow();
 });
});

const sql=readFileSync('db/migrations/2013_payroll_learned_baseline.sql','utf8');
describe('migration 2013 (first claimed as 2012)',()=>{
 it('forces row-level security and grants read and append only on every table, revoking everything else',()=>{
  for(const table of ['payroll_learning_mode','payroll_learned_baseline','payroll_learning_run']){
   expect(sql).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`);expect(sql).toContain(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY;`);
  }
  expect(sql).toContain('REVOKE ALL ON public.payroll_learning_mode,public.payroll_learned_baseline,public.payroll_learning_run FROM PUBLIC,ai_hr_app;');
  expect(sql).toContain('GRANT SELECT,INSERT ON public.payroll_learning_mode,public.payroll_learned_baseline,public.payroll_learning_run TO ai_hr_app;');
  expect(sql).not.toMatch(/GRANT[^;]*(UPDATE|DELETE)[^;]*payroll_learn/);
 });
 it('gives the agent principal no read of a baseline, and every application read of one requires a payroll administrator',()=>{
  const policies=[...sql.matchAll(/CREATE POLICY (\w+) ON public\.payroll_learned_baseline FOR (\w+) TO (\w+)\s+(USING|WITH CHECK) \(([\s\S]*?)\);\n--> statement-breakpoint/g)];
  expect(policies.map(m=>[m[1],m[2],m[3]])).toEqual([['payroll_learned_baseline_read','SELECT','ai_hr_app'],['payroll_learned_baseline_insert','INSERT','ai_hr_app'],
   ['payroll_learned_baseline_erasure_read','SELECT','PUBLIC'],['payroll_learned_baseline_erasure_delete','DELETE','PUBLIC'],
   ['payroll_learned_baseline_purge_read','SELECT','PUBLIC'],['payroll_learned_baseline_purge_delete','DELETE','PUBLIC']]);
  for(const m of policies.filter(p=>p[3]==='ai_hr_app')){
   expect(m[5]).toContain('app.current_agent_principal() IS NULL');expect(m[5]).toContain('app.can_admin_payroll_for(company_id) IS TRUE');
  }
  // The owner-only policies admit the table owner as current user, never the application role.
  for(const m of policies.filter(p=>p[3]==='PUBLIC'))expect(m[5]).toContain("current_user<>'ai_hr_app'");
  expect(sql).not.toMatch(/payroll_learned_baseline_agent/);
 });
 it('is append-only, cascades with the employment, writes only while learning is on and never for a leaver who is due to go',()=>{
  expect(sql).toContain('employment_id uuid NOT NULL REFERENCES public.employment(id) ON DELETE CASCADE');
  expect(sql).toContain('CREATE TRIGGER payroll_learned_baseline_append_only BEFORE UPDATE ON public.payroll_learned_baseline');
  expect(sql).toContain("AND app.payroll_learning_mode_of(company_id) IN ('evidence','classify') AND app._payroll_learning_leaver_due(employment_id) IS NOT TRUE");
  expect(sql).toContain("+interval '3 months'<=now()");
  // An administrator sets off or evidence; classify comes only from an approved proposal.
  // Off by any payroll administrator, evidence only by a group administrator; classify only from an approved proposal.
  expect(sql).toContain("AND source='admin'\n  AND (mode='off' OR (mode='evidence' AND app.is_group_admin() IS TRUE)));");
  expect(sql).toContain("CHECK (mode<>'classify' OR source='proposal')");
  // Nothing is learned while the tenant's stop switch is on.
  expect(sql).toContain('AND NOT EXISTS (SELECT 1 FROM public.teras_mandate_control c WHERE c.tenant_id=app.current_tenant_id() AND c.stopped IS TRUE));');
  // A mode change is configuration the Audit loop's pack captures.
  expect(LEARNING_MODE_EVENT).toBe('payroll-learning.mode-set');expect(CONFIG_EVENT_PREFIXES).toContain(LEARNING_MODE_EVENT);
  expect(SETTABLE_LEARNING_MODES).toEqual(['off','evidence']);expect(LEARNING_MODES).toEqual(['off','evidence','classify']);
  expect(BASELINE_METHOD).toMatch(/^[a-z_]{1,40}@v[0-9]{1,4}$/);
 });
 it('appends the unchanged learning migration after the installed Personnel baseline',()=>{
  const journal=JSON.parse(readFileSync('db/migrations/meta/_journal.json','utf8')) as {entries:{idx:number;when:number;tag:string}[]};
  expect(journal.entries[682]).toMatchObject({idx:1411,when:1793330001611,tag:'2013_payroll_learned_baseline'});
  expect(journal.entries[681]).toMatchObject({idx:1410,when:1793330001610,tag:'2210_personnel_projection_reuse'});
 });
});

const walk=(fields:readonly SemanticField[]):SemanticField[]=>fields.flatMap(field=>[field,...(field.of?walk(field.of):[])]);
describe('the AI read\'s declaration',()=>{
 it('declares counts, states and dates only: no amount, no range, no person and no id, every count banded',()=>{
  const entity=PAYROLL_LEARNING_ENTITIES[0];
  expect(entity).toMatchObject({id:'payroll_learning',module:'payroll',audience:'admin',rls:'administered_scope',page:'/control-tower/loops/payroll-cycle'});
  const fields=walk(entity.fields);
  expect(fields.map(field=>field.name).filter(name=>/amount|net|gross|median|p10|p90|range|low|high|employ|person|name|id$/i.test(name))).toEqual([]);
  const people=fields.find(field=>field.name==='people')!;
  expect(people.of!.map(field=>[field.name,field.type,field.disclosure])).toEqual([['stable','integer','bands'],['provisional','integer','bands'],
   ['notYet','integer','bands'],['rebasing','integer','bands'],['contradicted','integer','bands']]);
  expect(PAYROLL_LEARNING_MODES).toEqual(LEARNING_MODES);
  expect(LEARNING_STATUSES).toEqual(['stable','provisional','none','rebasing','contradicted']);
  expect(PAYROLL_LEARNING_READS.map(read=>[read.name,read.entity])).toEqual([['payroll_learning_status','payroll_learning']]);
 });
});
