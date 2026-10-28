/** AI management sub-menu. One route, one permission (requireAdmin); each section is a `?view=` tab so the
 * page loads and shows one section at a time instead of one long page behind anchor links. A section the
 * session cannot use (user allowances without user-write scope, spending without a spend policy) is not
 * offered, and asking for it falls back to the first section rather than rendering an empty page. */
export const AI_MANAGEMENT_SECTIONS = ['attention','features','companies','users','spending','orchestrator','runs'] as const;
export type AiManagementSection = (typeof AI_MANAGEMENT_SECTIONS)[number];
export const AI_MANAGEMENT_PAGE = '/control-tower/agents';
export function availableAiManagementSections(scope:{mayWriteUsers:boolean;spend:boolean}):AiManagementSection[]{
  return AI_MANAGEMENT_SECTIONS.filter(s=>(s!=='users'||scope.mayWriteUsers)&&(s!=='spending'||scope.spend));
}
export function resolveAiManagementSection(value:unknown,available:readonly AiManagementSection[]):AiManagementSection{
  return available.find(s=>s===value)??available[0]??'attention';
}
/** Closed save outcomes; the page translates them. Free text from a query string is never displayed. */
export type AiManagementToast='saved'|'default';
export function aiManagementHref(section:AiManagementSection,extra:{q?:string;toast?:AiManagementToast;anchor?:string}={}):string{
  const params=new URLSearchParams({view:section});
  if(extra.q)params.set('q',extra.q.slice(0,100));
  if(extra.toast)params.set('toast',extra.toast);
  return `${AI_MANAGEMENT_PAGE}?${params.toString()}${extra.anchor??''}`;
}
