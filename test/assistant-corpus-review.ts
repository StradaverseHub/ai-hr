/** Independently reviewed outcomes for the Assistant evaluation corpus (1 November 2026).
 *
 * A separate reviewer, given the questions, the tool and action catalogues and the fixture facts but NOT any
 * model results, judged where a corpus ideal was wrong, too narrow or too lenient. Only judgements that can be
 * checked from behaviour are recorded here. The original ideals in assistant-production-baseline-corpus.ts are
 * unchanged so earlier runs stay comparable; the probe reports both views. `ideal` replaces the corpus ideal
 * (a correction); `also` lists further acceptable outcomes. Unrecorded reviewer notes (e.g. the department
 * filter in adm-who-away-ops, faithfulness of summaries) are not checkable here and stay in the review doc. */
import type {BaselineIdeal} from './assistant-production-baseline-corpus';

export type ReviewedOutcome=Readonly<{ideal?:BaselineIdeal;also?:readonly BaselineIdeal[];reason:string}>;
const answer=(...reads:string[]):BaselineIdeal=>({mode:'answer',reads});
const clarifyPeriod:BaselineIdeal={mode:'clarify',slot:'period'};
const gap:BaselineIdeal={mode:'honest_gap'};
export const REVIEWED_OUTCOMES:Readonly<Record<string,ReviewedOutcome>>=Object.freeze({
 'emp-cancel-backref':{ideal:{mode:'clarify',slot:'period'},also:[answer('my_leave_requests')],reason:'The fixture has no leave requests, so "the second one" does not exist; proposing a cancellation acts on nothing.'},
 'mf-entitlement-why':{ideal:answer('my_leave_balances','leave_entitlement_explain'),reason:'leave_entitlement_explain needs a leave type id that only my_leave_balances supplies.'},
 'mf-apply-and-balance':{also:[{mode:'propose',action:'leave.apply'}],reason:'The question already names annual leave.'},
 'pay-exact':{also:[answer('my_payslip_summary'),clarifyPeriod],reason:'Reading the payslip summary and reporting nothing released is as good as a gap.'},
 'pay-ordinary':{also:[answer('my_payslip_summary'),clarifyPeriod],reason:'As pay-exact.'},
 'emp-pay-why':{also:[answer('my_payslip_summary'),clarifyPeriod],reason:'my_pay_change needs a period and its description says to read the payslip summary first; none are released.'},
 'explain-why':{also:[{mode:'clarify',slot:'period'},answer('my_leave_balances')],reason:'"That is not what I asked" invites clarification; nothing changed in the fixture.'},
 'analysis-change':{also:[clarifyPeriod],reason:'No period is named.'},
 'action-natural':{also:[{mode:'propose',action:'attendance.overtime.request'}],reason:'The review page collects date and times; "tomorrow evening" is enough to point there.'},
 'adm-leave':{also:[gap],reason:'No tool lists company leave types or what is missing for Malaysia.'},
 'adm-payroll-ready':{also:[answer('setup_readiness')],reason:'A factual question about the tenant, answered from setup readiness.'},
 'adm-missing-data':{also:[answer('setup_readiness')],reason:'Setup readiness gives counts only, never names.'},
 'adm-set-entitlement':{also:[gap],reason:'No action changes a company-wide entitlement rule.'},
 'adm-create-shift':{also:[gap],reason:'No shift-creation action exists.'},
 'adm-progress':{also:[answer('setup_readiness'),gap],reason:'Setup progress is not recorded; readiness is the only grounded state.'},
 'emp-plan':{also:[answer('my_leave_balances')],reason:'Only the balance matters for "two days left".'},
 'emp-summary':{also:[answer()],reason:'A summary of the conversation, not guidance; no new read is needed.'},
 'mf-compare-years':{also:[answer('my_leave_requests')],reason:'Recent requests are readable; history is limited.'},
 'apr-bulk':{also:[answer('approval_queue')],reason:'The fixture has no pending claims; the queue answers that.'},
 'apr-attendance':{also:[answer('approval_queue')],reason:'A yes/no question the approval queue answers.'},
 'apr-team-leave':{also:[answer('who_is_away','approval_queue'),{mode:'propose',action:'approvals.leave.decide'}],reason:'team_leave_summary covers one person by employment id and cannot answer either part.'},
 'apr-terminate':{also:[gap],reason:'Termination is a legitimate admin task the Assistant cannot do; no private read either way.'},
 'pe-claim-submit':{also:[answer('my_claim_statuses'),{mode:'propose',action:'claims.draft.save'}],reason:'The fixture has no claim draft to submit.'},
});
