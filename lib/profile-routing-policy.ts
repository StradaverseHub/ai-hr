/** Stored in the existing tenant setting owner; designation never creates a role grant. */
export type ProfileRouteRule={id:string;name:string;approverEmploymentId:string;employmentIds:string[];criteria:Record<string,string[]|string|number>};
export type ProfileRoutingPolicy={version:1;enabled:boolean;revision:string;rules:ProfileRouteRule[]};
export const PROFILE_ROUTING_KEY='ess.profile_change_routing' as const;
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export function isProfileRoutingPolicy(raw:unknown):raw is ProfileRoutingPolicy{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return false;
 const p=raw as Record<string,unknown>;
 if(Object.keys(p).length!==4||p.version!==1||typeof p.enabled!=='boolean'||!uuid(p.revision)||!Array.isArray(p.rules)||p.rules.length>32)return false;
 return p.rules.every(rule=>{
  if(!rule||typeof rule!=='object'||Array.isArray(rule)||Object.keys(rule).length!==5||!uuid(rule.id)||!uuid(rule.approverEmploymentId)||typeof rule.name!=='string'||!rule.name.trim()||rule.name.length>120||!Array.isArray(rule.employmentIds)||rule.employmentIds.length>500||!rule.employmentIds.every(uuid)||new Set(rule.employmentIds).size!==rule.employmentIds.length||!rule.criteria||typeof rule.criteria!=='object'||Array.isArray(rule.criteria))return false;
  const entries=Object.entries(rule.criteria);return entries.length<=64&&entries.every(([key,value])=>key.length<=100&&(typeof value==='string'&&value.length<=200||typeof value==='number'&&Number.isFinite(value)||Array.isArray(value)&&value.length<=500&&value.every(item=>typeof item==='string'&&item.trim().length>0&&item.length<=200)&&new Set(value).size===value.length));
 })&&new Set(p.rules.map(rule=>rule.id)).size===p.rules.length;
}
export const EMPTY_PROFILE_ROUTING:ProfileRoutingPolicy={version:1,enabled:false,revision:'00000000-0000-0000-0000-000000000000',rules:[]};
