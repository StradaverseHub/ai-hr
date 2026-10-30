/** Fixed human review pages, never callable effects or an assertion of effect permission. */
import {z} from 'zod';
import {LIFECYCLE_OFFBOARDING_HUMAN_HANDOFF_SCHEMA,lifecycleOffboardingHumanHandoff} from './lifecycle-offboarding-human-handoff';
import {EMPLOYEE_IMPORT_HUMAN_HANDOFF_SCHEMA,employeeImportHumanHandoff} from './employee-import-human-handoff';
import {getModuleAgentAction,parseModuleAgentActionNomination} from './module-agent-actions';
import type {AgentModuleCode} from './module-agents';
import {AGENT_ACTIONS,type AgentAction} from './agent-action-registry';
type ReviewPageAction=Extract<AgentAction,{readonly review:{readonly handoff:'review_page'}}>;
/** WP7: derived from the registry (`review.handoff==='review_page'`), in registry order within a module.
 * HR-prepared actions keep their own review page without a module-read handoff ('none'). */
const routes=Object.freeze(AGENT_ACTIONS.filter((action):action is ReviewPageAction=>action.review.handoff==='review_page').map(action=>Object.freeze({module:action.module,action:action.id,route:action.review.route})));
const closed=<T extends string>(values:readonly T[])=>[...new Set(values)] as [T,...T[]];
const Handoff=z.object({module:z.enum(closed(routes.map(row=>row.module))),action:z.enum(closed(routes.map(row=>row.action))),
 route:z.enum(closed(routes.map(row=>row.route))),requiresHumanSelection:z.literal(true),effect:z.literal('none'),authority:z.literal('rechecked_on_review_page')}).strict();
const AnyHandoff=z.union([Handoff,EMPLOYEE_IMPORT_HUMAN_HANDOFF_SCHEMA,LIFECYCLE_OFFBOARDING_HUMAN_HANDOFF_SCHEMA]);
export type ModuleHumanHandoff=z.infer<typeof AnyHandoff>;
/** Called only after actual canonical read admission. It retrieves no HR values or choices. The
 * destination must still prove the current caller, source permission and human confirmation. */
export function moduleHumanActionHandoffs(module:AgentModuleCode):readonly ModuleHumanHandoff[]{
 // Existing native import is a distinct human workflow, never a generic prepare/confirm adapter.
 const nativeImport=module==='employees'&&getModuleAgentAction('employees','employees.import')?.prepare.status==='human_workflow_only'?[employeeImportHumanHandoff()]:[];
 const nativeLifecycle=module==='lifecycle'?[lifecycleOffboardingHumanHandoff()]:[];
 return Object.freeze([...nativeImport,...nativeLifecycle,...routes.filter(row=>row.module===module).flatMap(row=>{
  const declared=getModuleAgentAction(row.module,row.action);if(declared?.prepare.status!=='implemented'||declared.confirm.status!=='implemented')return [];
  const nomination=parseModuleAgentActionNomination({module:row.module,action:row.action,phase:'prepare'});if(nomination.kind!=='prepare'||nomination.effect!=='none'||!nomination.requiresHumanSelection)return [];
  return [Object.freeze(Handoff.parse({...row,requiresHumanSelection:true,effect:'none',authority:'rechecked_on_review_page'}))];
 })]);
}
/** No provider-supplied URL, selector, grant, confirmation or extra action can become a link. Legacy
 * read outcomes without handoff metadata keep their original presentation. */
export function checkedModuleHumanHandoffs(module:AgentModuleCode,value:unknown):readonly ModuleHumanHandoff[]{
 if(value===undefined)return Object.freeze([]);
 const actual=z.array(AnyHandoff).max(20).parse(value),expected=moduleHumanActionHandoffs(module);
 if(JSON.stringify(actual)!==JSON.stringify(expected))throw Error('Human review options unavailable.');
 return Object.freeze(actual.map(row=>Object.freeze(row)));
}
