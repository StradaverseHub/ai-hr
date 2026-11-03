/** AI v2 P2-2a — the Salary payroll loop's net-swing flag and the threshold proposals, and the payroll loops' code-level
 * limits, with no database.
 *
 * Every expected figure is written out by hand from the fixtures (payslip columns shaped as the payroll kernel stamps
 * them, the same shapes test/pay-difference.test.ts uses): a swing is the net change over the previous net pay, in basis
 * points, worked on paper. The proposals are worked from the dispositions by hand too. The last block pins that both
 * payroll loops stay at Prepare and that the Salary payroll loop's own code can never run, approve or close payroll or
 * produce a bank file. */
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import type {StoredPayslipRow} from '../core/pay-difference';
import {DEFAULT_SWING_THRESHOLD_BP,netSwingFor,netSwings} from '../core/loops/net-swing';
import {MAX_THRESHOLD_BP,PROPOSAL_MIN_FLAGS,deriveSwingProposals,proposalKey,type SwingDispositionRow} from '../core/loops/swing-proposals';
import {PRE_SALARY_CHECKS,PRE_SALARY_CHECK_HREF,decodeCheck,encodeCheck} from '../core/loops/pre-salary-checks';
import {salaryPeriods} from '../core/loops/salary-payroll';
import {payDayOf} from '../core/loops/payroll-cycle-views';
import {LOOP_DEFINITIONS} from '../core/loops/definitions';
import {DETECTORS} from '../core/payroll-anomaly-detectors';

type Stat=Record<string,unknown>;
const statutory=(over:Stat={}):Stat=>({version:'my-2026.1',epfEmployee:550,epfEmployer:650,socsoEmployee:24.75,socsoEmployer:86.65,socsoSkbbk:0,eisEmployee:9.9,eisEmployer:9.9,pcb:120,hrdf:0,zakat:0,zakatInTotal:true,
 bases:{epf:5000,epfAdditional:0,socsoEis:5000,pcb:5000,hrdf:5000},salaryBasis:{version:1,basicSalary:5000,effectiveFrom:'2024-01-01'},...over});
const row=(over:Partial<StoredPayslipRow>&{statutory?:Stat}={}):StoredPayslipRow=>({companyId:'co-a',company:'Fictional Ceria Sdn Bhd',payPeriod:'2026-09',runType:'regular',runSeq:1,
 basic:'5000.00',allowance:'0.00',overtime:'0.00',bonus:'0.00',gross:'5000.00',statutory:statutory(),otherDeductions:'0.00',totalDeductions:'704.65',net:'4295.35',daysWorked:'30.00',...over});
const SEPTEMBER=row();
// October: a salary change to 5,500 and a bonus run; net 4,740.35 + 890.00 = 5,630.35 (test/pay-difference.test.ts).
const OCT_REGULAR=row({payPeriod:'2026-10',basic:'5500.00',gross:'5500.00',totalDeductions:'759.65',net:'4740.35',
 statutory:statutory({epfEmployee:605,salaryBasis:{version:1,basicSalary:5500,effectiveFrom:'2026-10-01'}})});
const OCT_BONUS=row({payPeriod:'2026-10',runType:'bonus',runSeq:2,basic:'0.00',bonus:'1000.00',gross:'1000.00',totalDeductions:'110.00',net:'890.00',
 statutory:statutory({epfEmployee:110,socsoEmployee:0,eisEmployee:0,pcb:0})});
// October with a new 1,000 meal allowance item and nothing else: net 5,295.35.
const OCT_ALLOWANCE=row({payPeriod:'2026-10',allowance:'1000.00',gross:'6000.00',net:'5295.35',
 statutory:statutory({componentLines:[{code:'A0040',name:'Meal Allowance',amount:1000,buckets:[{bucket:'reimburse',amount:1000}]}]})});
const setting={thresholdBp:DEFAULT_SWING_THRESHOLD_BP,exclusions:[] as string[]};
// The company's pay components by catalogue code: a pattern is keyed on the component's id, never its name.
const MEAL_ID='0000aaaa-0000-4000-8000-00000000a040',OTHER_ID='0000aaaa-0000-4000-8000-00000000a041';
const componentIds=new Map([['A0040',MEAL_ID],['A0041',OTHER_ID]]);
const input=(over:Partial<typeof setting>&{componentIds?:ReadonlyMap<string,string>}={})=>({period:'2026-10',companyId:'co-a',componentIds,...setting,...over});
const meal=(name:string,amount:number,code='A0040')=>({code,name,amount,buckets:[{bucket:'reimburse',amount}]});

describe('the net-swing flag: the pay-difference service\'s change, as a share of last month\'s net pay',()=>{
 it('starts at ±15%, and flags a salary change with a bonus run by the share of the net change',()=>{
  expect(DEFAULT_SWING_THRESHOLD_BP).toBe(1500);
  // (5,630.35 − 4,295.35) / 4,295.35 = 1,335 / 4,295.35 = 31.08% → 3108 basis points.
  expect(netSwingFor('e1',[SEPTEMBER,OCT_REGULAR,OCT_BONUS],input())).toEqual({employmentId:'e1',changed:true,swingBp:3108,direction:'up',
   pattern:'cause:salary_change',causes:['salary_change','additional_run'],flagged:true,excluded:false});
  // The company's own threshold decides: at ±35% the same change is not flagged.
  expect(netSwingFor('e1',[SEPTEMBER,OCT_REGULAR,OCT_BONUS],input({thresholdBp:3500}))).toMatchObject({swingBp:3108,flagged:false,excluded:false});
  // Exactly at the threshold is not over it.
  expect(netSwingFor('e1',[SEPTEMBER,OCT_REGULAR,OCT_BONUS],input({thresholdBp:3108}))).toMatchObject({flagged:false});
 });
 it('names a pay item that explains most of the change by its component\'s id, and an approved exclusion stops that flag only while it explains it',()=>{
  // 1,000 / 4,295.35 = 23.28% → 2328 basis points; the meal allowance item (code A0040) moved by the whole 1,000.
  expect(netSwingFor('e2',[SEPTEMBER,OCT_ALLOWANCE],input())).toEqual({employmentId:'e2',changed:true,swingBp:2328,direction:'up',
   pattern:`item:${MEAL_ID}`,causes:[],flagged:true,excluded:false});
  expect(netSwingFor('e2',[SEPTEMBER,OCT_ALLOWANCE],input({exclusions:[`item:${MEAL_ID}`]}))).toMatchObject({swingBp:2328,flagged:false,excluded:true});
  // A cause can be excluded too; a different exclusion changes nothing.
  expect(netSwingFor('e1',[SEPTEMBER,OCT_REGULAR,OCT_BONUS],input({exclusions:['cause:salary_change']}))).toMatchObject({flagged:false,excluded:true});
  expect(netSwingFor('e1',[SEPTEMBER,OCT_REGULAR,OCT_BONUS],input({exclusions:[`item:${MEAL_ID}`]}))).toMatchObject({flagged:true,excluded:false});
 });
 it('keeps a learned pattern when the component is renamed, and never guesses between two components of one name',()=>{
  // September's 200 meal allowance becomes October's 1,200 under a new name; the code, and so the id, is the same.
  // (5,495.35 − 4,495.35) / 4,495.35 = 22.25% → 2225 basis points.
  const september=row({allowance:'200.00',gross:'5200.00',net:'4495.35',statutory:statutory({componentLines:[meal('Meal Allowance',200)]})});
  const renamed=row({payPeriod:'2026-10',allowance:'1200.00',gross:'6200.00',net:'5495.35',statutory:statutory({componentLines:[meal('Fictional Meal Support',1200)]})});
  expect(netSwingFor('e6',[september,renamed],input())).toMatchObject({swingBp:2225,pattern:`item:${MEAL_ID}`,flagged:true});
  expect(netSwingFor('e6',[september,renamed],input({exclusions:[`item:${MEAL_ID}`]}))).toMatchObject({pattern:`item:${MEAL_ID}`,flagged:false,excluded:true});
  // Two components share the name "Meal Allowance": the item cannot be tied to one, so its cause stands in (none: other).
  // (5,595.35 − 4,595.35) / 4,595.35 = 21.76% → 2176 basis points.
  const before=row({allowance:'300.00',gross:'5300.00',net:'4595.35',statutory:statutory({componentLines:[meal('Meal Allowance',300,'A0041')]})});
  const after=row({payPeriod:'2026-10',allowance:'1300.00',gross:'6300.00',net:'5595.35',statutory:statutory({componentLines:[meal('Meal Allowance',1000),meal('Meal Allowance',300,'A0041')]})});
  expect(netSwingFor('e7',[before,after],input())).toMatchObject({swingBp:2176,pattern:'cause:other',flagged:true});
  // A code no longer in the catalogue cannot be keyed either.
  expect(netSwingFor('e2',[SEPTEMBER,OCT_ALLOWANCE],input({componentIds:new Map()}))).toMatchObject({pattern:'cause:other',flagged:true});
 });
 it('never flags a person with no ratio, and counts each cause over the company',()=>{
  // Unchanged: no swing. Paid only this month: no comparison at all. A previous net of zero: changed, but no ratio.
  expect(netSwingFor('e3',[SEPTEMBER,row({payPeriod:'2026-10'})],input())).toMatchObject({changed:false,swingBp:0,flagged:false});
  expect(netSwingFor('e4',[OCT_REGULAR],input())).toBeNull();
  expect(netSwingFor('e5',[row({net:'0.00'}),OCT_REGULAR],input())).toMatchObject({changed:true,swingBp:null,flagged:false});
  const summary=netSwings(new Map([['e1',[SEPTEMBER,OCT_REGULAR,OCT_BONUS]],['e2',[SEPTEMBER,OCT_ALLOWANCE]],['e3',[SEPTEMBER,row({payPeriod:'2026-10'})]]]),input());
  expect([summary.compared,summary.changed,summary.flagged]).toEqual([3,2,2]);
  expect(summary.causes).toMatchObject({salary_change:1,additional_run:1,unpaid_leave:0});
 });
});

const flags=(pattern:string,disposition:'expected'|'problem',swings:number[]):SwingDispositionRow[]=>swings.map(swingBp=>({pattern,swingBp,disposition}));
describe('threshold proposals: learned from payroll HR\'s dispositions, never applied by themselves',()=>{
 it('proposes an exclusion when 80% of at least five flags of one pattern were expected, and a higher threshold below the smallest real problem',()=>{
  expect(PROPOSAL_MIN_FLAGS).toBe(5);
  const rows=[...flags('item:COMM','expected',[1600,1800,2000,2200,2400]),...flags('cause:salary_change','problem',[2100])];
  const proposals=deriveSwingProposals(rows,setting);
  // Exclusion: 5 of 5 commission flags expected. Threshold: 5 of 6 expected (83.33%); 80% of the expected swings sit at
  // or below the 4th smallest, 2,200, which is above the smallest real problem, 2,100, so the threshold stops at 20%.
  expect(proposals.map(p=>[p.kind,p.fromThresholdBp,p.toThresholdBp,p.pattern,p.evidence])).toEqual([
   ['exclusion',1500,null,'item:COMM',{windowDays:30,flags:5,expected:5,problems:0,expectedShareBp:10000,smallestProblemBp:null}],
   ['threshold',1500,2000,null,{windowDays:30,flags:6,expected:5,problems:1,expectedShareBp:8333,smallestProblemBp:2100}]]);
  for(const p of proposals)expect(p.key).toBe(proposalKey(p));
 });
 it('proposes nothing below 80%, below five flags, or for a pattern already excluded, and never above 50%',()=>{
  expect(deriveSwingProposals([...flags('item:COMM','expected',[1600,1700,1800,1900]),...flags('item:COMM','problem',[2000,2100])],setting)).toEqual([]);
  expect(deriveSwingProposals(flags('item:COMM','expected',[1600,1700,1800,1900]),setting)).toEqual([]);
  expect(deriveSwingProposals(flags('item:COMM','expected',[1600,1800,2000,2200,2400]),{thresholdBp:1500,exclusions:['item:COMM']}).map(p=>p.kind)).toEqual(['threshold']);
  const high=deriveSwingProposals(flags('cause:days_paid','expected',[9000,9100,9200,9300,9400]),setting).find(p=>p.kind==='threshold');
  expect(high?.toThresholdBp).toBe(MAX_THRESHOLD_BP);
  expect(MAX_THRESHOLD_BP).toBe(5000);
  // A threshold already at or above what the evidence supports is not proposed again.
  expect(deriveSwingProposals(flags('item:COMM','expected',[1600,1800,2000,2200,2400]),{thresholdBp:2200,exclusions:['item:COMM']})).toEqual([]);
 });
 it('does not offer a proposal an administrator rejected while its evidence is the same',()=>{
  const rows=flags('item:COMM','expected',[1600,1800,2000,2200,2400]);
  const [exclusion,threshold]=deriveSwingProposals(rows,setting);
  expect(deriveSwingProposals(rows,setting,new Set([exclusion.key])).map(p=>p.kind)).toEqual(['threshold']);
  // One more disposition is new evidence: a new key, offered again.
  const more=deriveSwingProposals([...rows,...flags('item:COMM','expected',[2600])],setting,new Set([exclusion.key,threshold.key]));
  expect(more.map(p=>p.kind)).toEqual(['exclusion','threshold']);
 });
});

describe('the Pre-salary checks\' record, periods and pay day',()=>{
 it('records each check as closed keys and counts only, and links each to its owner page',()=>{
  // Wave 1 integration: the payroll Audit loop's repeat issues (P2-2b) are the last check.
  expect(PRE_SALARY_CHECKS).toEqual(['timesheets','overtime','leave','claims','joinersLeavers','statutoryBank','payChanges','setup','repeatAudit']);
  const value={key:'claims' as const,status:'open' as const,open:2,waiting:1,warnings:1,info:0};
  expect(encodeCheck(value)).toBe('claims:open:2:1:1:0');
  expect(decodeCheck('claims:open:2:1:1:0')).toEqual(value);
  for(const bad of ['claims:open:2:1:1','salary:open:1:1:1:1','claims:open:a:1:1:1',null,42])expect(decodeCheck(bad)).toBeNull();
  expect(PRE_SALARY_CHECK_HREF).toEqual({timesheets:'/attendance/individual',overtime:'/approvals?category=overtime',leave:'/approvals?category=leave',
   claims:'/approvals?category=claim',joinersLeavers:'/personnel',statutoryBank:'/control-tower/readiness',payChanges:'/performance',setup:'/payroll/setup?readiness=full',
   repeatAudit:'/control-tower/loops/loop_payroll_audit'});
  expect(decodeCheck('repeatAudit:warning:0:0:2:0')).toEqual({key:'repeatAudit',status:'warning',open:0,waiting:0,warnings:2,info:0});
 });
 it('starts the Salary payroll loop once the cut-off has passed, and reads the pay day from the company\'s day',()=>{
  const monthEnd=(period:string)=>({'2026-06':'2026-06-30','2026-07':'2026-07-31'} as Record<string,string>)[period];
  expect(salaryPeriods(monthEnd,'2026-07-02')).toEqual({active:'2026-06',current:'2026-07'});
  const twentieth=(period:string)=>`${period}-20`;
  expect(salaryPeriods(twentieth,'2026-07-21')).toEqual({active:'2026-07',current:'2026-07'});
  expect(salaryPeriods(twentieth,'2026-07-20')).toEqual({active:'2026-06',current:'2026-07'});
  expect([payDayOf(28,'2026-02'),payDayOf(31,'2026-04'),payDayOf(null,'2026-02')]).toEqual(['2026-02-28','2026-04-30','2026-02-28']);
 });
});

describe('pay stays at Prepare, enforced in code',()=>{
 it('pins both payroll loops at Prepare and leaves the 11 anomaly detectors alone',()=>{
  expect(LOOP_DEFINITIONS.loop_payroll_inputs.prepareOnly).toBe(true);
  expect(LOOP_DEFINITIONS.loop_salary_payroll.prepareOnly).toBe(true);
  expect(LOOP_DEFINITIONS.loop_payroll_inputs.due).toBeTypeOf('function');
  expect(LOOP_DEFINITIONS.loop_salary_payroll.due).toBeUndefined();
  expect(DETECTORS).toHaveLength(11);
 });
 it('the Salary payroll loop\'s code cannot run, approve or close payroll, or produce a bank file',()=>{
  const source=(file:string)=>readFileSync(new URL(`../${file}`,import.meta.url),'utf8');
  for(const file of ['core/loops/salary-payroll.ts','core/loops/net-swing.ts','core/loops/swing-proposals.ts','core/loops/payroll-cycle-views.ts',
   'core/loops/salary-swing-service.ts','core/loops/payroll-loop-settings.ts','core/loops/payroll-inputs.ts','core/loops/pre-salary-checks.ts']){
   const text=source(file);
   expect(text,file).not.toMatch(/\b(closeBatch|generatePayslips|createBatch|createAdditionalRun|reopenBatch|unlockBatch|rollbackBatch|applyPayrollClose\w*|withReviewedPayrollClose\w*|processBatch|resetBatch)\b/);
   expect(text,file).not.toMatch(/\.download\(/);
   expect(text,file).not.toMatch(/from '[./]*lib\/ai'|generateDraft|converse\(/);
  }
  // Its only use of the bank file generation is the preview, which allocates no Tape ID and writes nothing.
  expect(source('core/loops/salary-payroll.ts')).toContain('preview=await salaryRunPreview(sponsor,');
  // Which bank, currency and salary file format is the country pack's to know (localization/my/ocbc-payment.ts), never the loop's.
  expect(source('core/loops/salary-payroll.ts')).not.toMatch(/ocbc|my\.ocbc|'MYR'|bank_profile|listCompanyBankProfiles/i);
 });
});
