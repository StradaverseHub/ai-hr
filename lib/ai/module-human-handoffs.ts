/** Fixed human review pages, never callable effects or an assertion of effect permission. */
import {z} from 'zod';
import {getModuleAgentAction,parseModuleAgentActionNomination} from './module-agent-actions';
import type {AgentModuleCode} from './module-agents';
const routes=[
 {module:'leave',action:'leave.apply',route:'/assistant/leave'},
 {module:'knowledge_base',action:'knowledge_base.article.create',route:'/assistant/knowledge-base'},
 {module:'org',action:'org.reporting.change',route:'/assistant/org'},
 {module:'claims',action:'claims.draft.save',route:'/assistant/claims'},
 {module:'claims',action:'claims.submit',route:'/assistant/claims'},
 {module:'system_testing',action:'system_testing.execution.save',route:'/assistant/testing'},
 {module:'ess',action:'ess.profile.request',route:'/assistant/profile'},
 {module:'notifications',action:'notifications.email_preferences.save',route:'/assistant/notifications'},
 {module:'performance',action:'performance.review.acknowledge',route:'/assistant/performance'},
 {module:'performance',action:'performance.onehr.plan.acknowledge',route:'/assistant/performance'},
] as const;
const Handoff=z.object({module:z.enum(['leave','ess','notifications','performance','claims','system_testing','org','knowledge_base']),action:z.enum(['knowledge_base.article.create','org.reporting.change','claims.submit','system_testing.execution.save','claims.draft.save','leave.apply','ess.profile.request','notifications.email_preferences.save','performance.review.acknowledge','performance.onehr.plan.acknowledge']),
 route:z.enum(['/assistant/knowledge-base','/assistant/org','/assistant/testing','/assistant/claims','/assistant/leave','/assistant/profile','/assistant/notifications','/assistant/performance']),requiresHumanSelection:z.literal(true),effect:z.literal('none'),authority:z.literal('rechecked_on_review_page')}).strict();
export type ModuleHumanHandoff=z.infer<typeof Handoff>;
/** Called only after actual canonical read admission. It retrieves no HR values or choices. The
 * destination must still prove the current caller, source permission and human confirmation. */
export function moduleHumanActionHandoffs(module:AgentModuleCode):readonly ModuleHumanHandoff[]{
 return Object.freeze(routes.filter(row=>row.module===module).flatMap(row=>{
  const declared=getModuleAgentAction(row.module,row.action);if(declared?.prepare.status!=='implemented'||declared.confirm.status!=='implemented')return [];
  const nomination=parseModuleAgentActionNomination({module:row.module,action:row.action,phase:'prepare'});if(nomination.kind!=='prepare'||nomination.effect!=='none'||!nomination.requiresHumanSelection)return [];
  return [Object.freeze(Handoff.parse({...row,requiresHumanSelection:true,effect:'none',authority:'rechecked_on_review_page'}))];
 }));
}
/** No provider-supplied URL, selector, grant, confirmation or extra action can become a link. Legacy
 * read outcomes without handoff metadata keep their original presentation. */
export function checkedModuleHumanHandoffs(module:AgentModuleCode,value:unknown):readonly ModuleHumanHandoff[]{
 if(value===undefined)return Object.freeze([]);
 const actual=z.array(Handoff).max(10).parse(value),expected=moduleHumanActionHandoffs(module);
 if(JSON.stringify(actual)!==JSON.stringify(expected))throw Error('Human review options unavailable.');
 return Object.freeze(actual.map(row=>Object.freeze(row)));
}
