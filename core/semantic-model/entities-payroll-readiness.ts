/** AI v2 Phase 2, P2-3 — "what do I need to do before payroll?", declared in the semantic model.
 *
 * One own-scope read, my_payroll_readiness, over core/pre-salary/person-items.ts readMyPayrollReadiness: the asking
 * person's own pending items for this month's pay (attendance, overtime, leave, claims, time off in lieu, personal and
 * statutory details, things to acknowledge), each with its due date, and, for an approver, how many decisions of each
 * kind wait on them before the cut-off. The cut-off date is the payroll owner's.
 *
 * NO PAY FIGURE IS DECLARED, because none is returned: the service copies no amount, rate, balance, limit, salary,
 * minutes or days. The only counts are how many decisions of one kind wait on the caller. Leave and claim type names
 * are the caller's own and are screened for health, religion and similar labels. Other people never appear by name:
 * approvals leave as counts. Record handles and links with ids stay in the product (each item says only which page
 * acts on it). Pure declarations. */
import {provenanceField} from './entities-explain';
import type {DisclosureClass,FieldType,SemanticEntity,SemanticField,SemanticRead} from './types';
import {ALL_PAYROLL_ITEM_KINDS,PAYROLL_ITEM_GROUPS,PAYROLL_ITEM_KINDS,PAYROLL_ITEM_STATES} from '../../lib/pre-salary/items';

const f=(name:string,type:FieldType,disclosure:DisclosureClass,meaning:string,extra:Partial<Pick<SemanticField,'values'|'of'|'screen'>>={}):SemanticField=>({name,type,disclosure,meaning,...extra});
const freeze=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};

export const PAYROLL_READINESS_ENTITIES:readonly SemanticEntity[]=freeze([
 {id:'payroll_readiness',label:'Before payroll checklist',
  meaning:'What the caller still needs to do before this month\'s payroll cut-off, from their own records: each pending item with when it is due, and how many approvals wait on them.',
  module:null,sensitivity:'ordinary',audience:'self',rls:'own_person',
  owners:['core/pre-salary/person-items.ts#readMyPayrollReadiness','core/pre-salary/person-items.ts#resolvePayrollPeriod'],
  ruleVersion:null,relations:[],page:'/',
  fields:[
   f('period','object','minimum','The pay period this checklist is for and its cut-off.',{of:[
    f('payPeriod','period','full','The pay month.'),f('start','date','minimum','The first day whose attendance and leave count towards it.'),
    f('cutOff','date','minimum','The payroll cut-off date the payroll service set for the caller\'s company; null when the caller\'s role cannot read their company\'s payroll settings, so no date may be given.'),
    f('source','enum','full','company: the company\'s own cut-off day; month_end: the company sets none, so the end of the month; unavailable: not known to this person, never guess one.',{values:['company','month_end','unavailable']})]}),
   f('items','list','minimum','The caller\'s own pending items, the most urgent first.',{of:[
    f('group','enum','full','Which part of pay it feeds.',{values:PAYROLL_ITEM_GROUPS.filter(group=>group!=='approvals')}),
    f('kind','enum','full','What is pending. missed_clock_in, missed_clock_out: a punch is missing; absent_no_leave: a working day with no punches and no leave; late_or_early: a late arrival or early finish (check it, give a reason if needed); attendance_request_pending: a correction sent, waiting for approval; overtime_pending: an overtime request waiting for approval; overtime_over_cap: overtime this month is over the monthly limit; leave_pending: leave waiting for approval; leave_unpaid: unpaid leave this month; leave_certificate_missing: a leave request needs its supporting document (for example a medical certificate); claim_deadline: a draft claim must be submitted soon or its receipt becomes too old; claim_receipt_missing: a draft claim needs its receipt; claim_draft: a draft claim not yet submitted; claim_pending: a claim waiting for approval; toil_pending: a replacement leave request waiting for approval; bank_missing, tax_number_missing, epf_number_missing, socso_number_missing, identity_missing: a detail payroll needs is missing (sent to HR from the person\'s profile); details_request_pending: a details change sent to HR, waiting for review; tp3_new_joiner: a new joiner this year can tell payroll about an earlier employer this year (TP3); letter_acknowledge, notice_acknowledge: something to acknowledge.',
     {values:ALL_PAYROLL_ITEM_KINDS.filter(kind=>!(PAYROLL_ITEM_KINDS.approvals as readonly string[]).includes(kind))}),
    f('state','enum','full','todo: the person needs to act; waiting: sent, someone else decides; check: worth a look, may need nothing.',{values:PAYROLL_ITEM_STATES}),
    f('date','date','minimum','The day it is about, when it has one.'),f('endDate','date','minimum','The last day, for leave.'),
    f('due','date','minimum','When it must be done by: its own deadline when sooner, otherwise the cut-off; null when unknown.'),
    f('label','label','minimum','The person\'s own leave or claim type name.',{screen:'sensitive_label'}),
    f('page','label','full','The product page where the person acts on it.'),
    f('confirmCard','boolean','full','A card with one Confirm is waiting for the person on Today for this item.')]}),
   f('approvals','list','minimum','Decisions waiting on the caller as an approver before the cut-off, counted by kind; never whose.',{of:[
    f('kind','enum','full','approve_leave, approve_leave_cancellation, approve_attendance (attendance corrections and overtime), approve_claim, approve_toil (replacement leave).',{values:PAYROLL_ITEM_KINDS.approvals}),
    f('count','integer','minimum','How many decisions of this kind wait on the caller.'),f('due','date','minimum','The caller\'s own payroll cut-off; null when unknown.'),
    f('page','label','full','Where the caller decides them.')]}),
   f('groups','list','full','Each part of the checklist this month: done, todo, waiting (only others decide), unknown (could not be checked) or off (not used).',{of:[
    f('group','enum','full','The part.',{values:PAYROLL_ITEM_GROUPS}),f('status','enum','full','Its status.',{values:['done','todo','waiting','unknown','off']})]}),
   f('notCovered','list','full','What this checklist cannot check because no record of it exists in the product.'),
   provenanceField]},
] satisfies SemanticEntity[]);

export const PAYROLL_READINESS_READS:readonly SemanticRead[]=freeze([
 {name:'my_payroll_readiness',entity:'payroll_readiness',
  purpose:'What the asking person still needs to do before this month\'s payroll cut-off, from their own attendance, overtime, leave, claims, replacement leave, personal and statutory details and things to acknowledge, each with when it is due and the page where they act; and, for an approver, how many decisions wait on them. The cut-off date comes from the payroll service; never guess one. Use it for "what do I need to do before payroll", "is anything missing for my salary" and "what is pending from me" questions. It has no pay figures.',
  input:[]},
] satisfies SemanticRead[]);
