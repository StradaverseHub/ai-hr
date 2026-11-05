import type {probationSummaryRows} from '@/packs/probation/service';
export type TrackerFilters=NonNullable<Parameters<typeof probationSummaryRows>[1]>;
export function trackerFilters(query:Record<string,string|string[]|undefined>):TrackerFilters{
 const text=(key:string)=>typeof query[key]==='string'?query[key] as string:'';
 const id=(key:string)=>/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(text(key))?text(key):undefined;
 const offset=Number(text('offset'));
 const flag=text('flag');
 return{flag:['overdue','end_passed','ending14','low_result','kpi_submit','kpi_ack'].includes(flag)?flag as TrackerFilters['flag']:undefined,businessGroupId:id('businessGroupId'),businessUnitId:id('businessUnitId'),departmentId:id('departmentId'),grade:text('grade').slice(0,40)||undefined,search:text('search').trim().slice(0,100)||undefined,offset:Number.isSafeInteger(offset)&&offset>=0?Math.min(offset,100000):0,limit:50};
}

export function cascadingTrackerChoices(options:import('@/packs/probation/service').ProbationTrackerOptions,filters:TrackerFilters){
 const facets=options.facets;if(!facets)return options;
 const groups=facets.filter(row=>!filters.businessGroupId||row.businessGroupId===filters.businessGroupId);
 const units=groups.filter(row=>!filters.businessUnitId||row.businessUnitId===filters.businessUnitId);
 const departments=units.filter(row=>!filters.departmentId||row.departmentId===filters.departmentId);
 return {...options,businessUnits:options.businessUnits.filter(row=>groups.some(f=>f.businessUnitId===row.id)),departments:options.departments.filter(row=>units.some(f=>f.departmentId===row.id)),grades:options.grades.filter(grade=>departments.some(f=>f.grade===grade))};
}
