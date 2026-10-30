/** ADR-0151 §7 "Parity", review R16 (WP8) — the per-entry role matrix for every Assistant agent action.
 *
 * This file DECLARES, per registry entry, what the owning screen allows each role to do to one fixture
 * subject. It is not a permission model and nothing in the product reads it. The DB harness
 * (test/helpers/agent-action-parity-probes.ts, registered by three tracked DB wrappers) runs the owning screen's own admission and service for each
 * role, and the Assistant's offer, prepare and confirm paths for the same role and subject, and requires:
 *   1. the observed screen outcome equals the value declared here (an independent expected value);
 *   2. every agent phase equals the screen outcome, except where a role is listed in `narrowed` (the agent
 *      refuses something the screen allows, with the reason). The agent may be NARROWER, never wider;
 *   3. foreign target requests are refused by every agent phase. A broader legacy native action needs an
 *      explicit narrower finding; caller-tenant catalogue creation states its separate owner boundary.
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
 *   super_admin               actual tenant administrator role, group-wide (no fabricated tenant_admin role)
 *   payroll_partner           payroll_partner for the subject's company
 *   performance_comp_partner  performance_comp_partner for the subject's company
 *   performance_partner       performance_partner (OneHR, ADR-0142) for the subject's company
 *   another_company           hr_admin of ANOTHER company of the same tenant (the strongest cross-company actor)
 *   another_tenant            group hr_admin of a different tenant
 */
import type {AgentActionId} from '../../lib/ai/agent-action-registry';

export const PARITY_ROLES=['employee','manager','assigned_approver','company_hr','group_hr','super_admin','payroll_partner','performance_comp_partner','performance_partner','another_company','another_tenant'] as const;
export type ParityRole=(typeof PARITY_ROLES)[number];
export const PARITY_PHASES=['offer','prepare','confirm'] as const;
export type ParityPhase=(typeof PARITY_PHASES)[number];
export type ParityOutcome='allow'|'deny';
/** Foreign target actors must be refused by the agent; native exceptions require an explicit narrower
 * finding, and caller-owned catalogue creation declares its separate scope. */
export const ALWAYS_REFUSED:readonly ParityRole[]=['another_company','another_tenant'];

export type ParityDeclaration=
 | Readonly<{kind:'probed';scope?:'caller_tenant'|'caller_login';scopeReason?:string;screen:Readonly<Record<ParityRole,ParityOutcome>>;page?:Readonly<Record<ParityRole,ParityOutcome>>;narrowed?:Readonly<Partial<Record<ParityRole,string>>>}>
 /** No agent prepare or confirm exists (registry store human_workflow_only): the agent can only hand off. */
 | Readonly<{kind:'human_workflow_only';reason:string}>
 /** Predates WP8; must be in PARITY_PENDING_CEILING. Never valid for a new entry. */
 | Readonly<{kind:'pending';reason:string}>;

const D='deny',A='allow';
/** Native request decisions now admit the current, same-company, matching-task stand-in through
 * the delegated-approvals package. Personnel and balances remain invisible; only request facts and
 * the request-bound native calculation/effect path are available. */
const ASSIGNED_DECISION={employee:D,manager:A,assigned_approver:A,company_hr:A,group_hr:A,super_admin:A,payroll_partner:D,performance_comp_partner:D,performance_partner:D,another_company:D,another_tenant:D} as const;
/** The routed delegate confirm gap declared by WP8 is repaired here by own-decision event visibility. */
export const ATTENDANCE_WORKFLOW_PARITY={screen:ASSIGNED_DECISION} as const;

/** HR screen behind requireAdmin (isAdmin) whose service writes an administered employment under RLS. */
const HR_ON_EMPLOYMENT={employee:D,manager:D,assigned_approver:D,company_hr:A,group_hr:A,super_admin:A,payroll_partner:D,performance_comp_partner:D,performance_partner:D,another_company:D,another_tenant:D} as const;

/** The subject's own pending request on their own screen: the native creator-only rule. */
const OWN_REQUEST={employee:A,manager:D,assigned_approver:D,company_hr:D,group_hr:D,super_admin:D,payroll_partner:D,performance_comp_partner:D,performance_partner:D,another_company:D,another_tenant:D} as const;

const CALLER_TENANT_ADMIN={...HR_ON_EMPLOYMENT,another_company:A,another_tenant:A} as const;

export const AGENT_ACTION_PARITY={
 'approvals.claim.chase':{kind:'human_workflow_only',reason:'Automatic template-only notification; no human prepare/confirm store. Principal, scope, recipients and caps are covered by automatic-chasers.test.ts.'},
 'approvals.attendance.chase':{kind:'human_workflow_only',reason:'Automatic template-only notification; no human prepare/confirm store. Principal, scope, recipients and caps are covered by automatic-chasers.test.ts.'},
 'approvals.toil.chase':{kind:'human_workflow_only',reason:'Automatic template-only notification; no human prepare/confirm store. Principal, scope, recipients and caps are covered by automatic-chasers.test.ts.'},
 'employees.review_overdue.remind':{kind:'human_workflow_only',reason:'Automatic template-only notification; no human prepare/confirm store. Principal, scope, recipients and caps are covered by automatic-chasers.test.ts.'},
 'attendance.missing_clock.remind':{kind:'human_workflow_only',reason:'Automatic template-only notification; no human prepare/confirm store. Principal, source, recipients and caps are covered by automatic-followups.test.ts.'},
 'employees.passport_expiry.remind':{kind:'human_workflow_only',reason:'Automatic template-only notification; no human prepare/confirm store. Principal, source, recipients and caps are covered by automatic-followups.test.ts.'},
 'lifecycle.step.chase':{kind:'human_workflow_only',reason:'Automatic template-only notification; no human prepare/confirm store. Principal, source, recipients and caps are covered by automatic-followups.test.ts.'},
 'employees.import':{kind:'human_workflow_only',reason:'No agent prepare or confirm: the Assistant only hands off to the native import page, which keeps its own admission.'},
 'org.reporting.change':{kind:'probed',screen:HR_ON_EMPLOYMENT},
 'org.position.archive':{kind:'probed',screen:HR_ON_EMPLOYMENT},
 'org.department.archive':{kind:'probed',screen:HR_ON_EMPLOYMENT},
 'org.people_general.change':{kind:'probed',scope:'caller_tenant',scopeReason:'Implicit authenticated tenant policy has no target selector. Foreign group HR can change only their own tenant policy; another-company scoped HR has no whole-organisation authority. Cross-user review adoption remains refused.',screen:{...HR_ON_EMPLOYMENT,company_hr:D,another_tenant:A}},
 'org.employee_id_template.status':{kind:'probed',screen:HR_ON_EMPLOYMENT},
 'leave.apply':{kind:'probed',screen:OWN_REQUEST},
 'leave.cancel':{kind:'probed',screen:OWN_REQUEST},
 'leave.edit':{kind:'probed',screen:OWN_REQUEST},
 'ess.profile.request':{kind:'probed',screen:OWN_REQUEST},
 'approvals.leave.decide':{kind:'probed',screen:ASSIGNED_DECISION},
 'approvals.claim.decide':{kind:'probed',screen:ASSIGNED_DECISION},
 'approvals.attendance.decide':{kind:'probed',screen:ASSIGNED_DECISION},
 'approvals.toil.decide':{kind:'probed',screen:ASSIGNED_DECISION},
 'knowledge_base.article.create':{kind:'probed',scope:'caller_tenant',scopeReason:'The closed input has no tenant selector. Native creation is inside the caller tenant; foreign-tenant own creation is valid, while review custody never crosses logins or tenants.',screen:CALLER_TENANT_ADMIN},
 'payroll.close':{kind:'probed',screen:HR_ON_EMPLOYMENT,page:CALLER_TENANT_ADMIN},
 'attendance.correction.request':{kind:'probed',screen:OWN_REQUEST},
 'attendance.overtime.request':{kind:'probed',screen:OWN_REQUEST},
 'claims.draft.save':{kind:'probed',screen:OWN_REQUEST},
 'claims.submit':{kind:'probed',screen:OWN_REQUEST},
 /** Owner decision 30 Oct: the web cancellation action resolves the claimant's own employment. */
 'claims.cancel':{kind:'probed',screen:OWN_REQUEST},
 'performance.review.acknowledge':{kind:'probed',screen:OWN_REQUEST},
 'performance.onehr.plan.acknowledge':{kind:'probed',screen:OWN_REQUEST},
 'rewards.post':{kind:'probed',screen:HR_ON_EMPLOYMENT},
 'lifecycle.acknowledgement.submit':{kind:'probed',screen:OWN_REQUEST},
 'toil.replacement.request':{kind:'probed',screen:OWN_REQUEST},
 'multi_cycle_payroll.create_run':{kind:'probed',screen:HR_ON_EMPLOYMENT,page:CALLER_TENANT_ADMIN},
 'typed_pay_components.create':{kind:'probed',scope:'caller_tenant',scopeReason:'The closed input has no tenant selector. Native creation is inside the caller tenant; foreign-tenant own creation is valid, while review custody never crosses logins or tenants.',screen:CALLER_TENANT_ADMIN},
 'country-my.statutory.update':{kind:'probed',screen:{...HR_ON_EMPLOYMENT,another_company:A},narrowed:{another_company:'Legacy native Personnel statutory write permits this tenant HR actor through its shared-person setter; reviewed source additionally requires is_admin_for(company), can_admin_payroll_employment and access_workforce_employment(workforce.maintain), plus full sensitive field scope. Keep that company-bound refusal; verify actual native withWrite interval on the next SHA. Native setter result observed in 40944662433.'}},
 'notifications.email_preferences.save':{kind:'probed',screen:OWN_REQUEST},
 'system_testing.execution.save':{kind:'probed',screen:OWN_REQUEST},
 'leave.adjustment.apply':{kind:'probed',screen:HR_ON_EMPLOYMENT},
 'employees.compensation.maintain':{kind:'probed',screen:HR_ON_EMPLOYMENT},
 'employees.cost_allocation.maintain':{kind:'probed',screen:HR_ON_EMPLOYMENT},
 'employees.payment_method.maintain':{kind:'probed',screen:HR_ON_EMPLOYMENT},
 'employees.code.maintain':{kind:'probed',screen:HR_ON_EMPLOYMENT},
 'employees.workforce_profile.maintain':{kind:'probed',screen:HR_ON_EMPLOYMENT},
 'employees.passport.maintain':{kind:'probed',screen:HR_ON_EMPLOYMENT},
 'employees.tp3_opening.maintain':{kind:'probed',screen:{...HR_ON_EMPLOYMENT,another_company:A},narrowed:{another_company:'The legacy HR-only native setter shares person-level statutory authority across tenant companies. Assistant additionally requires shared-person Workforce maintenance and TP3 payroll/personnel visibility in every retained company before its minimal snapshot.'}},
 'employees.bank.maintain':{kind:'probed',screen:HR_ON_EMPLOYMENT},
 'employees.fixed_item.archive':{kind:'probed',screen:HR_ON_EMPLOYMENT},
 'employees.document_metadata.maintain':{kind:'probed',screen:HR_ON_EMPLOYMENT},
 'employees.emergency_contact.maintain':{kind:'probed',screen:HR_ON_EMPLOYMENT},
 'employees.draft.activate':{kind:'probed',screen:HR_ON_EMPLOYMENT},
 'employees.family.maintain':{kind:'probed',screen:HR_ON_EMPLOYMENT},
 'employees.qualification.maintain':{kind:'probed',screen:HR_ON_EMPLOYMENT},
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
  if(d.scope&&!d.scopeReason?.trim())problems.push(`${entry.id}: caller scope requires a boundary reason`);
  for(const role of PARITY_ROLES)if(d.screen[role]!=='allow'&&d.screen[role]!=='deny')problems.push(`${entry.id}: no screen outcome for ${role}`);
  for(const role of Object.keys(d.screen))if(!(PARITY_ROLES as readonly string[]).includes(role))problems.push(`${entry.id}: unknown role ${role}`);
  for(const role of ALWAYS_REFUSED)if(!d.scope&&d.screen[role]!=='deny'&&!(role==='another_company'&&d.narrowed?.[role]))problems.push(`${entry.id}: ${role} must be refused`);
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
