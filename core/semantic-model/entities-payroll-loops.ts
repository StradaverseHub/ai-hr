/** AI v2 Phase 2 (wave 1 integration) — the payroll-cycle loop pages, declared in the semantic model so an administrator
 * can ask about them in chat (the definition of done for each linkable page: its semantic entry; the pattern of
 * ./entities-loops.ts for the Loops page).
 *
 * Four reads for administrators only (the pages' own requireAdmin), each over its page's own read owner, run as the
 * caller under the row-level security of migrations 0960 and 0963 to 0965:
 *  - payroll_cycle_status (AI Centre › Operations › Loops › Payroll cycle): per company, the Pre-salary loop's state and
 *    checks, the Salary payroll loop's state and runs, and the Audit loop's state; the last three cycles compared;
 *  - salary_payroll_checks (its Salary payroll page): per company, each run's checks, and how many net-swing flags are
 *    open or were found expected or a real problem;
 *  - payroll_loop_settings (its settings page): per company, the check interval, the net-swing threshold, the pay items
 *    and causes excluded from it, and the threshold proposals with their evidence (counts);
 *  - payroll_audit_status (the Audit loop's page): per company, payslips released and opened, each statutory file
 *    prepared and filed, bank files, corrections after the run, control findings and repeat issues.
 * Counts, states, dates and configuration names only: never a person (no employee, no sponsor, no administrator who
 * decided), never an id, never a figure from pay (no amount, no total, no per-person swing). Item counts are `bands`
 * (ADR-0170 §2 principle 4); company and pay item names are configuration the caller administers, `minimum`. The loops
 * stay at Prepare: nothing here runs, approves, closes, files or changes anything. Pure declarations; nothing here
 * reads or grants. */
import {provenanceField} from './entities-explain';
import {AUDIT_CONTROL_IDS,AUDIT_STATUTORY_FORMS} from '../payroll-audit/types';
import type {DisclosureClass,FieldType,SemanticEntity,SemanticField,SemanticRead} from './types';

const f=(name:string,type:FieldType,disclosure:DisclosureClass,meaning:string,extra:Partial<Pick<SemanticField,'values'|'of'>>={}):SemanticField=>({name,type,disclosure,meaning,...extra});
const freeze=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};

/** The owners' closed vocabularies, repeated here so this file imports no service (test/payroll-loop-reads.test.ts pins
 * them to core/loops/pre-salary-checks.ts, payroll-loop-settings.ts, payroll-cycle-views.ts and core/pay-difference.ts). */
export const PRE_SALARY_CHECK_KEYS=['timesheets','overtime','leave','claims','joinersLeavers','statutoryBank','payChanges','setup','repeatAudit'] as const;
export const CHECK_INTERVAL_VALUES=['hourly','twice_daily','daily'] as const;
export const PAY_CAUSES=['unpaid_leave','absence','overtime_hours','salary_change','days_paid','additional_run','statutory_rules','set_by_hand'] as const;
export const PRE_SALARY_STATES=['off','paused','not_checked','open','done','missed'] as const;
export const SALARY_STATES=['off','paused','before_cut_off','not_checked','ready_to_start','in_progress','attention','done'] as const;
export const PRE_SALARY_CHECK_STATUSES=['done','waiting','open','warning','off'] as const;
export const SALARY_RUN_STATUSES=['draft','processed','closed'] as const;
export const SALARY_BANK_CHECKS=['match','total_mismatch','count_mismatch','not_available','blocked','not_ready'] as const;
export const AUDIT_COMPANY_STATES=['done','open','paused','not_shown'] as const;
export const SETTING_SOURCES=['default','admin','proposal'] as const;

const company=f('company','label','minimum','The company\'s name.');
const period=(meaning:string)=>f('period','period','full',meaning);
const runType=f('runType','label','full','The run\'s type: regular (the salary run), bonus, off_cycle or another additional run.');
const runSeq=f('runSeq','integer','full','The run\'s number in the month, from 1.');
const runStatus=f('status','enum','full','draft (not processed yet), processed (calculated, not closed) or closed (approved and closed by a person).',{values:SALARY_RUN_STATUSES});
const bank=f('bank','enum','full','The Salary payroll loop\'s check of the run\'s bank file against its net pay and headcount: match; total_mismatch or count_mismatch (they differ); blocked (the bank file cannot be produced); not_available (no bank file format to compare); not_ready (not checked yet).',{values:SALARY_BANK_CHECKS});

export const PAYROLL_LOOP_ENTITIES:readonly SemanticEntity[]=freeze([
 {id:'payroll_cycle',label:'Payroll cycle',
  meaning:'For administrators: one month\'s payroll across the companies they administer, as the three payroll-cycle loops see it. The Pre-salary loop checks every input from the start of the period to the cut-off; the Salary payroll loop checks each run from cut-off to close; the Audit loop checks what happened after pay day. All three stay at Prepare: a person runs, approves and closes payroll and files with EPF, PERKESO and LHDN.',
  module:'payroll',sensitivity:'ordinary',audience:'admin',rls:'administered_scope',
  owners:['core/loops/payroll-cycle-views.ts#payrollCycleOverview','core/payroll-audit/status.ts#auditLoopSummary'],
  ruleVersion:null,relations:[],page:'/control-tower/loops/payroll-cycle',
  fields:[period('The pay month shown.'),f('statutoryDue','date','full','When that month\'s EPF, SOCSO, EIS and PCB are due (the 15th of the next month).'),
   f('preSalaryOn','boolean','full','The Pre-salary loop is switched on for the group.'),f('salaryOn','boolean','full','The Salary payroll loop is switched on for the group.'),
   f('stopped','boolean','full','The company stop switch has stopped every AI worker, so neither loop runs.'),
   f('companies','list','full','One row per company the administrator administers, by name.',{of:[company,
    f('payDay','date','full','The company\'s pay day that month; null when it sets none.'),
    f('preSalary','object','full','The Pre-salary loop for the company.',{of:[
     f('state','enum','full','open (running, something still to do before the cut-off), done (every check done), missed (not ready by the cut-off), not_checked, paused (for this company), off (switched off).',{values:PRE_SALARY_STATES}),
     f('cutOff','date','full','The company\'s payroll cut-off for the month.'),f('daysToCutOff','integer','full','Days from today to the cut-off; negative once it has passed.'),
     f('interval','enum','full','How often the loop checks this company.',{values:CHECK_INTERVAL_VALUES}),
     f('checks','list','full','Each input check, in the order of the page.',{of:[
      f('check','enum','full','Which check: timesheets, overtime, leave (and unpaid days), claims, joinersLeavers, statutoryBank (bank, EPF, SOCSO and tax numbers), payChanges, setup (payroll set-up), repeatAudit (control checks the Audit loop found in each of the last two audited months).',{values:PRE_SALARY_CHECK_KEYS}),
      f('status','enum','full','done, open (a person must act before the cut-off), waiting (waiting for its usual approver), warning (worth a look, not blocking) or off (the company does not use that module).',{values:PRE_SALARY_CHECK_STATUSES}),
      f('open','integer','bands','Items a person must act on before the cut-off.'),f('waiting','integer','bands','Items waiting for their usual approver.'),
      f('warnings','integer','bands','Items worth a look that do not block.')]})]}),
    f('salary','object','full','The Salary payroll loop for the company.',{of:[
     f('state','enum','full','before_cut_off, ready_to_start (the cut-off has passed and no salary run has started), in_progress, attention (a run\'s bank check does not match), done (every run closed with a matching bank file), not_checked, paused or off.',{values:SALARY_STATES}),
     f('runs','list','full','Each run of the month the loop checked.',{of:[runType,runSeq,runStatus,
      f('exceptions','integer','bands','Payroll exceptions still open on the run.'),f('flagged','integer','bands','People whose net pay changed beyond the company\'s net-swing threshold.'),
      bank,f('done','boolean','full','Closed with its bank file checked.')]})]}),
    f('audit','object','full','The Audit loop for the company that month.',{of:[
     f('state','enum','full','done (paid, filed, reconciled and evidenced), open, paused, or not_shown (the administrator does not administer this company\'s payroll).',{values:AUDIT_COMPANY_STATES}),
     f('openFindings','integer','bands','Control findings still waiting for a disposition.')]})]}),
   f('history','list','full','The three months before, newest first.',{of:[period('The pay month.'),
    f('inputsReadyDays','integer','full','Days before the cut-off the inputs were ready (0: on the day); null when not measured or missed.'),
    f('inputsMissed','boolean','full','The inputs were not ready by the cut-off.'),
    f('issuesCaught','integer','bands','Issues caught before the run closed (exceptions and net-swing flags); null when not measured.'),
    f('closedOn','date','full','When the last regular run was closed; null when not closed.'),f('correctionsAfter','integer','bands','Runs reopened after closing.')]}),
   provenanceField]},
 {id:'salary_payroll_run',label:'Salary payroll loop runs',
  meaning:'For payroll administrators: one month\'s payroll runs as the Salary payroll loop checked them, per company: exceptions, people changed and flagged against the net-swing threshold with the causes, the statutory rule versions, whether the bank file matches net pay, and who-free counts of the net-swing flags. The loop stays at Prepare: a person runs, approves and closes payroll.',
  module:'payroll',sensitivity:'ordinary',audience:'admin',rls:'administered_scope',
  owners:['core/loops/payroll-cycle-views.ts#salaryLoopPage'],
  ruleVersion:null,relations:[],page:'/control-tower/loops/payroll-cycle/salary',
  fields:[period('The pay month shown.'),f('on','boolean','full','The Salary payroll loop is switched on for the group.'),f('stopped','boolean','full','The company stop switch has stopped every AI worker.'),
   f('companies','list','full','One row per company whose payroll the administrator administers.',{of:[company,
    f('cutOff','date','full','The company\'s payroll cut-off for the month.'),
    f('thresholdPercent','number','full','The company\'s net-swing threshold, in percent (a change of net pay beyond it is flagged).'),
    f('runs','list','full','Each run of the month, in order.',{of:[runType,runSeq,runStatus,
     f('employees','integer','bands','People in the run.'),f('exceptions','integer','bands','Payroll exceptions still open.'),
     f('changed','integer','bands','People whose net pay changed from last month.'),f('flagged','integer','bands','People over the net-swing threshold.'),
     f('causes','list','full','What explains the changes, by cause.',{of:[f('cause','enum','full','The cause.',{values:PAY_CAUSES}),f('count','integer','bands','People it explains.')]}),
     f('ruleVersion','label','full','The statutory rule version the run was calculated on; null when unknown.'),
     f('rulesNewer','list','full','Statutory bodies with a newer rule version than the run used.',{of:[f('body','label','full','EPF, SOCSO, EIS or PCB.')]}),
     bank,f('closed','boolean','full','A person approved and closed it.'),f('reopened','integer','full','Times it was reopened after closing.')]}),
    f('flags','object','full','The month\'s net-swing flags for the company, counted; never who or by how much.',{of:[
     f('open','integer','bands','Flags waiting for payroll HR\'s disposition.'),f('expected','integer','bands','Flags payroll HR found expected.'),
     f('problem','integer','bands','Flags payroll HR found a real problem.')]})]}),
   provenanceField]},
 {id:'payroll_loop_setting',label:'Payroll cycle settings',
  meaning:'For administrators: per company, how often the Pre-salary loop checks, the Salary payroll loop\'s net-swing threshold and what is excluded from it, the setting\'s version and where it came from, and the threshold proposals waiting for a decision with the evidence they rest on (counts only). A proposal changes nothing until an administrator approves it.',
  module:'payroll',sensitivity:'ordinary',audience:'admin',rls:'administered_scope',
  owners:['core/loops/payroll-cycle-views.ts#payrollLoopSettingsPage'],
  ruleVersion:null,relations:[],page:'/control-tower/loops/payroll-cycle/settings',
  fields:[f('companies','list','full','One row per company the administrator administers.',{of:[company,
    f('version','integer','full','The setting\'s version (0: the defaults, never changed).'),
    f('source','enum','full','default, admin (set by an administrator) or proposal (an approved proposal).',{values:SETTING_SOURCES}),
    f('interval','enum','full','How often the Pre-salary loop checks the company.',{values:CHECK_INTERVAL_VALUES}),
    f('thresholdPercent','number','full','The net-swing threshold, in percent.'),
    f('exclusions','list','full','Pay patterns excluded from the net-swing check.',{of:[f('exclusion','label','minimum','A pay item\'s name, or a cause key (cause:<kind>), or "unknown pay item" when the item is no longer in the catalogue.')]}),
    f('proposals','list','full','Threshold proposals waiting for an administrator\'s decision.',{of:[
     f('kind','enum','full','threshold (raise the threshold) or exclusion (exclude a pay pattern).',{values:['threshold','exclusion']}),
     f('fromPercent','number','full','The threshold now, in percent.'),f('toPercent','number','full','The proposed threshold, in percent; null for an exclusion.'),
     f('exclusion','label','minimum','The pay pattern an exclusion proposal names, as for exclusions; null for a threshold proposal.'),
     f('windowDays','integer','full','The days the evidence covers.'),f('flags','integer','bands','Flags in that window.'),
     f('expected','integer','bands','Of them, found expected.'),f('problems','integer','bands','Of them, found a real problem.')]})]}),
   provenanceField]},
 {id:'payroll_audit_status',label:'Audit loop',
  meaning:'For payroll administrators: what the Audit loop found for one pay month, per company: payslips released and opened, each statutory file (EPF, SOCSO and EIS, PCB CP39, HRD Corp) prepared and filed with a receipt, bank files recorded, corrections after the run and how many lack a root cause, control findings open and disposed, the checks that found something two months running, and how much evidence it captured. The loop stays at Prepare: a person files with EPF, PERKESO and LHDN and records each disposition.',
  module:'payroll',sensitivity:'ordinary',audience:'admin',rls:'administered_scope',
  owners:['core/payroll-audit/status.ts#auditLoopSummary'],
  ruleVersion:null,relations:[],page:'/control-tower/loops/loop_payroll_audit',
  fields:[period('The pay month audited.'),f('dueDate','date','full','When its statutory files are due.'),f('on','boolean','full','The Audit loop is switched on for the group.'),
   f('companies','list','full','One row per company whose payroll the administrator administers.',{of:[company,
    f('paused','boolean','full','The Audit loop is paused for this company.'),
    f('done','boolean','full','Every run closed and released, every statutory file filed with a receipt, no finding open and every correction with a root cause.'),
    f('runs','integer','full','Payroll runs that month.'),
    f('payslips','object','full','Payslips that month.',{of:[f('total','integer','bands','Payslips.'),f('released','integer','bands','Released to employees.'),f('opened','integer','bands','People who opened theirs.')]}),
    f('statutory','list','full','Each statutory file.',{of:[f('form','enum','full','epf, socso_eis, pcb_cp39 or hrd.',{values:AUDIT_STATUTORY_FORMS}),
     f('prepared','boolean','full','Prepared or exported.'),f('preparedOn','date','full','When it was first prepared; null when not yet.'),
     f('beforeDue','boolean','full','Prepared on or before its due date; null when not prepared.'),f('filed','boolean','full','Filed, with a receipt recorded by a person.'),
     f('filedOn','date','full','When it was filed; null when not yet.')]}),
    f('bankFiles','integer','full','Bank files recorded for the month.'),
    f('corrections','object','full','Corrections after the run (target zero).',{of:[f('count','integer','bands','Corrections.'),f('withoutRootCause','integer','bands','Still without a root cause.')]}),
    f('findings','object','full','Control findings.',{of:[f('open','integer','bands','Waiting for a disposition.'),f('disposed','integer','bands','Disposed.')]}),
    f('repeatIssues','list','full','Checks that found something this month and last month too (the next Pre-salary loop reads them).',{of:[f('control','enum','full','The control check.',{values:AUDIT_CONTROL_IDS})]}),
    f('captures','integer','full','Evidence captures that month.')]}),
   provenanceField]},
] satisfies SemanticEntity[]);

const periodInput={name:'period',identifier:false,optional:true as const,schema:{type:'string',pattern:'^\\d{4}-(0[1-9]|1[0-2])$',description:'A pay month, YYYY-MM. Omit for the month the page shows by default.'}};
export const PAYROLL_LOOP_READS:readonly SemanticRead[]=freeze([
 {name:'payroll_cycle_status',entity:'payroll_cycle',
  purpose:'Administrators only: one month\'s payroll cycle across the companies they administer, as the Payroll cycle page shows it. For each company, the Pre-salary loop\'s state and each input check with what is open or waiting before the cut-off, the Salary payroll loop\'s state and its runs (exceptions, people over the net-swing threshold, whether the bank file matches net pay), and the Audit loop\'s state; and the three months before compared. Counts and states only, never a person or a pay figure. Use it for "is payroll on track this month", "what is blocking the cut-off" and "did last month close on time" questions.',
  input:[periodInput]},
 {name:'salary_payroll_checks',entity:'salary_payroll_run',
  purpose:'Payroll administrators only: the Salary payroll loop\'s checks of one month\'s payroll runs, per company, as its page shows them: exceptions open, people changed and flagged against the net-swing threshold with the causes, the statutory rule versions, whether each bank file matches net pay, and how many net-swing flags are open, expected or a real problem. Never who was flagged or by how much. Use it for "did the bank file match", "how many people were flagged" and "is any run still open" questions.',
  input:[periodInput]},
 {name:'payroll_loop_settings',entity:'payroll_loop_setting',
  purpose:'Administrators only: the payroll-cycle loop settings per company, as the settings page shows them: how often the Pre-salary loop checks, the net-swing threshold and what is excluded from it, the version and its source, and the threshold proposals waiting for a decision with their evidence. Never who changed or decided. Use it for "what is our net-swing threshold", "how often are payroll inputs checked" and "is a threshold proposal waiting" questions.',
  input:[]},
 {name:'payroll_audit_status',entity:'payroll_audit_status',
  purpose:'Payroll administrators only: what the Audit loop found for one pay month, per company, as its page shows it: payslips released and opened, each statutory file prepared and filed with a receipt, bank files, corrections after the run, control findings open and disposed, and repeat issues. Never a person or a pay figure. Use it for "are the statutory files filed", "what did the Audit loop find" and "are there corrections after the run" questions.',
  input:[periodInput]},
] satisfies SemanticRead[]);
