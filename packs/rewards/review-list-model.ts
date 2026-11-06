import type {RewardReviewListRow} from './service';
export type RewardReviewFilters={cycle?:string;company?:string;unit?:string;businessGroup?:string;stage?:string;waiting?:string};
/** Filters only narrow rows already admitted by the native read; unknown values show an empty result. */
export function filterRewardReviews(rows:readonly RewardReviewListRow[],filters:RewardReviewFilters,groups:Readonly<Record<string,{groupId:string}>>={}){
 return rows.filter(row=>(!filters.businessGroup||groups[row.companyId]?.groupId===filters.businessGroup)&&(!filters.cycle||row.cycleId===filters.cycle)&&(!filters.company||row.companyId===filters.company)&&(!filters.unit||row.businessUnitId===filters.unit)&&(!filters.stage||(filters.stage==='returned'?!!row.returnedTo:row.status===filters.stage))&&(filters.waiting!=='1'||row.waiting));
}
export function rewardReviewUpcoming(rows:readonly RewardReviewListRow[]){
 const counts=new Map<string,number>();
 for(const row of rows)if(!row.waiting)for(const seat of new Set(row.laterSeats))counts.set(seat,(counts.get(seat)??0)+1);
 return [...counts].map(([seat,count])=>({seat,count}));
}
export function rewardReviewHref(filters:RewardReviewFilters){
 const query=new URLSearchParams(Object.entries(filters).filter(([,value])=>!!value) as [string,string][]).toString();
 return query?`/rewards?${query}`:'/rewards';
}
