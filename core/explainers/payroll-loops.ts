/** AI v2 Phase 2 (wave 1 integration) — the four payroll-cycle loop reads as an administrator may ask about them
 * (core/semantic-model/entities-payroll-loops.ts), each over its page's own read owner, run as the caller:
 *  - payroll_cycle_status: core/loops/payroll-cycle-views.ts payrollCycleOverview, with P2-2b's Audit summary in it;
 *  - salary_payroll_checks: salaryLoopPage;
 *  - payroll_loop_settings: payrollLoopSettingsPage;
 *  - payroll_audit_status: core/payroll-audit/status.ts auditLoopSummary.
 * Each copies only the declared fields: company names, states, dates, counts and configuration. It drops every person
 * (the employee behind a flag, the administrator who changed a setting or decided a proposal), every id, every per-person
 * swing and every amount. Percentages are the owners' basis points divided by 100 here, a unit change of a ratio the
 * owner set, never a figure from pay. Each owner refuses anyone but an administrator; that refusal leaves as
 * not_permitted. Nothing here writes. */
import type {SessionContext} from '../../db/client';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {PayrollCycleRefused,payrollCycleOverview,payrollLoopSettingsPage,salaryLoopPage} from '../loops/payroll-cycle-views';
import {AuditViewRefused,auditLoopSummary,defaultAuditPeriod} from '../payroll-audit/status';
import {provenance,refuse,type ExplainerOutcome} from './outcome';

const PERIOD=/^\d{4}-(0[1-9]|1[0-2])$/;
const periodOf=(value:unknown)=>typeof value==='string'&&PERIOD.test(value)?value:undefined;
const percent=(bp:number)=>bp/100;
const NOT_RULE='Not applicable: the loops\' states, checks, counts and settings, not a versioned rule.';
const refused=(error:unknown,message:string)=>{
 if(error instanceof PayrollCycleRefused||error instanceof AuditViewRefused)return refuse('not_permitted',message);
 throw error;
};

export async function payrollCycleStatus(ctx:SessionContext,input:Readonly<Record<string,unknown>>):Promise<ExplainerOutcome>{
 try{
  const view=await payrollCycleOverview(ctx,{period:periodOf(input.period)});
  const audit=new Map((view.audit?.companies??[]).map(row=>[row.companyId,row]));
  return{ok:true,period:view.period,statutoryDue:view.statutoryDue,preSalaryOn:view.loops.preSalary.on,salaryOn:view.loops.salary.on,stopped:view.loops.preSalary.stopped,
   companies:view.companies.map(c=>{const a=audit.get(c.companyId);return{company:c.companyName,payDay:c.payDay,
    preSalary:{state:c.preSalary.state,cutOff:c.preSalary.cutOff,daysToCutOff:c.preSalary.daysToCutOff,interval:c.preSalary.interval,
     checks:c.preSalary.checks.map(k=>({check:k.key,status:k.status,open:k.open,waiting:k.waiting,warnings:k.warnings}))},
    salary:{state:c.salary.state,runs:c.salary.runs.map(r=>({runType:r.runType,runSeq:r.runSeq,status:r.status,exceptions:r.exceptions,flagged:r.flagged,bank:r.bank,done:r.done}))},
    audit:{state:a?(a.paused?'paused':a.done?'done':'open'):'not_shown',openFindings:a?a.findings.open:0}};}),
   history:view.history.map(h=>({period:h.period,inputsReadyDays:typeof h.inputsReady==='number'?h.inputsReady:null,inputsMissed:h.inputsReady==='missed',
    issuesCaught:h.issuesCaught,closedOn:h.closedOn,correctionsAfter:h.correctionsAfter})),
   provenance:provenance('core/loops/payroll-cycle-views.ts#payrollCycleOverview',NOT_RULE,'/control-tower/loops/payroll-cycle',
    'States and counts only, read under the administrator\'s own access: never who an item is about or a figure from pay. A person runs, approves and closes payroll and files with EPF, PERKESO and LHDN.')};
 }catch(error){return refused(error,'The payroll cycle is available to administrators only.');}
}

export async function salaryPayrollChecks(ctx:SessionContext,input:Readonly<Record<string,unknown>>):Promise<ExplainerOutcome>{
 try{
  const view=await salaryLoopPage(ctx,{period:periodOf(input.period)});
  return{ok:true,period:view.period,on:view.loop.on,stopped:view.loop.stopped,
   companies:view.companies.map(c=>{const flags=view.flags.filter(flag=>flag.companyId===c.companyId);return{company:c.companyName,cutOff:c.cutOff,thresholdPercent:percent(c.thresholdBp),
    runs:c.runs.map(r=>({runType:r.runType,runSeq:r.runSeq,status:r.status,employees:r.employees,exceptions:r.exceptions,changed:r.changed,flagged:r.flagged,
     causes:r.causes.map(x=>({cause:x.kind,count:x.count})),ruleVersion:r.ruleVersion,rulesNewer:r.rulesNewer.map(body=>({body})),bank:r.bank,closed:r.status==='closed',reopened:r.reopened})),
    flags:{open:flags.filter(flag=>!flag.disposition).length,expected:flags.filter(flag=>flag.disposition?.value==='expected').length,
     problem:flags.filter(flag=>flag.disposition?.value==='problem').length}};}),
   provenance:provenance('core/loops/payroll-cycle-views.ts#salaryLoopPage',NOT_RULE,'/control-tower/loops/payroll-cycle/salary',
    'Counts and checks only: never who was flagged or by how much, never an amount. Pay is calculated only by the payroll service; a person approves and closes each run.')};
 }catch(error){return refused(error,'The Salary payroll loop\'s checks are available to administrators only.');}
}

export async function payrollLoopSettings(ctx:SessionContext):Promise<ExplainerOutcome>{
 try{
  const view=await payrollLoopSettingsPage(ctx);
  const pattern=(key:string)=>key.startsWith('item:')?(view.patternNames[key]??'unknown pay item'):key;
  return{ok:true,
   companies:view.companies.map(c=>({company:c.companyName,version:c.setting.version,source:c.setting.source,interval:c.setting.interval,thresholdPercent:percent(c.setting.thresholdBp),
    exclusions:c.setting.exclusions.map(key=>({exclusion:pattern(key)})),
    proposals:c.proposals.map(p=>({kind:p.kind,fromPercent:percent(p.fromThresholdBp),toPercent:p.toThresholdBp===null?null:percent(p.toThresholdBp),
     exclusion:p.pattern?pattern(p.pattern):null,windowDays:p.evidence.windowDays,flags:p.evidence.flags,expected:p.evidence.expected,problems:p.evidence.problems}))})),
   provenance:provenance('core/loops/payroll-cycle-views.ts#payrollLoopSettingsPage',NOT_RULE,'/control-tower/loops/payroll-cycle/settings',
    'Settings and counts only: never who changed a setting or decided a proposal. A proposal changes nothing until an administrator approves it on the settings page.')};
 }catch(error){return refused(error,'The payroll cycle settings are available to administrators only.');}
}

export async function payrollAuditStatus(ctx:SessionContext,input:Readonly<Record<string,unknown>>):Promise<ExplainerOutcome>{
 try{
  const summary=await auditLoopSummary(ctx,{payPeriod:periodOf(input.period)??defaultAuditPeriod(todayInKualaLumpur())});
  return{ok:true,period:summary.payPeriod,dueDate:summary.dueDate,on:summary.loop.on,
   companies:summary.companies.map(c=>({company:c.companyName,paused:c.paused,done:c.done,runs:c.runs.length,
    payslips:{total:c.payslips.total,released:c.payslips.released,opened:c.payslips.opened},
    statutory:c.statutory.map(form=>({form:form.form,prepared:form.prepared,preparedOn:form.preparedOn,beforeDue:form.beforeDue,filed:form.filed,filedOn:form.filedOn})),
    bankFiles:c.bank.files,corrections:{count:c.corrections.count,withoutRootCause:c.corrections.withoutRootCause},
    findings:{open:c.findings.open,disposed:c.findings.disposed},repeatIssues:c.repeatIssues.map(control=>({control})),captures:c.captures.count})),
   provenance:provenance('core/payroll-audit/status.ts#auditLoopSummary',NOT_RULE,'/control-tower/loops/loop_payroll_audit',
    'Counts, states and dates only, read under the administrator\'s own access: never a person or a figure from pay. A person files with EPF, PERKESO and LHDN and records each disposition on the Audit loop page.')};
 }catch(error){return refused(error,'The Audit loop is available to administrators only.');}
}
