/** ADR-0169 phase B — the parity action catalogue for the Assistant capability layer.
 *
 * Every human-confirmed action in the registry (lib/ai/agent-action-registry.ts) becomes something the
 * Assistant can SUGGEST: a pointer to the action's own native review page, where the person enters or
 * selects the details, sees the exact change and confirms it through the owning service. Suggesting is
 * not preparing. Offering uses the existing per-caller owners (registry actor classes, readable modules,
 * fresh pause checks) and fails closed; every review page re-checks authority on its own server path.
 * Automatic reminders (agent principal) are never suggestable. The seven actions with an inline chat card
 * keep the native hint schema check (checkProposal). Not imported by the production Assistant. */
import {withTenant,type SessionContext} from '../../db/client';
import {AGENT_ACTIONS,agentActionPauseKey,type AgentAction} from '../../lib/ai/agent-action-registry';
import {isAssistantProposableAction} from '../../lib/ai/assistant-action-proposal-hints';
import {AiAllowanceError} from '../../lib/ai/types';
import {assistantActionActors} from '../assistant-action-catalogue';
import {assistantReadableModules} from '../assistant-readable-modules';
import {assertAgentActionUnpausedTx,assertAiActionUnpausedTx} from '../ai-governance';

/** One plain sentence per suggestable action, so a model can match a request to the right review page.
 * Authored from each entry's id, review page and human inputs; it never states an outcome or permission. */
export const ACTION_PURPOSE:Readonly<Record<string,string>>=Object.freeze({
 'employees.import':'Import new or updated employee records from a spreadsheet file.',
 'org.position.archive':'Archive or restore a job position in the organisation catalogue.',
 'org.department.archive':'Archive or restore a department.',
 'org.employee_id_template.status':'Activate or deactivate an employee ID numbering template.',
 'org.people_general.change':'Change company-wide people settings.',
 'org.reporting.change':'Change who an employee reports to.',
 'leave.apply':'Apply for leave for yourself.',
 'leave.cancel':'Cancel one of your own leave requests.',
 'leave.edit':'Change the dates of one of your own leave requests.',
 'ess.profile.request':'Request a change to your own profile details for HR approval, such as your address, emergency contact, dependants or bank details.',
 'approvals.leave.decide':'Review leave requests waiting for your approval.',
 'approvals.claim.decide':'Review expense claims waiting for your approval.',
 'approvals.attendance.decide':'Review attendance or overtime requests waiting for your approval.',
 'approvals.toil.decide':'Review replacement-leave requests waiting for your approval.',
 'knowledge_base.article.create':'Write and publish a knowledge base article.',
 'payroll.close':'Close a processed payroll run.',
 'payroll.reopen':'Reopen a closed payroll run.',
 'payroll.reset':'Reset a processed payroll run back to draft.',
 'attendance.correction.request':'Request a correction to your own attendance record, such as a missed clock-in or clock-out.',
 'attendance.overtime.request':'Request overtime for yourself.',
 'claims.draft.save':'Create or update your own expense claim draft.',
 'claims.submit':'Submit an expense claim for yourself.',
 'claims.cancel':'Cancel one of your own expense claims.',
 'performance.checkin.cancel':'Cancel a scheduled performance check-in.',
 'performance.checkin.complete':'Complete a performance check-in.',
 'performance.checkin.schedule':'Schedule a performance check-in.',
 'performance.goal.approve':'Approve an employee\'s performance goal.',
 'performance.review.acknowledge':'Acknowledge your own released performance review.',
 'performance.onehr.plan.acknowledge':'Acknowledge your own development plan.',
 'rewards.post':'Post an approved rewards unit to payroll.',
 'rewards.cancel_review':'Cancel a rewards review.',
 'rewards.calendar.update':'Update a rewards cycle calendar.',
 'lifecycle.offboarding.step.complete':'Complete a step in an offboarding case.',
 'lifecycle.offboarding.step.undo':'Undo a completed offboarding step.',
 'lifecycle.offboarding.case.cancel':'Cancel an offboarding case.',
 'rewards.annual_review.return':'Return an annual rewards review for rework.',
 'lifecycle.acknowledgement.submit':'Submit your onboarding acknowledgement, such as equipment received.',
 'toil.replacement.request':'Request replacement leave (time off in lieu) for yourself.',
 'multi_cycle_payroll.create_run':'Create a new payroll run for a pay period.',
 'typed_pay_components.create':'Create a new pay code, such as an allowance or deduction.',
 'country-my.statutory.update':'Update an employee\'s Malaysian statutory details (EPF, SOCSO, tax).',
 'notifications.email_preferences.save':'Change your own email notification preferences.',
 'system_testing.execution.save':'Record the result of an assigned system test.',
 'leave.adjustment.apply':'Adjust an employee\'s leave balance up or down.',
 'employees.movement.transfer':'Transfer or move an employee, such as a department or position change.',
 'employees.compensation.maintain':'Add or change an employee\'s salary or compensation record.',
 'attendance.schedule_group.maintain':'Change an employee\'s attendance schedule group.',
 'employees.profile_request.reject':'Reject an employee\'s profile change request.',
 'attendance.day_schedule.correct':'Correct an employee\'s schedule for a specific day.',
 'employees.code.maintain':'Change an employee\'s employee code.',
 'employees.workforce_profile.maintain':'Update a section of an employee\'s workforce profile.',
 'employees.bank.maintain':'Update an employee\'s bank account details.',
 'employees.document_metadata.maintain':'Update an employee\'s identity document details.',
 'employees.fixed_item.archive':'Archive an employee\'s fixed pay item.',
 'employees.cost_allocation.maintain':'Change an employee\'s cost allocation.',
 'employees.payment_method.maintain':'Change how an employee is paid.',
 'employees.tp3_opening.maintain':'Record an employee\'s TP3 prior-employment tax opening balances.',
 'employees.passport.maintain':'Update an employee\'s passport details.',
 'employees.emergency_contact.maintain':'Add, change or remove an employee\'s emergency contact.',
 'employees.family.maintain':'Add, change or remove an employee\'s family or dependant record.',
 'employees.qualification.maintain':'Add, change or remove an employee\'s qualification.',
 'employees.draft.discard':'Discard an unfinished new-hire draft.',
 'employees.draft.activate':'Activate a new-hire draft as an employee.',
 'toil.credit.grant':'Grant an employee replacement-leave credit for extra days worked.',
});

/** Human-confirmed registry actions a person could be pointed to. Automatic reminders never qualify. */
export const SUGGESTABLE_ACTIONS:readonly AgentAction[]=Object.freeze(AGENT_ACTIONS.filter(action=>
 action.policy.tier!=='automatic'&&action.permission.actor!=='agent_principal'&&typeof action.review.route==='string'&&action.review.route.startsWith('/')));

export type SuggestableAction=Readonly<{id:string;module:string;purpose:string;reviewRoute:string;
 /** The details the review page collects; the native page owns entry and validation. */
 humanInputs:readonly string[]|'native_page_only';inlineCard:boolean;tier:string}>;
/** The caller's facts could not be checked right now (not a pause, not a refusal). Callers fail closed. */
export class ActionCatalogueUnavailable extends Error{constructor(){super('The action catalogue could not be checked.');this.name='ActionCatalogueUnavailable';}}

/** Actions this caller may be offered: actor class held, module readable, not paused (read fresh). */
export async function actionCatalogueFor(ctx:SessionContext):Promise<readonly SuggestableAction[]>{
 const actors=new Set<string>(assistantActionActors(ctx)),readable=new Set<string>(assistantReadableModules(ctx));
 const candidates=SUGGESTABLE_ACTIONS.filter(action=>actors.has(action.permission.actor)&&readable.has(action.module));
 if(!candidates.length)return Object.freeze([]);
 const paused=new Set<string>();
 await withTenant(ctx,async tx=>{
  for(const key of new Set(candidates.map(action=>action.pauseKey))){
   try{await tx.transaction(async savepoint=>{await assertAiActionUnpausedTx(savepoint,ctx,key);});}
   catch(error){if(error instanceof AiAllowanceError&&error.reason==='paused')paused.add(key);else throw new ActionCatalogueUnavailable();}
  }
  for(const action of candidates){if(paused.has(action.pauseKey))continue;
   try{await tx.transaction(async savepoint=>{await assertAgentActionUnpausedTx(savepoint,action.id);});}
   catch(error){if(error instanceof AiAllowanceError&&error.reason==='paused')paused.add(agentActionPauseKey(action));else throw new ActionCatalogueUnavailable();}
  }
 });
 return Object.freeze(candidates.filter(action=>!paused.has(action.pauseKey)&&!paused.has(agentActionPauseKey(action))).map(action=>Object.freeze({
  id:action.id,module:action.module,purpose:ACTION_PURPOSE[action.id]??action.id,reviewRoute:action.review.route,
  humanInputs:action.humanInputs,inlineCard:isAssistantProposableAction(action.id),tier:action.policy.tier})));
}
