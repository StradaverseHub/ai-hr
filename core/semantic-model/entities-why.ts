/** AI v2 W5 — "Why?" on every figure: the pay difference and claim limit explainers, declared in the semantic model.
 *
 * Two own-scope capabilities over their native owners, never a second derivation:
 *  - explain_pay_difference: core/pay-difference.ts comparePayPeriods over the caller's own RELEASED payslips (each
 *    line as the payslip prints it, the payroll service's own subtraction, and only the causes the runs recorded);
 *  - explain_claim_limit: core/claims.ts employeeClaimTypesTx, the claim form's and submit check's own limits and use,
 *    projected by core/claim-limit-explain.ts claimLimitExplanation.
 * (The leave balance "Why?" uses the existing explain_leave_entitlement, ./entities-explain.ts.)
 *
 * EVERY FIGURE IS A BAND, the person's own included (ADR-0170 §2 principle 4, as ./entities-explain.ts sets out for
 * the statutory explainer): money, day and hour counts, wage bases and even run counts leave as placeholders the
 * harness restores for the person, so the model can word the answer but has no figure to do arithmetic on. Pay item
 * and claim type names are screened for health, religion and similar labels. Pure declarations. */
import {provenanceField} from './entities-explain';
import type {DisclosureClass,FieldType,SemanticEntity,SemanticField,SemanticRead} from './types';
import {PAY_CAUSE_KINDS,PAY_LINE_KEYS} from '../pay-difference';
import {STATUTORY_ITEMS} from './entities-explain';

const f=(name:string,type:FieldType,disclosure:DisclosureClass,meaning:string,extra:Partial<Pick<SemanticField,'values'|'of'|'screen'>>={}):SemanticField=>({name,type,disclosure,meaning,...extra});
const freeze=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
const moved=(what:string):SemanticField[]=>[f('current','number','bands',what+' this month.'),f('previous','number','bands',what+' in the month compared against.'),
 f('change','number','bands','The difference, this month less the month compared against, as the payroll service calculated it.')];
const pot=(name:string,meaning:string,extra:readonly SemanticField[]=[]):SemanticField=>f(name,'object','minimum',meaning,{of:[f('limit','number','bands','The limit.'),
 f('used','number','bands','What is held against it: pending, approved and paid claims.'),f('remaining','number','bands','What the claims service says is left; null when not tracked.'),...extra]});

export const WHY_ENTITIES:readonly SemanticEntity[]=freeze([
 {id:'pay_difference_explanation',label:'Pay difference explanation',meaning:'Why the caller\'s own pay changed between two of their own released months, line by line, with the causes the payroll runs recorded.',
  module:'payroll',sensitivity:'pay',audience:'self',rls:'own_person',
  owners:['core/read.ts#myEmploymentIdsAll','core/read.ts#myPayslips','core/pay-difference.ts#comparePayPeriods','core/statutory-explain.ts#explainStatutory'],
  // Each run stamps the statutory ruleset version it used; payslipProvenance is the kernel's one reader of it.
  ruleVersion:'core/payslip-recompute.ts#payslipProvenance',relations:[{to:'payslip',kind:'many_to_one',via:'payPeriod'}],page:'/me/payslip',
  fields:[f('period','period','full','The month explained.'),f('previousPeriod','period','full','The released month it is compared against.'),
   f('availablePeriods','list','full','Released months the caller can ask about, newest first.'),
   f('comparisons','list','minimum','One comparison per company that paid the caller in both months.',{of:[f('company','label','minimum','Company that paid it.'),
    f('period','period','full','The month explained.'),f('previousPeriod','period','full','The month compared against.'),
    f('payslips','object','bands','How many payslips each month holds (a month can have a regular and an additional run).',{of:[f('current','integer','bands','Payslips this month.'),f('previous','integer','bands','Payslips in the month compared against.')]}),
    f('totals','object','bands','Gross pay, total deductions and net pay: this month, the month compared against and the difference.'),
    f('lines','list','minimum','Each payslip line that changed.',{of:[f('key','enum','full','Which payslip line.',{values:PAY_LINE_KEYS}),
     f('group','enum','full','Earnings or deductions.',{values:['earnings','deductions','totals']}),...moved('The line')]}),
    f('payItems','list','minimum','Named pay items behind the earnings that changed.',{of:[f('name','label','minimum','The pay item\'s name as the payslip prints it.',{screen:'sensitive_label'}),...moved('The item')]}),
    f('statutory','list','minimum','For each statutory deduction that changed, the rule that produced it and the wage it was charged on.',{of:[
     f('key','enum','full','Which contribution or tax.',{values:STATUTORY_ITEMS}),
     f('ruleKind','enum','full','What produced the amount: a percentage, a contribution schedule band, the MTD calculation, or a person (manual).',{values:['rate','schedule','mtd','manual']}),
     f('setBy','enum','full','Who decided the figure: the run\'s rule, a payroll statutory adjustment, or the employee\'s manual EPF amount.',{values:['computed','statutoryAdjustment','epfManualAmount']}),
     f('baseCurrent','number','bands','The wage it was charged on this month; null when the run recorded none.'),f('basePrevious','number','bands','The wage it was charged on in the month compared against.'),
     f('baseChange','number','bands','How much that wage changed, as the payroll service calculated it.')]}),
    f('causes','list','minimum','Causes the payroll runs recorded on the payslips. Only these are known; never add another.',{of:[
     f('kind','enum','full','unpaid_leave and absence: days deducted; overtime_hours: hours paid as overtime; salary_change: the basic salary the run was priced from; days_paid: days paid in the month; additional_run: bonus or off-cycle payslips in the month; statutory_rules: the statutory ruleset version changed (see ruleVersion); set_by_hand: statutory items a person set by hand (items).',{values:PAY_CAUSE_KINDS}),
     f('current','number','bands','The recorded figure this month (days, hours, salary or payslips).'),f('previous','number','bands','The recorded figure in the month compared against.'),
     f('effectiveFrom','date','minimum','salary_change: the date the salary in force took effect.'),f('items','list','full','set_by_hand: which statutory items.')]}),
    f('ruleVersion','object','full','The statutory ruleset version each month\'s regular run stamped.',{of:[f('current','label','full','This month\'s.'),f('previous','label','full','The month compared against.')]})]}),
   f('onlyIn','object','minimum','Companies that paid the caller in only one of the two months; never netted against the other.',{of:[f('current','list','minimum','Only this month.'),f('previous','list','minimum','Only the month compared against.')]}),
   provenanceField]},
 {id:'claim_limit_explanation',label:'Claim limit explanation',meaning:'Why one of the caller\'s own claim limits is what it is: the limits of the policy in force, what is already held against them and what is left.',
  module:'claims',sensitivity:'pay',audience:'self',rls:'own_employment',
  owners:['core/read.ts#myEmployments','core/claims.ts#employeeClaimTypesTx','core/claim-limit-explain.ts#claimLimitExplanation'],
  // Claim policy rows are versioned by their own valid-from date; the resolver picks the one in force.
  ruleVersion:'core/claims.ts#getActiveClaimPolicy',relations:[{to:'claim_status',kind:'one_to_many',via:'claimType'}],page:'/claims',
  fields:[f('claimType','label','full','Claim type explained.',{screen:'sensitive_label'}),f('claimTypes','list','full','The caller\'s own claim type names, when the one asked for was not found.'),
   f('asOf','date','full','The day the figures were read.'),
   f('employments','list','minimum','One explanation per own employment that can claim this type.',{of:[f('company','label','minimum','Company of the employment.'),
    f('claimType','label','full','Claim type.',{screen:'sensitive_label'}),f('unlimited','boolean','full','No limit of any kind applies to the caller for this type.'),
    pot('annual','The limit for the calendar year.',[f('pending','number','bands','Of what is used, the claims still waiting for approval.')]),
    pot('monthly','The limit for the calendar month.'),f('perClaimCap','number','bands','The most one claim may be.'),
    f('lifetime','object','minimum','A limit over the whole employment.',{of:[f('limit','number','bands','The limit.'),f('used','number','bands','Used so far.')]}),
    pot('block','A limit over a fixed block of months or years.',[f('endsOn','date','minimum','The last day of the block that contains today.')]),
    f('claimsPerYear','object','minimum','How many claims may be made in a calendar year.',{of:[f('max','integer','bands','Claims allowed.'),f('used','integer','bands','Claims made.')]}),
    f('items','list','minimum','Sub-claim limits, each a separate pot beside the type\'s own.',{of:[f('name','label','minimum','Sub-claim name.',{screen:'sensitive_label'}),
     pot('annual','The sub-claim\'s yearly limit.'),pot('monthly','The sub-claim\'s monthly limit.'),f('perClaimCap','number','bands','The most one sub-claim may be.')]}),
    f('policy','object','full','The policy version these limits come from.',{of:[f('validFrom','date','full','The day the policy in force took effect.'),
     f('gradeScoped','boolean','full','Whether it is the caller\'s job grade policy rather than the all-grades default.')]})]}),
   provenanceField]},
] satisfies SemanticEntity[]);

const month=(description:string)=>({type:'string',pattern:'^\\d{4}-\\d{2}$',description});
export const WHY_READS:readonly SemanticRead[]=freeze([
 {name:'explain_pay_difference',entity:'pay_difference_explanation',
  purpose:'Why the asking person\'s own pay is different between two of their own released months: which payslip lines changed and by how much, already calculated by the payroll service, and the causes the payroll runs recorded (unpaid leave, absence, overtime hours, a salary change, days paid, an additional run, the statutory rules, or a figure set by hand). Use it for "why is my pay different from last month" and "why did my take-home go down" questions. Quote its figures; never work one out.',
  input:[{name:'period',identifier:false,optional:true,schema:month('The released month to explain, as YYYY-MM. Leave it out for the latest.')},
   {name:'compare_to',identifier:false,optional:true,schema:month('The released month to compare against, as YYYY-MM. Leave it out for the released month before.')}]},
 {name:'explain_claim_limit',entity:'claim_limit_explanation',
  purpose:'Why the asking person\'s own limit for one of their claim types is what it is: the yearly, monthly, per-claim and other limits of the policy in force, how much is already used or waiting for approval, and what is left. Use it for "what is my claim limit" and "how much of my claim limit is left" questions.',
  input:[{name:'claim_type',identifier:false,schema:{type:'string',maxLength:120,description:'The claim type name as the person names it, for example Medical or Travel.'}}]},
] satisfies SemanticRead[]);
