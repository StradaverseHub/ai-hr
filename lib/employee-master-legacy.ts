/** Closed compatibility mapping for the former 13-field Master report. Unmapped legacy fields refuse
 * with a review message; they never fall back to an unguarded salary export. */
import type { CustomReportSpec } from '../db/schema';
import { PERSONNEL_FIELDS } from './personnel-field-registry';
import { defaultMasterColumn, type EmployeeMasterSpec, type MasterExpression } from './employee-master-report';
const mappings:Record<string,[string,string]>={employeeCode:['employment','employeeCode'],name:['person','fullName'],email:['person','primaryEmail'],company:['assignment','companyName'],department:['assignment','departmentName'],position:['assignment','positionName'],status:['employmentStatus','status'],employmentType:['assignment','employmentType'],hiredOn:['employment','hiredOn'],terminatedOn:['employment','terminatedOn'],basicSalary:['compensation','basicSalary'],currency:['compensation','currency']};
export function legacyMasterField(id:string){const mapping=mappings[id];return mapping?PERSONNEL_FIELDS.find(field=>field.owner===mapping[0]&&field.ownerField===mapping[1]):undefined;}
export function legacyEmployeeMasterSpec(spec:CustomReportSpec,companyIds:string[],today:string):EmployeeMasterSpec{
 if(spec.employeeMaster)return spec.employeeMaster;
 const field=(id:string)=>{const field=legacyMasterField(id);if(!field)throw new Error('This legacy Employee Master report contains an unsupported field. Review it in the new builder before running.');return field;};
 const children:MasterExpression[]=Object.entries(spec.filters??{}).filter(([,value])=>value!==null&&value!=='').map(([id,value],index)=>({id:'legacy'+index,type:'condition',field:field(id).id,operator:'contains',value:String(value)}));
 return {v:2,asAt:today,companyIds,includeDrafts:false,columns:spec.columns.map(id=>({...defaultMasterColumn(field(id)),header:undefined,sum:spec.layout?.summary?.includes(id)??false,freeze:spec.layout?.freeze?.includes(id)??false})),expression:{id:'root',type:'group',logic:'and',children},sorts:spec.sort?[{field:field(spec.sort.field).id,dir:spec.sort.dir}]:[],groups:spec.groupBy?[field(spec.groupBy).id]:[],pdf:{paper:spec.layout?.paperSize??'A4',orientation:spec.layout?.orientation??'landscape',margins:spec.layout?.margins??'normal',logo:false,pageBreakGroups:!!spec.layout?.pageBreakOn}};
}
