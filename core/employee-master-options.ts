import { and, asc, eq, inArray } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { visibleLabelIdsCondition } from './system-labels';
import { EMPLOYMENT_STATUSES } from './employment-status';
import { CATEGORY_EMPLOYMENT_COLUMN, CATEGORY_PERSON_COLUMN } from './profile-options';
import { masterReportFieldsTx } from './employee-master-access';
export type MasterChoice={value:string;label:string};
export async function employeeMasterOptions(ctx:SessionContext,companyIds:string[]){return withTenant(ctx,async tx=>{
 const fields=await masterReportFieldsTx(tx,ctx,companyIds),options:Record<string,MasterChoice[]>={};
 const [companies,departments,units,positions,grades,locations,profileOptions,leaveTypes]=await Promise.all([
  tx.select({value:schema.company.id,label:schema.company.legalName}).from(schema.company).where(inArray(schema.company.id,companyIds)).orderBy(asc(schema.company.legalName)),
  tx.select({value:schema.department.id,label:schema.department.name}).from(schema.department).where(visibleLabelIdsCondition(schema.department,'department',companyIds)).orderBy(asc(schema.department.name)),
  tx.select({value:schema.businessUnit.id,label:schema.businessUnit.name}).from(schema.businessUnit).where(visibleLabelIdsCondition(schema.businessUnit,'business_unit',companyIds)).orderBy(asc(schema.businessUnit.name)),
  tx.select({value:schema.position.id,label:schema.position.title}).from(schema.position).where(visibleLabelIdsCondition(schema.position,'position',companyIds)).orderBy(asc(schema.position.title)),
  tx.select({value:schema.jobGrade.id,label:schema.jobGrade.name}).from(schema.jobGrade).orderBy(asc(schema.jobGrade.name)),
  tx.select({value:schema.location.id,label:schema.location.name}).from(schema.location).where(inArray(schema.location.companyId,companyIds)).orderBy(asc(schema.location.name)),
  tx.select().from(schema.profileOption).orderBy(asc(schema.profileOption.sortOrder),asc(schema.profileOption.label),asc(schema.profileOption.id)),
  tx.select({value:schema.leaveType.id,label:schema.leaveType.name}).from(schema.leaveType).orderBy(asc(schema.leaveType.name)),
 ]);
 const refs:Record<string,MasterChoice[]>={companyName:companies,departmentName:departments,businessUnitName:units,positionName:positions,gradeName:grades,locationName:locations,leaveTypeName:leaveTypes};
 const enums:Record<string,readonly string[]>={employmentType:schema.employmentTypeEnum.enumValues,paymentMethod:schema.paymentMethodEnum.enumValues,attendancePhotoSetting:schema.attendancePhotoSettingEnum.enumValues,epfMode:schema.epfModeEnum.enumValues,epfCitizenship:schema.epfCitizenshipEnum.enumValues,zakatMethod:schema.zakatMethodEnum.enumValues};
 for(const field of fields){if(!['choice','status'].includes(field.type))continue;
  if(refs[field.ownerField])options[field.id]=refs[field.ownerField];
  else if(enums[field.ownerField])options[field.id]=enums[field.ownerField].map(value=>({value,label:value.replaceAll('_',' ')}));
  else if(field.owner==='employmentStatus')options[field.id]=[...EMPLOYMENT_STATUSES,...(field.scope!=='employment'?['draft']:[])].map(value=>({value,label:value.replaceAll('_',' ')}));
  else {const personCategory=Object.entries(CATEGORY_PERSON_COLUMN).find(([,columns])=>columns?.includes(field.ownerField as never))?.[0];const jobCategory=Object.entries(CATEGORY_EMPLOYMENT_COLUMN).find(([,columns])=>columns?.includes(field.ownerField as never))?.[0];const category=field.owner==='person'?personCategory:field.owner==='employment'?jobCategory:field.owner==='dependent'&&field.ownerField==='relationship'?'family_relationship':field.owner==='qualification'&&field.ownerField==='level'?'qualification_level':field.owner==='emergencyContact'&&field.ownerField==='relationship'?'relationship':null;
   if(category)options[field.id]=profileOptions.filter(option=>option.category===category).map(option=>({value:option.value,label:option.label}));
  }
 }
 return {companies,options};
});}
