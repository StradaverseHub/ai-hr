import type {probationSummaryRows} from '@/packs/probation/service';
export type TrackerFilters=NonNullable<Parameters<typeof probationSummaryRows>[1]>;
export function trackerFilters(query:Record<string,string|string[]|undefined>):TrackerFilters{
 const text=(key:string)=>typeof query[key]==='string'?query[key] as string:'';
 const id=(key:string)=>/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(text(key))?text(key):undefined;
 const offset=Number(text('offset'));
 const flag=text('flag');
 return{flag:['overdue','end_passed','ending14','low_result','kpi_submit','kpi_ack'].includes(flag)?flag as TrackerFilters['flag']:undefined,businessGroupId:id('businessGroupId'),businessUnitId:id('businessUnitId'),departmentId:id('departmentId'),pbpUserId:id('pbpUserId'),grade:text('grade').slice(0,40)||undefined,state:text('state').slice(0,40)||undefined,search:text('search').slice(0,100)||undefined,offset:Number.isSafeInteger(offset)&&offset>=0?Math.min(offset,100000):0,limit:50};
}
