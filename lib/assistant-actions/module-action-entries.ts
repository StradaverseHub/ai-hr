/** Which native-action shortcuts an Assistant task card may OFFER. Offering is a courtesy only: every
 * target still repeats its own server refusal, and nothing here grants, widens or caches authority.
 * Each role floor below is the TypeScript mirror of the gate the target's own server already applies;
 * it never replaces that gate. A floor that needs a fresh source read returns null (see
 * core/assistant-actions/module-action-entries.ts). */
import type {SessionContext} from '../../db/client';
import type {AgentModuleCode} from '../ai/module-agents';
import {isAdmin,canManagePayroll,withEffectiveGrants} from '../authz-model';

export const MODULE_ACTION_ENTRIES=['employee_import','org','payroll_close','knowledge','multi_cycle_run','pay_component','assigned_leave','country_statutory','rewards','rewards_cancel','rewards_calendar','rewards_return'] as const;
export type ModuleActionEntry=(typeof MODULE_ACTION_ENTRIES)[number];
/** allowed = offer it; refused = the session's authorization rules it out; unknown = a source read
 * failed, so the link stays hidden and a page keeps its ordinary "cannot load" wording. */
export type ModuleActionEntryAccess='allowed'|'refused'|'unknown';

/** The task card that carries each gated shortcut. Other shortcuts are own-record actions. */
export const MODULE_ACTION_ENTRY_OF:Readonly<Partial<Record<AgentModuleCode,ModuleActionEntry>>>=Object.freeze({
 employees:'employee_import',org:'org',payroll:'payroll_close',knowledge_base:'knowledge',
 multi_cycle_payroll:'multi_cycle_run',typed_pay_components:'pay_component',approvals:'assigned_leave','country-my':'country_statutory',rewards:'rewards',
});

/** Pure role floors, or null where only a fresh source read can answer. */
export function moduleActionEntryRoleFloor(ctx:SessionContext,entry:ModuleActionEntry):boolean|null{
 switch(entry){
  // app/(app)/admin/personnel/import/page.tsx → requireAdmin() → isAdmin.
  case 'employee_import':return isAdmin(ctx);
  // assertKnowledgeArticleActorTx → assertKbAuthor → canAuthor (core/knowledge-base.ts) = isAdmin.
  case 'knowledge':return isAdmin(ctx);
  // withReviewedPayComponentIntervalTx requires app.is_admin(); isAdmin is its TypeScript mirror.
  case 'pay_component':return isAdmin(ctx);
  // reviewedPayrollCloseChoiceMetadataTx nominates only app.can_admin_payroll_for companies.
  case 'payroll_close':return canManagePayroll(withEffectiveGrants(ctx));
  // readMultiCycleRunModuleActionChoices and reviewedCountryStatutoryChoiceMetadataTx both require
  // app.can_admin_payroll_for AND app.is_admin_for.
  case 'multi_cycle_run':case 'country_statutory':return isAdmin(ctx)&&canManagePayroll(withEffectiveGrants(ctx));
  // app.reward_admin admits only hr_admin/super_admin assignments; which companies is a live read.
  case 'rewards':return isAdmin(ctx)?null:false;
  // Reporting-line maintenance and assigned decisions depend on live scope/assignment rows.
  case 'org':case 'assigned_leave':case 'rewards_cancel':case 'rewards_calendar':case 'rewards_return':return null;
 }
}
