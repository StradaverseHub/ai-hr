/** Thin Workforce navigation facts; never command authority. */
export type WorkforceChoice={employmentId:string;name:string;employeeCode:string|null;companyId:string};
export type WorkforceChoiceInput={subjectId:string;companyId?:string;query?:string;offset?:number;selectedIds?:string[]};
export type WorkforceChoicePage={rows:WorkforceChoice[];selected:WorkforceChoice[];total:number;offset:number;limit:number};
export class WorkforceChoiceInputError extends Error{}
export class WorkforceChoiceAccessError extends Error{}
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export function workforceChoiceInput(value:unknown):WorkforceChoiceInput{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new WorkforceChoiceInputError();
 const p=value as WorkforceChoiceInput;
 if(Object.keys(p).some(k=>!['subjectId','companyId','query','offset','selectedIds'].includes(k))
  ||typeof p.subjectId!=='string'||!uuid.test(p.subjectId)
  ||p.companyId!==undefined&&(typeof p.companyId!=='string'||!uuid.test(p.companyId))
  ||p.query!==undefined&&(typeof p.query!=='string'||p.query.length>200)
  ||p.offset!==undefined&&(!Number.isSafeInteger(p.offset)||p.offset<0||p.offset>2147483647)
  ||p.selectedIds!==undefined&&(!Array.isArray(p.selectedIds)||p.selectedIds.length>8||p.selectedIds.some(id=>typeof id!=='string'||!uuid.test(id))))throw new WorkforceChoiceInputError();
 return {...p,selectedIds:p.selectedIds?.slice()};
}
