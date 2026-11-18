/** Actor-neutral reminder projection. Both carriers supply only their own native
 * facts; entitlement/kill levers and task/window calculations keep canonical owners. */
import type {SessionContext} from '../../../db/client';
import {isModuleEnabled} from '../../../core/entitlements';
import {todayInKualaLumpur} from '../../../lib/hr-date';
import {assessmentReminderWork,type ReminderWorkGraph} from './reminder-work';
export function assessmentReminderProjectionWork(graph:ReminderWorkGraph|null,ctx:SessionContext,now:Date){
 if(!graph)return null;
 const companies=new Set(graph.reviews.map(r=>r.companyId));if(graph.cycle.companyId)companies.add(graph.cycle.companyId);for(const s of graph.sessions){if(s.companyId)companies.add(s.companyId);for(const e of s.entries)companies.add(e.companyId);}
 const enabled=new Set([...companies].filter(companyId=>isModuleEnabled(ctx,'performance',companyId)));if(!enabled.size&&!isModuleEnabled(ctx,'performance'))return null;
 return {graph,recipients:assessmentReminderWork(graph,enabled,now)};
}
export function assessmentReminderProjectionRoutes(rows:readonly{user_id:string;employment_id:string;company_id:string}[],ctx:SessionContext){
 const byUser=new Map<string,string>();for(const row of rows)if(!byUser.has(row.user_id)&&isModuleEnabled(ctx,'notifications',row.company_id))byUser.set(row.user_id,row.employment_id);return byUser;
}
export function assessmentReminderProjectionExpiry(now:Date,graph:ReminderWorkGraph|null,moduleExpiry:Date|null){
 const boundaries=Object.values(graph?.cycle.policy.windows??{}).flatMap(window=>[window?.opensAt,window?.closesAt]).filter((value):value is string=>!!value).map(Date.parse).filter(time=>time>now.getTime());
 return Math.min(now.getTime()+60_000,new Date(`${todayInKualaLumpur(now)}T23:59:59.999+08:00`).getTime(),moduleExpiry?new Date(moduleExpiry).getTime():Infinity,...boundaries);
}
