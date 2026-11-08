/** AI management: the one place to manage AI. Each section is its own sub-menu page under
 * /control-tower/agents (the Overview keeps the original address), all behind the same requireAdmin guard
 * and listed in lib/permissions.ts. Provider setup moved here from Administration › AI, and the Assistant
 * reviews moved here from the employee Assistant page. A section the session cannot use (spending without a
 * spend policy, provider setup without group-wide authority) is not offered, and opening it goes to the Overview rather than rendering an empty page. */
/** AI Centre restructure (4 Nov 2026): Workers (`features`) is the one list of AI pieces, the inventory among them, so the
 * Inventory page is a guarded forward stub rather than a section. */
export const AI_MANAGEMENT_SECTION_DEFINITIONS = [
 {key:'overview',navigationId:'nested.aiManagement.overview',path:''},
 {key:'provider',navigationId:'nested.aiManagement.provider',path:'/provider'},
 {key:'assistant',navigationId:'nested.aiManagement.assistant',path:'/assistant'},
 {key:'features',navigationId:'nested.aiManagement.features',path:'/features'},
 {key:'allowances',navigationId:'nested.aiManagement.allowances',path:'/allowances'},
 {key:'spending',navigationId:'nested.aiManagement.spending',path:'/spending'},
 {key:'orchestrator',navigationId:'nested.aiManagement.orchestrator',path:'/orchestrator'},
 {key:'runs',navigationId:'nested.aiManagement.runs',path:'/runs'},
] as const;
export type AiManagementSection = (typeof AI_MANAGEMENT_SECTION_DEFINITIONS)[number]['key'];
export const AI_MANAGEMENT_SECTIONS:readonly AiManagementSection[] = AI_MANAGEMENT_SECTION_DEFINITIONS.map(section=>section.key);
export function aiManagementNavigation(section:AiManagementSection){
 const definition=AI_MANAGEMENT_SECTION_DEFINITIONS.find(item=>item.key===section);
 if(!definition)throw Error('Unknown AI management navigation descriptor');return definition;
}
export const AI_MANAGEMENT_PAGE = '/control-tower/agents';
export function availableAiManagementSections(scope:{spend:boolean;provider:boolean}):AiManagementSection[]{
  return AI_MANAGEMENT_SECTIONS.filter(s=>(s!=='spending'||scope.spend)&&(s!=='provider'||scope.provider));
}
/** Path suffix of each section's page. */
export const AI_MANAGEMENT_PATHS: Readonly<Record<AiManagementSection,string>> = {
 overview:aiManagementNavigation('overview').path,
 provider:aiManagementNavigation('provider').path,
 assistant:aiManagementNavigation('assistant').path,
 features:aiManagementNavigation('features').path,
 allowances:aiManagementNavigation('allowances').path,
 spending:aiManagementNavigation('spending').path,
 orchestrator:aiManagementNavigation('orchestrator').path,
 runs:aiManagementNavigation('runs').path
};
/** Closed save outcomes; the page translates them. Free text from a query string is never displayed. */
export type AiManagementToast='saved'|'default'|'bulk';
export function aiManagementHref(section:AiManagementSection,extra:{q?:string;toast?:AiManagementToast;error?:string;anchor?:string}={}):string{
  const params=new URLSearchParams();
  if(extra.q)params.set('q',extra.q.slice(0,100));
  if(extra.toast)params.set('toast',extra.toast);
  if(extra.error)params.set('error',extra.error);
  const query=params.toString();
  return `${AI_MANAGEMENT_PAGE}${AI_MANAGEMENT_PATHS[section]}${query?'?'+query:''}${extra.anchor??''}`;
}
