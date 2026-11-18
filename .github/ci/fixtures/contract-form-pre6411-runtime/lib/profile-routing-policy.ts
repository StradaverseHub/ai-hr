/** One versioned tenant routing owner. Legacy policies keep their exact recorded meaning. */
export type ProfileRequestType='fields'|'photo';
export type ProfileRouteRule={id:string;name:string;approverEmploymentId:string;approverEmploymentIds?:string[];decisionMode?:'any';employeeSelection?:'allMatching'|'selected';employmentIds:string[];criteria:Record<string,string[]|string|number>;requestTypes?:ProfileRequestType[];excludedEmploymentIds?:string[];excludedCriteria?:Record<string,string[]|string|number>};
export type ProfileRoutingPolicy={version:1|2|3;enabled:boolean;revision:string;rules:ProfileRouteRule[]};
export const PROFILE_ROUTING_KEY='ess.profile_change_routing' as const;
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const ids=(value:unknown):value is string[]=>Array.isArray(value)&&value.length<=500&&value.every(uuid)&&new Set(value).size===value.length;
function criteria(value:unknown):boolean{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const entries=Object.entries(value);return entries.length<=64&&entries.every(([key,value])=>key.length<=100&&(typeof value==='string'&&value.length<=200||typeof value==='number'&&Number.isFinite(value)||Array.isArray(value)&&value.length<=500&&value.every(item=>typeof item==='string'&&item.trim().length>0&&item.length<=200)&&new Set(value).size===value.length));
}
export function profileRuleApprovers(rule:ProfileRouteRule):string[]{return rule.approverEmploymentIds??(rule.approverEmploymentId?[rule.approverEmploymentId]:[]);}
export function isProfileRoutingPolicy(raw:unknown):raw is ProfileRoutingPolicy{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return false;
 const p=raw as Record<string,unknown>;
 if(Object.keys(p).length!==4||![1,2,3].includes(Number(p.version))||typeof p.version!=='number'||typeof p.enabled!=='boolean'||!uuid(p.revision)||!Array.isArray(p.rules)||p.rules.length>32)return false;
 return p.rules.every(rule=>{
  if(!rule||typeof rule!=='object'||Array.isArray(rule)||Object.keys(rule).length!==(p.version===1?5:p.version===2?8:11)||!uuid(rule.id)||!uuid(rule.approverEmploymentId)||typeof rule.name!=='string'||!rule.name.trim()||rule.name.length>120||!ids(rule.employmentIds)||!criteria(rule.criteria))return false;
  if(p.version!==1&&(!ids(rule.excludedEmploymentIds)||!criteria(rule.excludedCriteria)||!Array.isArray(rule.requestTypes)||!rule.requestTypes.length||rule.requestTypes.length>2||rule.requestTypes.some((v:unknown)=>v!=='fields'&&v!=='photo')||new Set(rule.requestTypes).size!==rule.requestTypes.length))return false;
  if(p.version===3&&(!ids(rule.approverEmploymentIds)||rule.approverEmploymentIds.length<1||rule.approverEmploymentIds.length>32||rule.approverEmploymentId!==rule.approverEmploymentIds[0]||rule.decisionMode!=='any'||!['allMatching','selected'].includes(rule.employeeSelection)))return false;
  return true;
 })&&new Set(p.rules.map(rule=>rule.id)).size===p.rules.length;
}
/** Shape-only upgrade. No existing pending request is reassigned. */
export function editableProfileRoute(rule:ProfileRouteRule):ProfileRouteRule{return {...rule,approverEmploymentIds:profileRuleApprovers(rule),decisionMode:'any',employeeSelection:rule.employeeSelection??(rule.employmentIds.length?'selected':'allMatching'),requestTypes:rule.requestTypes??['fields','photo'],excludedEmploymentIds:rule.excludedEmploymentIds??[],excludedCriteria:rule.excludedCriteria??{}};}
export const EMPTY_PROFILE_ROUTING:ProfileRoutingPolicy={version:1,enabled:false,revision:'00000000-0000-0000-0000-000000000000',rules:[]};
