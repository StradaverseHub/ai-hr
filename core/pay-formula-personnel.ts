/** Tenant metadata and permitted list projection for the closed Personnel formula adapters. */
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {analyzePayFormula,type FormulaProgram} from '../lib/pay-formula-language';
import {PERSONNEL_FIELDS} from '../lib/personnel-field-registry';
import {PAY_FORMULA_PERSONNEL_ADAPTERS,PAY_FORMULA_PERSONNEL_INVENTORY,PAY_FORMULA_LEGACY_PERSONNEL_FIELDS,PAY_FORMULA_PERSONNEL_REGISTRY_VERSION,PAY_FORMULA_PERSONNEL_PROVIDER_VERSION,personnelFormulaAdapter,type PersonnelFormulaRegistration,type PersonnelFormulaLibraryField} from '../lib/pay-formula-personnel';
import {resolvePayrollPermission} from './payroll';
import {PayFormulaError} from '../lib/pay-formula-model';
export function personnelFormulaReferences(program:FormulaProgram){return [...new Map(analyzePayFormula(program).calls.flatMap(call=>{const adapter=personnelFormulaAdapter(call.code,String(call.args[0]?.value??''));return adapter?[[adapter.key,adapter] as const]:[];})).values()].sort((a,b)=>a.key.localeCompare(b.key));}
export async function loadPersonnelFormulaRegistrationsTx(tx:Tx){return tx.execute<PersonnelFormulaRegistration>(sql`select distinct on(source_key) id,source_key as "sourceKey",label,description,ordinal,enabled from pay_formula_personnel_registration where tenant_id=app.current_tenant_id() order by source_key,ordinal desc`);}
export async function personnelFormulaDependencyTx(tx:Tx,program:FormulaProgram,ctx?:SessionContext){
 const fields=personnelFormulaReferences(program);if(!fields.length)return undefined;
 if(ctx){
  const companies=await tx.execute<{id:string}>(sql`select id from company where tenant_id=${ctx.tenantId}::uuid and archived_at is null and app.can_admin_payroll_for(id)`);
  for(const adapter of fields){const field=PERSONNEL_FIELDS.find(f=>f.id===adapter.fieldId)!;const sensitivity=field.sensitivity,category=sensitivity==='payroll'?'compensation':sensitivity==='restricted'||sensitivity==='documents'?'confidential_hr':sensitivity==='identity'||sensitivity==='bank'||sensitivity==='statutory'?sensitivity:'personnel';let allowed=false;for(const company of companies)if(await resolvePayrollPermission(tx,ctx,`report.read.${category}`,company.id)){allowed=true;break;}if(!allowed)throw new PayFormulaError('Your field permission does not permit this Personnel source.','FORMULA_SOURCE_DENIED');}
 }
 const registrations=await loadPersonnelFormulaRegistrationsTx(tx);
 if(fields.some(field=>registrations.some(row=>row.sourceKey===field.key&&!row.enabled)))throw new PayFormulaError('A Personnel source is disabled. Choose an enabled source or ask the formula administrator to review its registration.');
 return {registry:PAY_FORMULA_PERSONNEL_REGISTRY_VERSION,provider:PAY_FORMULA_PERSONNEL_PROVIDER_VERSION,fields,registrations:registrations.filter(row=>fields.some(field=>field.key===row.sourceKey))};
}
export async function personnelFormulaLibraryTx(tx:Tx,ctx:SessionContext,companies:{id:string;name:string}[]):Promise<PersonnelFormulaLibraryField[]>{
 const registrations=await loadPersonnelFormulaRegistrationsTx(tx),permissions=new Map<string,boolean>();
 for(const sensitivity of new Set(PERSONNEL_FIELDS.map(field=>field.sensitivity))){const category=sensitivity==='payroll'?'compensation':sensitivity==='restricted'||sensitivity==='documents'?'confidential_hr':sensitivity==='identity'||sensitivity==='bank'||sensitivity==='statutory'?sensitivity:'personnel';let allowed=false;for(const company of companies)if(await resolvePayrollPermission(tx,ctx,`report.read.${category}`,company.id)){allowed=true;break;}permissions.set(sensitivity,allowed);}
 const catalogs=companies.length?await tx.execute<{sourceKey:string;value:string;label:string}>(sql`
 select 'departmentId' as "sourceKey",id::text as value,name||' · '||id::text as label from department where tenant_id=${ctx.tenantId}::uuid and archived_at is null and (company_id=any(${companies.map(c=>c.id)}::uuid[]) or is_global)
 union all select 'businessUnitId',id::text,coalesce(nullif(label,''),code)||' · '||id::text from business_unit where tenant_id=${ctx.tenantId}::uuid and archived_at is null and (company_id=any(${companies.map(c=>c.id)}::uuid[]) or is_global)
 union all select 'positionId',id::text,title||' · '||id::text from position where tenant_id=${ctx.tenantId}::uuid and archived_at is null and (company_id=any(${companies.map(c=>c.id)}::uuid[]) or is_global)
 order by "sourceKey",label`):[];
 return PAY_FORMULA_PERSONNEL_INVENTORY.map(field=>{
  const adapter=PAY_FORMULA_PERSONNEL_ADAPTERS.find(a=>a.fieldId===field.fieldId),legacy=Object.entries(PAY_FORMULA_LEGACY_PERSONNEL_FIELDS[field.group]).find(([,id])=>id===field.fieldId),registration=adapter?registrations.find(row=>row.sourceKey===adapter.key):undefined;
  const supported=!!adapter||!!legacy,permitted=permissions.get(field.sensitivity)===true,enabled=registration?.enabled!==false;
  const key=adapter?.key??legacy?.[0]??field.fieldId,sourceType=adapter?.type??(field.type==='date'?'date':'string');
  const unavailableReason=field.unavailableReason??(!supported?'adapter':!permitted?'permission':!enabled?'disabled':null);
  return {...field,key,label:registration?.label??field.label,description:registration?.description??`${field.section} · ${field.label}`,formulaType:sourceType,functionCode:field.group==='profile'?'EmployeeProfile':'EmployeeInformation',dateBasis:adapter?.dateBasis??'legacy-current-snapshot',enabled:supported&&permitted&&enabled,unavailableReason,listValues:key==='companyId'?companies.map(company=>({value:company.id,label:company.name+' · '+company.id})):catalogs.filter(row=>row.sourceKey===key).map(({value,label})=>({value,label}))};
 });
}
