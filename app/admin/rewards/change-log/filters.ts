import {rewardConfigAreas,type RewardConfigArea} from '@/packs/rewards/config-change-model';
/** Search parameters to the change-log filter; unknown or malformed values are ignored, never trusted. */
export type ChangeLogParams={area?:string;company?:string;actor?:string;from?:string;to?:string;high?:string;page?:string};
const date=/^\d{4}-\d{2}-\d{2}$/,uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function changeLogFilter(p:ChangeLogParams){
 return{
  area:(rewardConfigAreas as readonly string[]).includes(p.area??'')?p.area as RewardConfigArea:undefined,
  companyId:p.company&&uuid.test(p.company)?p.company:undefined,
  actor:p.actor?.trim().slice(0,120)||undefined,
  from:p.from&&date.test(p.from)?p.from:undefined,to:p.to&&date.test(p.to)?p.to:undefined,
  highImpact:p.high==='1'?true:undefined,
  page:Math.min(10_000,Math.max(1,Number.parseInt(p.page??'1',10)||1)),
 };
}
export function changeLogQuery(p:ChangeLogParams,overrides:Partial<ChangeLogParams>={}){
 const q=new URLSearchParams();for(const [key,value] of Object.entries({...p,...overrides}))if(value)q.set(key,value);return q.toString();
}
