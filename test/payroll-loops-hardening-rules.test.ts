/** AI v2 Phase 2 hardening (4 November 2026) — the payroll loops' new rules, with no database.
 *
 * Every expected value is written out by hand from the fixtures: the excluded-cause rule of the net-swing flag, the grouping
 * of open flags, the reminder lead days, the pay-relevant profile change, the learned standing-rule proposal, the
 * acknowledgement precedence, the audit-control loosening rule, the data-aware readiness and anomaly rules, the reminders'
 * non-pay class, and migration 2011's own guarantees (FORCE row-level security and exact grants on every new table, the
 * close circuit's prior cycle by run type). The database behaviour is test/payroll-loops-hardening.test.ts. */
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import type {StoredPayslipRow} from '../core/pay-difference';
import {netSwingFor} from '../core/loops/net-swing';
import {swingFlagGroups} from '../core/loops/grouped-dispositions';
import {REMINDER_LEAD_DAYS,remindersDue} from '../core/loops/cut-off-reminders';
import {isPayRelevantProfileChange} from '../core/loops/pay-relevant';
import {ACKNOWLEDGEABLE_CHECKS,BLOCK_CHECKS,PROPOSAL_MIN_RUNS,acknowledgementFor,deriveRuleProposals,isBlockCheck,type Acknowledgement,type DispositionRun} from '../core/loops/acknowledgements';
import {loosensAuditControl} from '../core/payroll-audit/settings';
import {AUDIT_CONTROL_BOUNDS,AUDIT_CONTROL_DEFAULTS} from '../core/payroll-audit/types';
import {gapsForRecord} from '../core/record-readiness';
import {DETECTORS,type DetectorContext} from '../core/payroll-anomaly-detectors';
import {CAPPED_CATEGORIES,LOOP_NOTICES,maxLevel,noticeAllowed,promotableTo,touchesCapped} from '../core/loops/autonomy';
import {LOOP_ACTION_REASONS} from '../core/loops/autonomy-types';
import {MAX_THRESHOLD_BP} from '../core/loops/swing-proposals';
import {CONFIG_EVENT_PREFIXES} from '../core/payroll-audit/capture';

type Stat=Record<string,unknown>;
const statutory=(over:Stat={}):Stat=>({version:'my-2026.1',epfEmployee:550,epfEmployer:650,socsoEmployee:24.75,socsoEmployer:86.65,socsoSkbbk:0,eisEmployee:9.9,eisEmployer:9.9,pcb:120,hrdf:0,zakat:0,zakatInTotal:true,
 bases:{epf:5000,epfAdditional:0,socsoEis:5000,pcb:5000,hrdf:5000},salaryBasis:{version:1,basicSalary:5000,effectiveFrom:'2024-01-01'},...over});
const row=(over:Partial<StoredPayslipRow>&{statutory?:Stat}={}):StoredPayslipRow=>({companyId:'co-a',company:'Fictional Ceria Sdn Bhd',payPeriod:'2026-09',runType:'regular',runSeq:1,
 basic:'5000.00',allowance:'0.00',overtime:'0.00',bonus:'0.00',gross:'5000.00',statutory:statutory(),otherDeductions:'0.00',totalDeductions:'704.65',net:'4295.35',daysWorked:'30.00',...over});
// September 4,295.35; October a salary change to 5,500 only: 4,740.35, a change of 445.00 = 10.36% of September.
const SEPTEMBER=row();
const OCT_REGULAR=row({payPeriod:'2026-10',basic:'5500.00',gross:'5500.00',totalDeductions:'759.65',net:'4740.35',
 statutory:statutory({epfEmployee:605,salaryBasis:{version:1,basicSalary:5500,effectiveFrom:'2026-10-01'}})});
// And a 1,000 bonus run in the same October: 890.00 more, a second cause.
const OCT_BONUS=row({payPeriod:'2026-10',runType:'bonus',runSeq:2,basic:'0.00',bonus:'1000.00',gross:'1000.00',totalDeductions:'110.00',net:'890.00',
 statutory:statutory({epfEmployee:110,socsoEmployee:0,eisEmployee:0,pcb:0})});
const swing=(rows:StoredPayslipRow[],thresholdBp:number,exclusions:string[])=>netSwingFor('e1',rows,{period:'2026-10',companyId:'co-a',thresholdBp,exclusions});

describe('an excluded cause never hides a change of any size (review finding A1)',()=>{
 it('explains a change only when it is the only cause and the swing is under twice the threshold',()=>{
  // 10.36% against 10%: over it, under twice it, one cause: excluded.
  expect(swing([SEPTEMBER,OCT_REGULAR],1000,['cause:salary_change'])).toMatchObject({swingBp:1036,causes:['salary_change'],flagged:false,excluded:true});
  // Against 5%: 10.36% is at least twice 5%, so it is flagged whatever is excluded.
  expect(swing([SEPTEMBER,OCT_REGULAR],500,['cause:salary_change'])).toMatchObject({swingBp:1036,flagged:true,excluded:false});
  // A second cause beside the excluded one (the bonus run): flagged.
  const both=swing([SEPTEMBER,OCT_REGULAR,OCT_BONUS],2000,['cause:salary_change']);
  expect(both).not.toBeNull();
  expect(both!.causes.length).toBeGreaterThan(1);
  expect(both).toMatchObject({flagged:true,excluded:false});
  // No exclusion: flagged as before.
  expect(swing([SEPTEMBER,OCT_REGULAR],1000,[])).toMatchObject({flagged:true,excluded:false});
 });
 it('caps every threshold at the proposal cap, 50%',()=>{
  expect(MAX_THRESHOLD_BP).toBe(5000);
  const sql=readFileSync('db/migrations/2005_teras_payroll_cycle_loops.sql','utf8');
  expect(sql).toContain('swing_threshold_bp integer NOT NULL CHECK (swing_threshold_bp BETWEEN 100 AND 5000)');
  expect(sql).toContain("AND (decision='rejected' OR (app.is_group_admin() IS TRUE AND NOT EXISTS (SELECT 1 FROM public.teras_payroll_swing_disposition d");
 });
});

describe('grouped dispositions (B5)',()=>{
 const flag=(caseId:string,pattern:string,swingBp:number,over:Partial<{state:'open'|'closed';disposition:unknown;payPeriod:string}>={})=>({caseId,companyId:'co-a',companyName:'Fictional A',
  personName:`Person ${caseId}`,payPeriod:over.payPeriod??'2026-10',pattern,swingBp,direction:'up' as const,causes:['salary_change' as const],state:over.state??'open',disposition:over.disposition??null});
 it('groups the open, undisposed flags by company, month and pattern, the biggest group first and the biggest swing first',()=>{
  const groups=swingFlagGroups([flag('a','cause:salary_change',1800),flag('b','item:x',2500),flag('c','cause:salary_change',3100),flag('d','cause:salary_change',2000,{state:'closed'}),
   flag('e','cause:salary_change',2200,{disposition:{value:'expected'}}),flag('f','cause:salary_change',1900,{payPeriod:'2026-09'})]);
  expect(groups.map(group=>[group.payPeriod,group.pattern,group.members.map(member=>member.caseId)])).toEqual([
   ['2026-10','cause:salary_change',['c','a']],['2026-09','cause:salary_change',['f']],['2026-10','item:x',['b']]]);
 });
});

describe('automatic cut-off reminders (B6, owner ruling 18)',()=>{
 const windows={salary:{start:'2026-06-25',end:'2026-07-24'},attendance:{start:'2026-06-15',end:'2026-07-14'},overtime:{start:'2026-06-25',end:'2026-07-24'},
  claim:{start:'2026-07-01',end:'2026-07-31'},leave:{start:'2026-07-01',end:'2026-07-31'}};
 it('is due exactly 5, 2 and 1 days before each cut-off, one reminder per cut-off date with every type that closes on it',()=>{
  expect(REMINDER_LEAD_DAYS).toEqual([5,2,1]);
  expect(remindersDue(windows,'2026-07-09')).toEqual([{cutOff:'2026-07-14',lead:5,types:['attendance']}]);
  expect(remindersDue(windows,'2026-07-12')).toEqual([{cutOff:'2026-07-14',lead:2,types:['attendance']}]);
  expect(remindersDue(windows,'2026-07-23')).toEqual([{cutOff:'2026-07-24',lead:1,types:['salary','overtime']}]);
  expect(remindersDue(windows,'2026-07-29')).toEqual([{cutOff:'2026-07-31',lead:2,types:['claim','leave']}]);
  for(const today of ['2026-07-10','2026-07-14','2026-07-20','2026-07-24'])expect(remindersDue(windows,today),today).toEqual([]);
 });
 it('is a notice in a non-pay class, so the Pre-salary loop (pay, capped at Prepare) may send it while itself only preparing',()=>{
  expect(LOOP_NOTICES.loop_payroll_inputs?.category).toBe('payroll_input_reminder');
  expect((CAPPED_CATEGORIES as readonly string[]).includes('payroll_input_reminder')).toBe(false);
  expect(touchesCapped(['payroll_input_reminder'])).toBe(false);
  expect(noticeAllowed('loop_payroll_inputs')).toBe(true);
  // The loop itself never rises above Prepare, and no other loop has a notice step.
  expect([maxLevel('loop_payroll_inputs'),promotableTo('loop_payroll_inputs')]).toEqual([1,1]);
  expect(Object.keys(LOOP_NOTICES)).toEqual(['loop_payroll_inputs']);
  expect(noticeAllowed('loop_salary_payroll')).toBe(false);
 });
});

describe('data-aware checks (B3): each reads the owning fact first',()=>{
 it('counts only pay-relevant profile updates',()=>{
  expect(isPayRelevantProfileChange({bankAccountNo:'123'})).toBe(true);
  expect(isPayRelevantProfileChange({maritalStatus:'married'})).toBe(true);
  expect(isPayRelevantProfileChange({preferredName:'Ah Kow'})).toBe(false);
  expect(isPayRelevantProfileChange({kind:'photo'})).toBe(false);
  expect(isPayRelevantProfileChange({v:2,fields:[{fieldId:'bank_statutory.bank_information.bankaccountno'}],registers:[]})).toBe(true);
  expect(isPayRelevantProfileChange({v:2,fields:[{fieldId:'profile.contact.mobilephone'}],registers:[]})).toBe(false);
  expect(isPayRelevantProfileChange({v:2,fields:[],registers:[{fields:[{fieldId:'bank_statutory.income_tax_pcb.numchildren'}]}]})).toBe(true);
  expect(isPayRelevantProfileChange(null)).toBe(false);
 });
 it('asks EPF, SOCSO and EIS exempt staff for no number, and cash-paid staff for no bank account',()=>{
  const base={paymentMethod:'bank_transfer',ic:'900101015551',passport:null,taxNumber:'SG1',epfNumber:null,socsoNumber:null,bankAccountNo:'1',hasComp:true};
  expect(gapsForRecord(base)).toEqual(['no_epf_number','no_socso_number']);
  expect(gapsForRecord({...base,epfMode:'exempt'})).toEqual(['no_socso_number']);
  // Not subject to SOCSO but still eligible for EIS: the SOCSO and EIS number is still needed.
  expect(gapsForRecord({...base,subjectToSocso:false,eisEligible:true})).toEqual(['no_epf_number','no_socso_number']);
  expect(gapsForRecord({...base,epfMode:'exempt',subjectToSocso:false,eisEligible:false})).toEqual([]);
  expect(gapsForRecord({...base,paymentMethod:'cash',bankAccountNo:null,epfMode:'exempt',subjectToSocso:false,eisEligible:false})).toEqual([]);
 });
 const ctx=(over:{profile?:Partial<DetectorContext['profile']>;activity?:Partial<DetectorContext['activity']>;daysWorked?:number|null}={}):DetectorContext=>({employmentId:'e1',
  current:{grossPay:3000,netPay:2800,basicSalary:3000,allowance:0,overtimePay:0,bonus:0,totalDeductions:200,daysWorked:over.daysWorked===undefined?null:over.daysWorked,statutory:{}} as never,prior:null,
  profile:{hasBankProfile:true,hasTaxProfile:true,paymentMethod:'bank_transfer',hiredOn:'2024-01-01',terminatedOn:null,concurrentPaidEmploymentIds:[],...over.profile},
  activity:{attendanceDays:0,approvedLeaveDays:0,...over.activity},period:{start:'2026-10-01',end:'2026-10-31',calendarDays:31},caps:{},eventIds:[]});
 const detector=(id:string)=>DETECTORS.find(item=>item.id===id)!;
 it('does not flag pay without attendance for staff whose schedule group is exempt for the whole month',()=>{
  expect(detector('pay-without-attendance').evaluate(ctx(),{})).toHaveLength(1);
  expect(detector('pay-without-attendance').evaluate(ctx({activity:{attendanceExempt:true}}),{})).toEqual([]);
 });
 it('does not flag a daily-rated person\'s partial month as a proration mismatch',()=>{
  expect(detector('proration-mismatch').evaluate(ctx({daysWorked:18}),{})).toHaveLength(1);
  expect(detector('proration-mismatch').evaluate(ctx({daysWorked:18,profile:{payMode:'daily'}}),{})).toEqual([]);
  expect(detector('proration-mismatch').evaluate(ctx({daysWorked:18,profile:{payMode:'monthly'}}),{})).toHaveLength(1);
 });
});

describe('standing acknowledgements (B4, owner ruling 19)',()=>{
 const ack=(over:Partial<Acknowledgement>):Acknowledgement=>({id:'k',companyId:'co-a',checkId:'audit:pay_without_attendance',scope:'company',employmentId:null,departmentId:null,
  reason:'r',reviewOn:null,source:'person',createdByUserId:'u',createdAt:new Date(0),...over});
 it('covers a person by their own, then their group\'s, then the company\'s, for one check only',()=>{
  const list=[ack({id:'company'}),ack({id:'group',scope:'group',departmentId:'d1'}),ack({id:'person',scope:'person',employmentId:'e1'}),ack({id:'other',checkId:'swing:net_swing',scope:'company'})];
  const of=(employmentId:string|null,departmentId:string|null,checkId='audit:pay_without_attendance')=>acknowledgementFor(list,{companyId:'co-a',checkId,employmentId,departmentId})?.id??null;
  expect([of('e1','d1'),of('e2','d1'),of('e3','d2'),of(null,null)]).toEqual(['person','group','company','company']);
  expect(of('e1','d1','audit:shared_bank_account')).toBeNull();
  expect(acknowledgementFor(list,{companyId:'co-b',checkId:'audit:pay_without_attendance',employmentId:'e1',departmentId:'d1'})).toBeNull();
 });
 it('knows which checks block (never suppressed) from the anomaly layer\'s own blocking detectors',()=>{
  expect([...BLOCK_CHECKS].sort()).toEqual(['anomaly:duplicate-employment-pay','anomaly:missing-bank-profile','anomaly:negative-net','anomaly:statutory-over-cap']);
  for(const id of BLOCK_CHECKS)expect(ACKNOWLEDGEABLE_CHECKS).toContain(id);
  expect(isBlockCheck('audit:pay_without_attendance')).toBe(false);
  expect(ACKNOWLEDGEABLE_CHECKS).toContain('swing:net_swing');
 });
 it('proposes a standing rule after five or more runs of the same check and person with at least 80% expected, never for a block',()=>{
  expect(PROPOSAL_MIN_RUNS).toBe(5);
  const at=(day:number)=>new Date(Date.UTC(2026,9,day));
  const runs=(checkId:string,employmentId:string,expected:boolean[]):DispositionRun[]=>expected.map((value,i)=>({companyId:'co-a',checkId,employmentId,expected:value,by:i%2?'u1':'u2',at:at(i+1)}));
  const derive=(rows:DispositionRun[])=>deriveRuleProposals(rows,()=>false).map(p=>[p.checkId,p.employmentId,p.evidence.runs,p.evidence.expected,p.evidence.expectedShareBp,[...p.disposers]]);
  // Five, all expected: proposed, with both disposers named (neither may approve it).
  expect(derive(runs('audit:pay_without_attendance','e1',[true,true,true,true,true]))).toEqual([['audit:pay_without_attendance','e1',5,5,10_000,['u1','u2']]]);
  // Four only, or four of five with the latest a problem, or 3 of 5 expected: nothing.
  expect(derive(runs('audit:pay_without_attendance','e1',[true,true,true,true]))).toEqual([]);
  expect(derive(runs('audit:pay_without_attendance','e1',[true,true,true,true,false]))).toEqual([]);
  expect(derive(runs('swing:net_swing','e2',[true,false,true,false,true]))).toEqual([]);
  // Four of five expected, the latest expected: 80%, proposed.
  expect(derive(runs('swing:net_swing','e2',[false,true,true,true,true]))).toEqual([['swing:net_swing','e2',5,4,8000,['u1','u2']]]);
  // A block is never proposed; an acknowledged check is not proposed again.
  expect(derive(runs('anomaly:negative-net','e3',[true,true,true,true,true]))).toEqual([]);
  expect(deriveRuleProposals(runs('audit:pay_without_attendance','e1',[true,true,true,true,true]),()=>true)).toEqual([]);
  // A rejected proposal is not offered again while its evidence is the same.
  const [first]=deriveRuleProposals(runs('audit:pay_without_attendance','e1',[true,true,true,true,true]),()=>false);
  expect(deriveRuleProposals(runs('audit:pay_without_attendance','e1',[true,true,true,true,true]),()=>false,new Set([first.key]))).toEqual([]);
 });
});

describe('the audit controls (review finding A4)',()=>{
 it('has bounds, and names every loosening that needs a group administrator',()=>{
  expect(AUDIT_CONTROL_BOUNDS).toEqual({bankChangeDays:{min:3,max:30},adjustmentThreshold:{min:100,max:50_000}});
  expect(AUDIT_CONTROL_DEFAULTS).toEqual({bankChangeDays:7,adjustmentThreshold:1000,preparerClosedMode:'info'});
  const d={...AUDIT_CONTROL_DEFAULTS};
  expect(loosensAuditControl(d,{...d,bankChangeDays:6})).toBe(true);
  expect(loosensAuditControl(d,{...d,adjustmentThreshold:1000.01})).toBe(true);
  expect(loosensAuditControl({...d,preparerClosedMode:'finding'},d)).toBe(true);
  expect(loosensAuditControl(d,{...d,bankChangeDays:14,adjustmentThreshold:500,preparerClosedMode:'finding'})).toBe(false);
  const sql=readFileSync('db/migrations/2006_payroll_audit_loop.sql','utf8');
  expect(sql).toContain('bank_change_days integer NOT NULL DEFAULT 7 CHECK (bank_change_days BETWEEN 3 AND 30)');
  expect(sql).toContain("RAISE EXCEPTION 'Only a group administrator may loosen a payroll audit control'");
  expect(sql).not.toContain('payroll_audit_capture_version_uq');
  expect(sql).toContain('IF v_latest IS NOT DISTINCT FROM NEW.content_hash THEN RETURN NULL; END IF;');
 });
 it('lists every loosening configuration change in the month\'s audit pack, and never the capture anchors themselves',()=>{
  for(const prefix of ['teras-payroll-loop.setting-changed','teras-payroll-loop.proposal-decided','payroll-audit.settings-changed','payroll-audit.reader-',
   'payroll-check.acknowledgement-'])expect(CONFIG_EVENT_PREFIXES).toContain(prefix);
  expect(CONFIG_EVENT_PREFIXES.some(prefix=>'payroll-audit.captured'.startsWith(prefix))).toBe(false);
 });
});

describe('the autonomy step honours a stop between record and apply (review finding A8)',()=>{
 it('re-checks inside both apply transactions, at the start and before commit, and records loop_stopped',()=>{
  expect(LOOP_ACTION_REASONS).toContain('loop_stopped');
  for(const file of ['core/loops/act-clock-outs.ts','core/loops/act-requests.ts'])
   expect(readFileSync(file,'utf8').match(/await requireLoopMayStillActTx\(tx,gate\);/g),file).toHaveLength(2);
 });
});

describe('migration 2011',()=>{
 const sql=readFileSync('db/migrations/2011_payroll_loops_hardening.sql','utf8');
 it('forces row-level security on every new table and grants exactly what each needs',()=>{
  for(const table of ['payroll_check_acknowledgement','payroll_check_rule_decision','teras_cut_off_reminder','payroll_tp3_previous_employer_answer']){
   expect(sql).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`);
   expect(sql).toContain(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY;`);
  }
  expect(sql).toContain('REVOKE ALL ON public.payroll_check_acknowledgement,public.payroll_check_rule_decision,public.teras_cut_off_reminder FROM PUBLIC,ai_hr_app;');
  expect(sql).toContain('GRANT SELECT,INSERT,UPDATE ON public.payroll_check_acknowledgement TO ai_hr_app;');
  expect(sql).toContain('GRANT SELECT,INSERT ON public.payroll_check_rule_decision,public.teras_cut_off_reminder TO ai_hr_app;');
  // Coordinator review: a joiner's own TP3 answer, read and inserted only (never rewritten).
  expect(sql).toContain('REVOKE ALL ON public.payroll_tp3_previous_employer_answer FROM PUBLIC,ai_hr_app;');
  expect(sql).toContain('GRANT SELECT,INSERT ON public.payroll_tp3_previous_employer_answer TO ai_hr_app;');
  expect(sql).not.toMatch(/GRANT[^;]*DELETE/);
 });
 it('selects the close circuit\'s prior cycle by run type, and accepts only such a prior',()=>{
  expect(sql).toContain('WHERE b.company_id=t.company_id AND b.run_type=t.run_type AND b.pay_period<t.pay_period');
  expect(sql).toContain('prior.company_id=b.company_id AND prior.run_type=b.run_type AND prior.pay_period<b.pay_period');
  const anomaly=readFileSync('core/payroll-anomaly.ts','utf8');
  expect(anomaly.match(/eq\(schema\.payrollBatch\.runType, batch\.runType\)/g)).toHaveLength(2);
 });
});
