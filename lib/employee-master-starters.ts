import { defaultMasterColumn, type EmployeeMasterSpec, type MasterExpression } from './employee-master-report';
import type { PersonnelFieldDescriptor } from './personnel-field-registry';
export const MASTER_STARTERS=['headcount','newHires','resigned','contractExpiry'] as const;
export function employeeMasterStarter(fields:readonly PersonnelFieldDescriptor[],companyIds:string[],today:string,starter:string='headcount'):EmployeeMasterSpec{
 const find=(owner:string,name:string)=>fields.find(field=>field.owner===owner&&field.ownerField===name&&field.report.enabled);
 const selected=[find('employment','employeeCode'),find('person','fullName'),find('assignment','companyName'),find('assignment','departmentName'),find('assignment','positionName'),find('employmentStatus','status'),find('employment','hiredOn')].filter((field):field is PersonnelFieldDescriptor=>!!field);
 const expressions:MasterExpression[]=[],status=find('employmentStatus','status'),hire=find('employment','hiredOn'),end=find('employment','contractEndDate');
 if(starter==='resigned'&&status)expressions.push({id:'status',type:'condition',field:status.id,operator:'eq',value:'resigned'});
 if(starter==='headcount'&&status)expressions.push({id:'status',type:'condition',field:status.id,operator:'in',values:['active','probation','active_serving_notice']});
 if(starter==='newHires'&&hire)expressions.push({id:'hire',type:'condition',field:hire.id,operator:'between',value:today.slice(0,7)+'-01',upper:today});
 if(starter==='contractExpiry'&&end){const last=new Date(today+'T00:00:00Z');last.setUTCDate(last.getUTCDate()+30);expressions.push({id:'expiry',type:'condition',field:end.id,operator:'between',value:today,upper:last.toISOString().slice(0,10)});selected.push(end);}
 return {v:2,asAt:today,companyIds,includeDrafts:false,columns:selected.map(defaultMasterColumn),expression:{id:'root',type:'group',logic:'and',children:expressions},sorts:[],groups:[],pdf:{paper:'A4',orientation:'landscape',margins:'normal',logo:false,pageBreakGroups:false}};
}
