/** ADR-0170 step 4 — the "Why?" explainers, declared in the semantic model.
 *
 * Three own-scope capabilities, each over its native explanation owner, never a second derivation:
 *  - explain_payslip_statutory: core/statutory-explain.ts explainStatutory + statutoryProvenance over the
 *    caller's own RELEASED payslips (the payslip's own stored working; nothing is recomputed);
 *  - explain_leave_entitlement: core/read.ts leaveEntitlementBreakdown through the Mine projection
 *    (core/assistant-leave-projection.ts), so Employee Leave View settings still withhold what they withhold;
 *  - explain_attendance_day: core/attendance-explain.ts explainAttendanceDay over the day's stored trace.
 * Every field the capability returns is declared here with its disclosure class (ADR-0170 §2 principle 4).
 *
 * PAY FIGURES ARE BANDS EVEN IN THE PERSON'S OWN PAYSLIP EXPLANATION. Principle 4 has no own-data exception
 * for what leaves to the provider, and none is needed: the model writes the placeholder and the person sees
 * the exact figure after restoration (the Teras harness restoration step). Exact figures would only let the model do
 * arithmetic, which it must not do. Effective rates are reported by the owner as fractions of the recorded
 * wage, so with the wage they disclose it; they are banded too.
 *
 * Also settles step 1's open questions about existing reads (applied by the generator, ./generate.ts):
 *  - leave_entitlement gains the breakdown fields the Mine projection already returns and step 1's disclosure
 *    removed as undeclared (run 41302596155). They are the caller's own day counts, like their declared
 *    siblings (displayEntitlementDays, totalAvailable), so they are `bands`;
 *  - module_work.data stays `minimum` for module-owned rows, but its pay figures (gross, deductions, net and
 *    pay item amounts) become `bands`: they are the same money my_payslip_summary already bands.
 * Pure declarations; nothing here reads, grants or is imported by the production Assistant. */
import {SEMANTIC_ENTITIES} from './entities';
import type {DisclosureClass,EntityId,FieldType,SemanticEntity,SemanticField,SemanticRead} from './types';

const f=(name:string,type:FieldType,disclosure:DisclosureClass,meaning:string,extra:Partial<Pick<SemanticField,'values'|'of'|'open'>>={}):SemanticField=>({name,type,disclosure,meaning,...extra});
const freeze=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
/** Where an explanation came from: the owner function, where its rule version comes from, and the page the
 * person checks it on. Product vocabulary and routes only. */
export const provenanceField=f('provenance','object','full','Which native owner produced the explanation, where its rule version comes from and the page that shows it.',{of:[
 f('owner','label','full','The native owner function, as path#export.'),f('ruleVersionSource','label','full','Where the rule version comes from, or "not published".'),
 f('page','label','full','The product page where the person sees this themselves.'),f('note','label','full','What the explanation can and cannot say.')]});

export const STATUTORY_ITEMS=['epf','socso','skbbk','eis','hrdf','pcb'] as const;
const statutoryItem:readonly SemanticField[]=[
 f('key','enum','full','Which contribution or tax.',{values:STATUTORY_ITEMS}),f('name','label','full','Its name: EPF, SOCSO, SKBBK, EIS, HRDF or PCB.'),
 f('ruleKind','enum','full','What produced the amount: a percentage, a contribution schedule band, the MTD calculation, or a person (manual).',{values:['rate','schedule','mtd','manual']}),
 f('totalBase','number','bands','The wage the run charged it on (normal plus additional for EPF); null when the run recorded none.'),
 f('additionalBase','number','bands','EPF only: the additional (bonus) wage stream.'),
 f('employeeReported','number','bands','The full employee share as filed.'),f('employeeTakeHome','number','bands','What came off take-home pay.'),
 f('employerBorne','number','bands','Part of the employee share the employer paid.'),f('employer','number','bands','The employer\'s own share.'),
 f('effectiveEmployeeRatePercent','number','bands','Employee share as a percentage of the recorded wage; a check figure, not the rule. Null when not derivable.'),
 f('effectiveEmployerRatePercent','number','bands','Employer share as a percentage of the recorded wage. Null when not derivable.'),
 f('workingNotRecorded','boolean','full','The run recorded no wage for this item, so its working cannot be shown.'),
 f('setBy','enum','full','Who decided the figure: the run\'s rule, a payroll statutory adjustment, or the employee\'s manual EPF amount.',{values:['computed','statutoryAdjustment','epfManualAmount']}),
 f('systemEmployee','number','bands','When set by hand: what the rule had computed for the employee share.'),f('systemEmployer','number','bands','When set by hand: what the rule had computed for the employer share.'),
];
const LEAVE_ENTITLEMENT_EXTENSIONS:readonly SemanticField[]=[
 f('eligibleDays','number','bands','Full-year allowance of the entitlement table that applied, before proration, carry, adjustments or use.'),
 f('currentYearEntitlement','number','bands','Earned to date this cycle, exact.'),f('currentYearEntitlementRounded','number','bands','Earned to date as the leave type\'s rounding shows it.'),
 f('monthlyAccruedToDate','number','bands','Earned leave only: accrued to date this cycle.'),f('carriedForward','number','bands','Days carried into the cycle, after the carry cap.'),
 f('carryForwardRemaining','number','bands','Carried days not yet used.'),f('configAdjustments','number','bands','HR\'s own adjustments this cycle.'),
 f('systemAdjustments','number','bands','Automatic corrections this cycle.'),f('balance','number','bands','Ledger balance as at the date asked.'),
];
const proration=f('proration','object','minimum','How the table allowance became this cycle\'s entitlement.',{of:[
 f('annualEntitlementDays','number','bands','The table allowance.'),f('prorated','boolean','full','Whether it was prorated for a part year.'),
 f('eligibleCalendarDays','integer','bands','Days from joining to the end of the leave year, when prorated.'),f('daysInLeaveYear','integer','full','The divisor, when prorated.'),
 f('unroundedEntitlementDays','number','bands','The prorated figure before rounding.'),f('displayEntitlementDays','number','bands','The entitlement shown.'),
 f('roundingApplied','boolean','full','Whether the leave type\'s rounding changed it.')]});
const leaveEntitlementBase=():readonly SemanticField[]=>{const entity=SEMANTIC_ENTITIES.find(row=>row.id==='leave_entitlement');if(!entity)throw Error('leave_entitlement is not declared.');return entity.fields;};
const PAY_FIGURES:readonly SemanticField[]=[f('gross','number','bands','Gross pay.'),f('deductions','number','bands','Total deductions.'),f('net','number','bands','Net pay.'),f('amount','number','bands','A pay item amount.')];

/** Fields added to, or replacing, declarations of existing entities. Applied by the generator; SHRINK ONLY
 * once ./entities.ts adopts them (step 2 owns that file during step 4). */
export const ENTITY_FIELD_EXTENSIONS:Readonly<Partial<Record<EntityId,Readonly<{add?:readonly SemanticField[];replace?:readonly SemanticField[]}>>>>=freeze({
 leave_entitlement:{add:LEAVE_ENTITLEMENT_EXTENSIONS},
 module_work:{replace:[f('data','list','minimum','Module-owned rows; each module projects its own allow-list. Pay figures inside them are released as bands.',{of:PAY_FIGURES,open:true})]},
});

const ATTENDANCE_STATUS=['exempt','present','absent','rest','off','ph','on_leave'] as const;
const section=(name:string,meaning:string)=>f(name,'object','minimum',meaning,{of:[f('minutes','integer','minimum','The figure explained, in minutes; null when it does not apply to the day.'),
 f('steps','list','minimum','The owner\'s working, one sentence per step, in the person\'s language.')]});
export const EXPLAIN_ENTITIES:readonly SemanticEntity[]=freeze([
 {id:'statutory_explanation',label:'Payslip statutory explanation',meaning:'How each statutory line on one of the caller\'s own released payslips was reached, read from the payslip\'s own stored working.',
  module:'payroll',sensitivity:'pay',audience:'self',rls:'own_person',
  owners:['core/read.ts#myEmploymentIdsAll','core/read.ts#myPayslips','core/statutory-explain.ts#explainStatutory','core/statutory-explain.ts#statutoryProvenance'],
  // The run stamps the statutory ruleset version it used; payslipProvenance is the kernel's one reader of it.
  ruleVersion:'core/payslip-recompute.ts#payslipProvenance',relations:[{to:'payslip',kind:'many_to_one',via:'payPeriod'}],page:'/me/payslip',
  fields:[f('period','period','full','The pay period explained.'),f('availablePeriods','list','full','Released periods the caller can ask about, newest first.'),
   f('payslips','list','minimum','One explanation per released run in the period.',{of:[f('company','label','minimum','Company that paid it.'),f('payPeriod','period','full','Pay period.'),
    f('runType','enum','full','Regular or additional run.'),f('ruleVersion','label','full','Statutory ruleset version stamped by the run; null when it recorded none.'),
    f('basesNotRecorded','boolean','full','The run recorded no wage bases, so no item\'s working can be shown.'),
    f('basesCoverWholeMonth','boolean','full','Amounts are increments of an additional run over the whole month\'s wage, so no rate is derivable.'),
    f('items','list','minimum','Each statutory line.',{of:statutoryItem}),
    f('totals','object','bands','Employee reported, take-home, employer-borne and employer totals.')]}),
   provenanceField]},
 {id:'entitlement_explanation',label:'Leave entitlement explanation',meaning:'Why one of the caller\'s own leave entitlements is what it is this cycle: the table allowance, proration, carry, adjustments and use.',
  module:'leave',sensitivity:'ordinary',audience:'self',rls:'own_employment',
  owners:['core/read.ts#myEmployments','core/read.ts#leaveBalances','core/read.ts#leaveEntitlementBreakdown','core/assistant-leave-projection.ts#projectMineLeaveEntitlement'],
  // Entitlement tables are versioned lineages, but the breakdown does not return the version it resolved
  // (ADR-0170 §3.14 folds company-policy versions into step 5a).
  ruleVersion:null,relations:[{to:'leave_balance',kind:'many_to_one',via:'leaveType'}],page:'/leave',
  fields:[f('leaveType','label','full','Leave type explained.'),f('leaveTypes','list','full','The caller\'s own leave type names, when the one asked for was not found.'),
   f('employments','list','minimum','One explanation per employment that holds the type.',{of:[...leaveEntitlementBase().filter(field=>field.name!=='employmentId'),...LEAVE_ENTITLEMENT_EXTENSIONS,proration]}),
   provenanceField]},
 {id:'attendance_day_explanation',label:'Attendance day explanation',meaning:'Why one of the caller\'s own attendance days reads as it does (late, early out, overtime), from the day\'s stored working.',
  module:'attendance',sensitivity:'ordinary',audience:'self',rls:'own_employment',
  owners:['core/read.ts#myEmployment','core/attendance.ts#attendanceForEmploymentRange','core/attendance-explain.ts#explainAttendanceDay','core/attendance-derive.ts#flagOf','core/attendance-derive.ts#personalAttendanceStatus'],
  // The trace records which attendance rule applied, not a version of it; rules are not versioned yet.
  ruleVersion:null,relations:[],page:'/attendance/my-records',
  fields:[f('date','date','minimum','The day explained.'),f('company','label','minimum','Company of the employment.'),
   f('status','enum','full','The day\'s status.',{values:ATTENDANCE_STATUS}),f('flag','enum','full','Irregularity flag: late, short hours, or a missing punch.',{values:['late','under','odd']}),
   f('recorded','object','minimum','The figures recorded for the day, in minutes.',{of:[f('lateMinutes','integer','minimum','Lateness.'),f('earlyOutMinutes','integer','minimum','Early out.'),
    f('workedMinutes','integer','minimum','Worked time.'),f('overtimeMinutes','integer','minimum','Overtime.')]}),
   f('explained','boolean','full','Whether the day\'s working was recorded.'),f('unavailableReason','enum','full','Why no working can be shown.',{values:['no-trace','unknown-version']}),
   f('schedule','object','minimum','The schedule the calculation used.',{of:[f('source','label','full','Where the schedule came from.'),f('dayType','label','full','Working day, rest day or public holiday.'),
    f('shiftStart','time','minimum','Scheduled start.'),f('shiftEnd','time','minimum','Scheduled end.'),f('scheduledMinutes','integer','minimum','Scheduled minutes.'),
    f('breakMinutes','integer','minimum','Declared break.'),f('ruleApplied','boolean','full','Whether a Lateness, Early Out & Overtime rule applied.'),f('crossesMidnight','boolean','full','The shift crosses midnight.')]}),
   f('punch','object','minimum','The clocking as recorded.',{of:[f('checkIn','time','minimum','Clock-in.'),f('checkOut','time','minimum','Clock-out; null when not clocked out.'),f('workedMinutes','integer','minimum','Worked minutes.')]}),
   section('lateness','How lateness was reached.'),section('earlyOut','How early out was reached.'),section('overtime','How overtime was reached.'),
   provenanceField]},
] satisfies SemanticEntity[]);

const period={type:'string',pattern:'^\\d{4}-\\d{2}$',description:'A released pay period as YYYY-MM. Leave it out for the latest released payslip.'};
export const EXPLAIN_READS:readonly SemanticRead[]=freeze([
 {name:'explain_payslip_statutory',entity:'statutory_explanation',purpose:'Why an EPF, SOCSO, SKBBK, EIS, HRDF or PCB line on the asking person\'s own released payslip is what it is, from the payslip\'s own recorded working. Use it for "why is my EPF/PCB this much" questions.',
  input:[{name:'period',identifier:false,optional:true,schema:period},{name:'item',identifier:false,optional:true,schema:{type:'string',enum:[...STATUTORY_ITEMS],description:'Only this line. Leave it out for all six.'}}]},
 {name:'explain_leave_entitlement',entity:'entitlement_explanation',purpose:'Why the asking person has the entitlement they have for one of their own leave types this cycle: the table allowance, proration for a part year, carry, adjustments and use. Use it for "why do I have N days" questions.',
  input:[{name:'leave_type',identifier:false,schema:{type:'string',maxLength:120,description:'The leave type name as the person or my_leave_balances names it, for example Annual Leave.'}},
   {name:'as_of',identifier:false,optional:true,schema:{type:'string',pattern:'^\\d{4}-\\d{2}-\\d{2}$',description:'Explain as at this date, YYYY-MM-DD. Leave it out for today.'}}]},
 {name:'explain_attendance_day',entity:'attendance_day_explanation',purpose:'Why one of the asking person\'s own attendance days reads as it does (late, early out, overtime), step by step from the day\'s recorded working. Use it for "why was I marked late" questions; ask for the date if it is not clear.',
  input:[{name:'date',identifier:false,schema:{type:'string',pattern:'^\\d{4}-\\d{2}-\\d{2}$',description:'The attendance day, YYYY-MM-DD.'}}]},
] satisfies SemanticRead[]);
