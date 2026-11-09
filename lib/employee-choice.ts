/** Navigation-only facts. These rows never authorize a command or bulk/export population. */
export type EmployeeChoice = {
 employmentId:string;name:string;employeeCode:string|null;company:string;companyId:string;
 department:string|null;departmentCode?:string|null;departmentId:string|null;
 businessUnit:string|null;businessUnitCode?:string|null;businessUnitId:string|null;status:'active'|'ended';
};
export type EmployeeChoiceInput={
 query?:string;companyId?:string;businessUnitId?:string;departmentId?:string;status?:'active'|'ended';
 offset?:number;limit?:number;selectedId?:string;labelMode?:'names'|'labels';
};
export type EmployeeChoiceFilters={query:string;companyId:string;businessUnitId:string;departmentId:string;status:string};
export type EmployeeChoicePage={
 contextId:string;rows:EmployeeChoice[];selected:EmployeeChoice|null;total:number;offset:number;limit:number;
 filters:EmployeeChoiceFilters;labelMode:'names'|'labels';
 companyOptions:{id:string;name:string}[];businessUnitOptions:{id:string;name:string}[];
 departmentOptions:{id:string;name:string}[];allDepartmentOptions:{id:string;name:string}[];
};
export const EMPLOYEE_CHOICE_PAGE_SIZE=25;
export const EMPLOYEE_CHOICE_MAX_PAGE_SIZE=200;
export function employeeChoiceKey(filters:EmployeeChoiceFilters,offset:number,labelMode:'names'|'labels'){
 return JSON.stringify([filters.query.trim().toLowerCase(),filters.companyId,filters.businessUnitId,filters.departmentId,filters.status,offset,labelMode]);
}
export function isEmployeeChoicePage(value:unknown):value is EmployeeChoicePage{
 if(!value||typeof value!=='object')return false;
 const p=value as EmployeeChoicePage;
 const choice=(row:EmployeeChoice)=>row&&typeof row.employmentId==='string'&&typeof row.name==='string'&&typeof row.company==='string'&&typeof row.companyId==='string'
  &&(row.employeeCode===null||typeof row.employeeCode==='string')&&['active','ended'].includes(row.status)
  &&['department','departmentId','businessUnit','businessUnitId'].every(k=>row[k as keyof EmployeeChoice]===null||typeof row[k as keyof EmployeeChoice]==='string');
 return typeof p.contextId==='string'&&Number.isSafeInteger(p.total)&&p.total>=0&&Number.isSafeInteger(p.offset)&&p.offset>=0
  &&Number.isInteger(p.limit)&&p.limit>=1&&p.limit<=EMPLOYEE_CHOICE_MAX_PAGE_SIZE&&Array.isArray(p.rows)&&p.rows.length<=p.limit&&p.rows.every(choice)
  &&(p.selected===null||choice(p.selected))&&p.total>=p.rows.length&&['names','labels'].includes(p.labelMode)
  &&Boolean(p.filters)&&['query','companyId','businessUnitId','departmentId','status'].every(k=>typeof p.filters[k as keyof EmployeeChoiceFilters]==='string')
  &&['companyOptions','businessUnitOptions','departmentOptions','allDepartmentOptions'].every(k=>Array.isArray(p[k as keyof EmployeeChoicePage])
   &&(p[k as 'companyOptions'] as {id:string;name:string}[]).every(row=>row&&typeof row.id==='string'&&typeof row.name==='string'));
}
