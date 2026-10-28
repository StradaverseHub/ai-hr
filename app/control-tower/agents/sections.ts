/** AI management sub-menu. Each section is its own page under /control-tower/agents (the Needs attention
 * page keeps the original address), all behind the same requireAdmin guard and listed in lib/permissions.ts.
 * A section the session cannot use (user allowances without user-write scope, spending without a spend
 * policy) is not offered, and opening it goes to Needs attention rather than rendering an empty page. */
export const AI_MANAGEMENT_SECTIONS = ['attention','features','companies','users','spending','orchestrator','runs'] as const;
export type AiManagementSection = (typeof AI_MANAGEMENT_SECTIONS)[number];
export const AI_MANAGEMENT_PAGE = '/control-tower/agents';
export function availableAiManagementSections(scope:{mayWriteUsers:boolean;spend:boolean}):AiManagementSection[]{
  return AI_MANAGEMENT_SECTIONS.filter(s=>(s!=='users'||scope.mayWriteUsers)&&(s!=='spending'||scope.spend));
}
/** Path suffix of each section's page. */
export const AI_MANAGEMENT_PATHS: Readonly<Record<AiManagementSection,string>> = {
  attention:'',features:'/features',companies:'/companies',users:'/users',spending:'/spending',orchestrator:'/orchestrator',runs:'/runs',
};
/** Closed save outcomes; the page translates them. Free text from a query string is never displayed. */
export type AiManagementToast='saved'|'default';
export function aiManagementHref(section:AiManagementSection,extra:{q?:string;toast?:AiManagementToast;anchor?:string}={}):string{
  const params=new URLSearchParams();
  if(extra.q)params.set('q',extra.q.slice(0,100));
  if(extra.toast)params.set('toast',extra.toast);
  const query=params.toString();
  return `${AI_MANAGEMENT_PAGE}${AI_MANAGEMENT_PATHS[section]}${query?'?'+query:''}${extra.anchor??''}`;
}
