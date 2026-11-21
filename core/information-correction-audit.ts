/** Read old and current correction payloads without changing the immutable audit ledger.
 * Resolve all references in bounded sets, retaining labels captured by newer writers. */
import {and,eq,inArray} from 'drizzle-orm';
import type {Tx} from '../db/client';
import {company,jobGrade,department,position,businessUnit,employment,person} from '../db/schema';

type AuditRow={payload:unknown};
const object=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const referenceFields=['companyId','gradeId','departmentId','positionId','businessUnitId','managerEmploymentId'] as const;
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export async function correctionAuditLabelsTx<T extends AuditRow>(tx:Tx,tenantId:string,history:T[]):Promise<T[]>{
 const ids=new Map(referenceFields.map(field=>[field,new Set<string>()]));
 for(const event of history){const payload=object(event.payload);for(const side of ['before','after'])for(const field of referenceFields){
  const value=object(payload[side])[field];if(typeof value==='string'&&uuid.test(value))ids.get(field)!.add(value);
 }}
 const selected=(field:typeof referenceFields[number])=>[...ids.get(field)!];
 const [companies,grades,departments,positions,units,managers]=await Promise.all([
  ids.get('companyId')!.size?tx.select({id:company.id,label:company.legalName}).from(company).where(and(eq(company.tenantId,tenantId),inArray(company.id,selected('companyId')))):[],
  ids.get('gradeId')!.size?tx.select({id:jobGrade.id,label:jobGrade.name}).from(jobGrade).where(and(eq(jobGrade.tenantId,tenantId),inArray(jobGrade.id,selected('gradeId')))):[],
  ids.get('departmentId')!.size?tx.select({id:department.id,label:department.label,name:department.name}).from(department).where(and(eq(department.tenantId,tenantId),inArray(department.id,selected('departmentId')))):[],
  ids.get('positionId')!.size?tx.select({id:position.id,label:position.label,name:position.title}).from(position).where(and(eq(position.tenantId,tenantId),inArray(position.id,selected('positionId')))):[],
  ids.get('businessUnitId')!.size?tx.select({id:businessUnit.id,label:businessUnit.label,name:businessUnit.name}).from(businessUnit).where(and(eq(businessUnit.tenantId,tenantId),inArray(businessUnit.id,selected('businessUnitId')))):[],
  ids.get('managerEmploymentId')!.size?tx.select({id:employment.id,code:employment.employeeCode,label:person.fullName}).from(employment).innerJoin(person,and(eq(person.id,employment.personId),eq(person.tenantId,tenantId))).where(and(eq(employment.tenantId,tenantId),inArray(employment.id,selected('managerEmploymentId')))):[],
 ]);
 const named=(rows:{id:string;label:string|null;name:string|null}[])=>new Map(rows.map(row=>[row.id,row.label?.trim()||row.name]));
 const labels:Record<string,Map<string,string|null>>={companyId:new Map(companies.map(row=>[row.id,row.label])),gradeId:new Map(grades.map(row=>[row.id,row.label])),departmentId:named(departments),positionId:named(positions),businessUnitId:named(units),managerEmploymentId:new Map(managers.map(row=>[row.id,[row.code,row.label].filter(Boolean).join(' · ')]))};
 return history.map(event=>{const payload=object(event.payload),normalized={...payload};
  for(const side of ['before','after']){
   const values=object(payload[side]),captured=object(payload[side+'Labels']),resolved:Record<string,unknown>={...captured};
   for(const field of Array.isArray(payload.fields)?payload.fields:[]){
    if(typeof field!=='string'||Object.hasOwn(captured,field))continue;
    const value=values[field];resolved[field]=value==null?null:labels[field]?typeof value==='string'?labels[field].get(value)??null:null:typeof value==='string'||typeof value==='number'?String(value):null;
   }
   normalized[side+'Labels']=resolved;
  }
  return {...event,payload:normalized};
 });
}
