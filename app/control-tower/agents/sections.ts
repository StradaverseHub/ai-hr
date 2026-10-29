/** AI management: the one place to manage AI. Each section is its own sub-menu page under
 * /control-tower/agents (the Overview keeps the original address), all behind the same requireAdmin guard
 * and listed in lib/permissions.ts. Provider setup moved here from Administration › AI, and the Assistant
 * reviews moved here from the employee Assistant page. A section the session cannot use (spending without a
 * spend policy, provider setup without group-wide authority) is not offered, and opening it goes to the Overview rather than rendering an empty page. */
export const AI_MANAGEMENT_SECTIONS = ['inventory','overview','provider','assistant','features','allowances','spending','orchestrator','runs'] as const;
export type AiManagementSection = (typeof AI_MANAGEMENT_SECTIONS)[number];
export const AI_MANAGEMENT_PAGE = '/control-tower/agents';
export function availableAiManagementSections(scope:{spend:boolean;provider:boolean}):AiManagementSection[]{
  return AI_MANAGEMENT_SECTIONS.filter(s=>(s!=='spending'||scope.spend)&&(s!=='provider'||scope.provider));
}
/** Path suffix of each section's page. */
export const AI_MANAGEMENT_PATHS: Readonly<Record<AiManagementSection,string>> = {
  inventory:'/inventory',overview:'',provider:'/provider',assistant:'/assistant',features:'/features',allowances:'/allowances',spending:'/spending',orchestrator:'/orchestrator',runs:'/runs',
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
