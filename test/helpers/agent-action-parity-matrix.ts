/** ADR-0151 §7 "Parity", review R16 (WP8) — the per-entry role matrix for every Assistant agent action.
 *
 * This file DECLARES, per registry entry, what the owning screen allows each role to do to one fixture
 * subject. It is not a permission model and nothing in the product reads it. The DB harness
 * (test/agent-action-permission-parity.test.ts) runs the owning screen's own admission and service for each
 * role, and the Assistant's offer, prepare and confirm paths for the same role and subject, and requires:
 *   1. the observed screen outcome equals the value declared here (an independent expected value);
 *   2. every agent phase equals the screen outcome, except where a role is listed in `narrowed` (the agent
 *      refuses something the screen allows, with the reason). The agent may be NARROWER, never wider;
 *   3. another company and another tenant are refused by the screen and by every agent phase.
 *
 * Coverage rule (test/agent-action-permission-parity-guard.test.ts): every registry entry has a declaration
 * here, and `satisfies Record<AgentActionId,…>` makes a missing one a compile error as well. A new entry must
 * arrive with a probed declaration and a DB adapter. `pending` exists only for entries that predate this
 * harness (PARITY_PENDING_CEILING below); that list may only shrink.
 *
 * Roles (all fictional fixtures, one world per tested role):
 *   employee                  the subject employee's own login (role employee)
 *   manager                   the subject's current administrative line manager (role manager)
 *   assigned_approver         a same-level colleague the manager delegated approvals to (role employee + an
 *                             active whole-scope `delegate` line); the approval routing assigns them
 *   company_hr                hr_admin granted for the subject's company only
 *   group_hr                  hr_admin granted group-wide (company null)
 *   payroll_partner           payroll_partner for the subject's company
 *   performance_comp_partner  performance_comp_partner for the subject's company
 *   performance_partner       performance_partner (OneHR, ADR-0142) for the subject's company
 *   another_company           hr_admin of ANOTHER company of the same tenant (the strongest cross-company actor)
 *   another_tenant            group hr_admin of a different tenant
 */
import type {AgentActionId} from '../../lib/ai/agent-action-registry';

export const PARITY_ROLES=['employee','manager','assigned_approver','company_hr','group_hr','payroll_partner','performance_comp_partner','performance_partner','another_company','another_tenant'] as const;
export type ParityRole=(typeof PARITY_ROLES)[number];
export const PARITY_PHASES=['offer','prepare','confirm'] as const;
export type ParityPhase=(typeof PARITY_PHASES)[number];
export type ParityOutcome='allow'|'deny';
/** Roles that must always be refused, by the screen and by every agent phase, for every entry. */
export const ALWAYS_REFUSED:readonly ParityRole[]=['another_company','another_tenant'];

export type ParityDeclaration=
 | Readonly<{kind:'probed';screen:Readonly<Record<ParityRole,ParityOutcome>>;narrowed?:Readonly<Partial<Record<ParityRole,string>>>}>
 /** No agent prepare or confirm exists (registry store human_workflow_only): the agent can only hand off. */
 | Readonly<{kind:'human_workflow_only';reason:string}>
 /** Predates WP8; must be in PARITY_PENDING_CEILING. Never valid for a new entry. */
 | Readonly<{kind:'pending';reason:string}>;

const D='deny',A='allow';
/** Native request decisions now admit the current, same-company, matching-task stand-in through
 * the delegated-approvals package. Personnel and balances remain invisible; only request facts and
 * the request-bound native calculation/effect path are available. */
const ASSIGNED_DECISION={employee:D,manager:A,assigned_approver:A,company_hr:A,group_hr:A,payroll_partner:D,performance_comp_partner:D,performance_partner:D,another_company:D,another_tenant:D} as const;
/** The routed delegate confirm gap declared by WP8 is repaired here by own-decision event visibility. */
export const ATTENDANCE_WORKFLOW_PARITY={screen:ASSIGNED_DECISION} as const;

/** HR screen behind requireAdmin (isAdmin) whose service writes an administered employment under RLS. */
const HR_ON_EMPLOYMENT={employee:D,manager:D,assigned_approver:D,company_hr:A,group_hr:A,payroll_partner:D,performance_comp_partner:D,performance_partner:D,another_company:D,another_tenant:D} as const;

/** The subject's own pending request on their own screen: the native creator-only rule. */
const OWN_REQUEST={employee:A,manager:D,assigned_approver:D,company_hr:D,group_hr:D,payroll_partner:D,performance_comp_partner:D,performance_partner:D,another_company:D,another_tenant:D} as const;

const pending=(reason:string)=>({kind:'pending',reason}) as const;
const NO_ADAPTER='No parity adapter yet: per-entry subject fixture and screen probe still to be written (WP8 follow-up).';

export const AGENT_ACTION_PARITY={
 'approvals.claim.chase':{kind:'human_workflow_only',reason:'Automatic template-only notification; no human prepare/confirm store. Principal, scope, recipients and caps are covered by automatic-chasers.test.ts.'},
 'approvals.attendance.chase':{kind:'human_workflow_only',reason:'Automatic template-only notification; no human prepare/confirm store. Principal, scope, recipients and caps are covered by automatic-chasers.test.ts.'},
 'approvals.toil.chase':{kind:'human_workflow_only',reason:'Automatic template-only notification; no human prepare/confirm store. Principal, scope, recipients and caps are covered by automatic-chasers.test.ts.'},
 'employees.review_overdue.remind':{kind:'human_workflow_only',reason:'Automatic template-only notification; no human prepare/confirm store. Principal, scope, recipients and caps are covered by automatic-chasers.test.ts.'},
 'employees.import':{kind:'human_workflow_only',reason:'No agent prepare or confirm: the Assistant only hands off to the native import page, which keeps its own admission.'},
 'org.reporting.change':pending(NO_ADAPTER+' Dedicated store (WP9 collapses it).'),
 'leave.apply':pending(NO_ADAPTER+' Own-leave store.'),
 'leave.cancel':{kind:'probed',screen:OWN_REQUEST},
 'leave.edit':{kind:'probed',screen:OWN_REQUEST},
 'ess.profile.request':pending(NO_ADAPTER+' Module-action store.'),
 'approvals.leave.decide':pending(NO_ADAPTER+' Dedicated leave-decision store (multi-step leave approval routing).'),
 'approvals.claim.decide':{kind:'probed',screen:ASSIGNED_DECISION},
 'approvals.attendance.decide':{kind:'probed',screen:ASSIGNED_DECISION},
 'approvals.toil.decide':{kind:'probed',screen:ASSIGNED_DECISION},
 'knowledge_base.article.create':pending(NO_ADAPTER+' Dedicated store.'),
 'payroll.close':pending(NO_ADAPTER+' Dedicated store; needs a processed payroll batch fixture.'),
 'attendance.correction.request':pending(NO_ADAPTER+' Dedicated store.'),
 'attendance.overtime.request':{kind:'probed',screen:OWN_REQUEST},
 'claims.draft.save':pending(NO_ADAPTER+' Module-action store.'),
 'claims.submit':pending(NO_ADAPTER+' Module-action store.'),
 /** Observed on CI (run 40921791116): there is NO native HR screen for cancelling another person's claim —
  * /claims lists only the caller's own claims. HR "allow" exists only because cancelClaimAction accepts any
  * claim id when no employmentId is posted (app/claims/actions.ts :129-136) and cancelClaimTx then admits any
  * hr_admin/super_admin by role (core/claims.ts :2684-2695). Whether that unposted path should exist is a
  * product question. The Assistant's claims.cancel is the claimant's own action, so it is narrower. */
 'claims.cancel':{kind:'probed',screen:{...OWN_REQUEST,company_hr:A,group_hr:A},narrowed:{
  company_hr:'No native HR claim-cancel screen exists; HR is admitted only via cancelClaimAction with no employmentId posted (product question). The Assistant action is the claimant\'s own.',
  group_hr:'No native HR claim-cancel screen exists; HR is admitted only via cancelClaimAction with no employmentId posted (product question). The Assistant action is the claimant\'s own.'}},
 'performance.review.acknowledge':pending(NO_ADAPTER+' Module-action store; needs a released review fixture.'),
 'performance.onehr.plan.acknowledge':pending(NO_ADAPTER+' Module-action store; needs a OneHR plan fixture.'),
 'rewards.post':pending(NO_ADAPTER+' Dedicated store; needs an approved reward unit and open batch.'),
 'lifecycle.acknowledgement.submit':pending(NO_ADAPTER+' Dedicated store; needs a lifecycle case fixture.'),
 'toil.replacement.request':pending(NO_ADAPTER+' Dedicated store.'),
 'multi_cycle_payroll.create_run':pending(NO_ADAPTER+' Dedicated store; multi-cycle payroll flag.'),
 'typed_pay_components.create':pending(NO_ADAPTER+' Dedicated store; typed pay components flag.'),
 'country-my.statutory.update':pending(NO_ADAPTER+' Dedicated store; country pack dispatch.'),
 'notifications.email_preferences.save':pending(NO_ADAPTER+' Module-action store.'),
 'system_testing.execution.save':pending(NO_ADAPTER+' Module-action store; needs an assigned test execution.'),
 'leave.adjustment.apply':{kind:'probed',screen:HR_ON_EMPLOYMENT},
 'employees.movement.transfer':{kind:'probed',screen:HR_ON_EMPLOYMENT},
 'toil.credit.grant':{kind:'probed',screen:HR_ON_EMPLOYMENT},
} as const satisfies Record<AgentActionId,ParityDeclaration>;

/** FROZEN: the 23 entries that were pending when the harness landed (WP8, 29 Oct 2026). Never edit this list;
 * PARITY_PENDING_CEILING must stay a subset of it, so a pending entry can be removed but never swapped. */
export const PARITY_PENDING_ORIGINAL:readonly string[]=Object.freeze([
 'org.reporting.change','leave.apply','leave.cancel','leave.edit','ess.profile.request','approvals.leave.decide',
 'knowledge_base.article.create','payroll.close','attendance.correction.request','attendance.overtime.request',
 'claims.draft.save','claims.submit','claims.cancel','performance.review.acknowledge','performance.onehr.plan.acknowledge',
 'rewards.post','lifecycle.acknowledgement.submit','toil.replacement.request','multi_cycle_payroll.create_run',
 'typed_pay_components.create','country-my.statutory.update','notifications.email_preferences.save','system_testing.execution.save',
]);
/** The entries that existed before this harness and had no adapter when it landed. This list may only
 * shrink: an entry leaves it when its adapter lands, and no other id may ever be `pending`. */
export const PARITY_PENDING_CEILING:ReadonlySet<string>=new Set([
 'org.reporting.change','leave.apply','ess.profile.request','approvals.leave.decide',
 'knowledge_base.article.create','payroll.close','attendance.correction.request',
 'claims.draft.save','claims.submit','performance.review.acknowledge','performance.onehr.plan.acknowledge',
 'rewards.post','lifecycle.acknowledgement.submit','toil.replacement.request','multi_cycle_payroll.create_run',
 'typed_pay_components.create','country-my.statutory.update','notifications.email_preferences.save','system_testing.execution.save',
]);

export type ParityRegistryEntry={id:string;store:string};
/** Every way the declarations can fail to cover the registry. Pure, so the guard test can feed it a
 * registry with an extra entry and prove the refusal. Empty array = covered. */
export function parityCoverageProblems(registry:readonly ParityRegistryEntry[],declarations:Readonly<Record<string,ParityDeclaration>>,ceiling:ReadonlySet<string>=PARITY_PENDING_CEILING,original:readonly string[]=PARITY_PENDING_ORIGINAL):string[]{
 const problems:string[]=[],ids=new Set(registry.map(entry=>entry.id));
 for(const id of ceiling)if(!original.includes(id))problems.push(`${id}: not in the frozen PARITY_PENDING_ORIGINAL; the pending ceiling can only lose entries, never gain or swap them`);
 if(ceiling.size>original.length)problems.push(`pending ceiling has ${ceiling.size} entries, more than the frozen ${original.length}`);
 for(const id of Object.keys(declarations))if(!ids.has(id))problems.push(`${id}: declared but not in the registry`);
 for(const id of ceiling)if(declarations[id]&&declarations[id].kind!=='pending')problems.push(`${id}: has a probed declaration, so remove it from PARITY_PENDING_CEILING (the list only shrinks)`);
 for(const entry of registry){
  const d=declarations[entry.id];
  if(!d){problems.push(`${entry.id}: no parity matrix declaration (add a probed declaration and a DB adapter)`);continue;}
  if((entry.store==='human_workflow_only')!==(d.kind==='human_workflow_only'))problems.push(`${entry.id}: human_workflow_only declaration must match the registry store (${entry.store})`);
  if(d.kind==='pending'){if(!ceiling.has(entry.id))problems.push(`${entry.id}: a new entry cannot be pending; it needs a probed declaration and a DB adapter`);if(!d.reason.trim())problems.push(`${entry.id}: pending without a reason`);continue;}
  if(d.kind==='human_workflow_only'){if(!d.reason.trim())problems.push(`${entry.id}: human_workflow_only without a reason`);continue;}
  for(const role of PARITY_ROLES)if(d.screen[role]!=='allow'&&d.screen[role]!=='deny')problems.push(`${entry.id}: no screen outcome for ${role}`);
  for(const role of Object.keys(d.screen))if(!(PARITY_ROLES as readonly string[]).includes(role))problems.push(`${entry.id}: unknown role ${role}`);
  for(const role of ALWAYS_REFUSED)if(d.screen[role]!=='deny')problems.push(`${entry.id}: ${role} must be refused`);
  const narrowed=d.narrowed??{};
  for(const [role,reason] of Object.entries(narrowed)){
   if(!(PARITY_ROLES as readonly string[]).includes(role)){problems.push(`${entry.id}: narrowed unknown role ${role}`);continue;}
   if(d.screen[role as ParityRole]!=='allow')problems.push(`${entry.id}: narrowing ${role} is meaningless (the screen refuses it); the agent may never be wider`);
   if(!reason?.trim())problems.push(`${entry.id}: narrowing ${role} without a reason`);
  }
  // Non-vacuity: at least one role must be allowed by the screen AND the agent, or every check is "deny = deny".
  if(!PARITY_ROLES.some(role=>d.screen[role]==='allow'&&!narrowed[role]))problems.push(`${entry.id}: no role is allowed by both the screen and the agent, so the matrix proves nothing`);
 }
 return problems;
}

/** The expected agent outcome for a role: the screen's, unless the agent is declared narrower. */
export function expectedAgentOutcome(d:Extract<ParityDeclaration,{kind:'probed'}>,role:ParityRole):ParityOutcome{return d.narrowed?.[role]?'deny':d.screen[role];}
export type ProbedActionId={[K in keyof typeof AGENT_ACTION_PARITY]:(typeof AGENT_ACTION_PARITY)[K]['kind'] extends 'probed'?K:never}[keyof typeof AGENT_ACTION_PARITY];
export const PROBED_ACTION_IDS=Object.freeze((Object.keys(AGENT_ACTION_PARITY) as (keyof typeof AGENT_ACTION_PARITY)[]).filter((id):id is ProbedActionId=>AGENT_ACTION_PARITY[id].kind==='probed'));
