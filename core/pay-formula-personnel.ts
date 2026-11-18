/** Tenant metadata and permitted list projection for the closed Personnel formula adapters. */
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {analyzePayFormula,type FormulaProgram} from '../lib/pay-formula-language';
import {PERSONNEL_FIELDS} from '../lib/personnel-field-registry';
import {PAY_FORMULA_PERSONNEL_ADAPTERS,PAY_FORMULA_PERSONNEL_INVENTORY,PAY_FORMULA_LEGACY_PERSONNEL_FIELDS,PAY_FORMULA_PERSONNEL_REGISTRY_VERSION,PAY_FORMULA_PERSONNEL_PROVIDER_VERSION,PAY_FORMULA_SHARED_FIELD_LABELS,PAY_FORMULA_BUSINESS_CODE_REGISTRY_VERSION,PAY_FORMULA_BUSINESS_CODE_PROVIDER_VERSION,personnelFormulaInternalId,personnelFormulaAdapter,type PersonnelFormulaRegistration,type PersonnelFormulaLibraryField} from '../lib/pay-formula-personnel';
import {personnelFormulaPermissionsTx} from './pay-formula-personnel-permissions';
import {personnelBusinessCodeChoicesTx,isPersonnelBusinessCode} from './pay-formula-business-codes';
import type {PayrollPermissionKey} from '../lib/payroll-permissions';
import {businessUnit,department,position} from '../db/schema';
import {visibleLabelIdsCondition} from './system-labels';
import {PayFormulaError} from '../lib/pay-formula-model';
export function personnelFormulaReferences(program:FormulaProgram){return [...new Map(analyzePayFormula(program).calls.flatMap(call=>{const adapter=personnelFormulaAdapter(call.code,String(call.args[0]?.value??''));return adapter?[[adapter.key,adapter] as const]:[];})).values()].sort((a,b)=>a.key.localeCompare(b.key));}
export async function loadPersonnelFormulaRegistrationsTx(tx:Tx){return tx.execute<PersonnelFormulaRegistration>(sql`select distinct on(source_key) id,source_key as "sourceKey",label,description,ordinal,enabled from pay_formula_personnel_registration where tenant_id=app.current_tenant_id() order by source_key,ordinal desc`);}
export async function personnelFormulaDependencyTx(tx:Tx,program:FormulaProgram,ctx?:SessionContext){
 const fields=personnelFormulaReferences(program);if(!fields.length)return undefined;
 if(ctx){
  const companies=await tx.execute<{id:string}>(sql`select id from company where tenant_id=${ctx.tenantId}::uuid and archived_at is null and app.can_admin_payroll_for(id)`);
  const keys=[...new Set(fields.map(adapter=>personnelPermissionKey(PERSONNEL_FIELDS.find(f=>f.id===adapter.fieldId)!.sensitivity)))];
  const permitted=await personnelFormulaPermissionsTx(tx,ctx,companies.map(company=>company.id),keys);
  for(const adapter of fields)if(!permitted.get(personnelPermissionKey(PERSONNEL_FIELDS.find(f=>f.id===adapter.fieldId)!.sensitivity))?.size)throw new PayFormulaError('Your field permission does not permit this Personnel source.','FORMULA_SOURCE_DENIED');
 }
 const registrations=await loadPersonnelFormulaRegistrationsTx(tx);
 if(fields.some(field=>registrations.some(row=>row.sourceKey===field.key&&!row.enabled)))throw new PayFormulaError('A Personnel source is disabled. Choose an enabled source or ask the formula administrator to review its registration.');
 return {registry:PAY_FORMULA_PERSONNEL_REGISTRY_VERSION,provider:PAY_FORMULA_PERSONNEL_PROVIDER_VERSION,fields,registrations:registrations.filter(row=>fields.some(field=>field.key===row.sourceKey)),...(fields.some(field=>field.adapter==='business-code')?{businessCodes:{registry:PAY_FORMULA_BUSINESS_CODE_REGISTRY_VERSION,provider:PAY_FORMULA_BUSINESS_CODE_PROVIDER_VERSION}}:{})};
}
export async function personnelFormulaLibraryTx(tx:Tx,ctx:SessionContext,companies:{id:string;name:string}[]):Promise<PersonnelFormulaLibraryField[]>{
 const registrations=await loadPersonnelFormulaRegistrationsTx(tx),permissions=new Map<string,boolean>(),categoryCompanies=new Map<string,string[]>();
 const keys=[...new Set(PERSONNEL_FIELDS.map(field=>personnelPermissionKey(field.sensitivity)))];
 const permitted=await personnelFormulaPermissionsTx(tx,ctx,companies.map(company=>company.id),keys);
 for(const field of PERSONNEL_FIELDS){const key=personnelPermissionKey(field.sensitivity);categoryCompanies.set(key.slice('report.read.'.length),[...(permitted.get(key)??[])]);permissions.set(field.sensitivity,!!permitted.get(key)?.size);}
 const personnelIds=categoryCompanies.get('personnel')??[],personnelCompanies=companies.filter(company=>personnelIds.includes(company.id));
 // Criteria is exclusively the System Labels owner's Global/saved-company predicate. A label's
 // creation company and legacy company sharing flags are not availability evidence.
 const listSources=[{key:'departmentId',kind:'department',table:department,name:sql`${department.name}`},{key:'businessUnitId',kind:'business_unit',table:businessUnit,name:sql`coalesce(nullif(${businessUnit.label},''),${businessUnit.code})`},{key:'positionId',kind:'position',table:position,name:sql`${position.title}`} ] as const;
 const selects=personnelIds.length?listSources.filter(source=>!registrations.some(row=>row.sourceKey===source.key&&!row.enabled)).map(source=>sql`select ${source.key} as "sourceKey",${source.table.id}::text as value,${source.name}||' · '||${source.table.id}::text as label from ${source.table} where ${source.table.tenantId}=${ctx.tenantId}::uuid and ${source.table.archivedAt} is null and ${visibleLabelIdsCondition(source.table,source.kind,personnelIds)}`):[];
 // With no Personnel field permission, no label catalogue SELECT is issued at all.
 const catalogs=selects.length?await tx.execute<{sourceKey:string;value:string;label:string}>(sql`${sql.join(selects,sql` union all `)} order by "sourceKey",label`):[];
 const codeCatalogues=new Map<string,Awaited<ReturnType<typeof personnelBusinessCodeChoicesTx>>>();
 for(const key of ['companyCode','businessUnitCode','departmentBusinessCode','positionBusinessCode','jobGradeCode']){
  if(personnelIds.length&&!registrations.some(row=>row.sourceKey===key&&!row.enabled))codeCatalogues.set(key,await personnelBusinessCodeChoicesTx(tx,ctx,personnelIds,key));
 }
 // One Personnel field can back several typed adapters (the company's internal ID, legal name and
 // code). Each adapter is its own library entry so authors can find the one they mean.
 return PAY_FORMULA_PERSONNEL_INVENTORY.flatMap(field=>{const shared=PAY_FORMULA_PERSONNEL_ADAPTERS.filter(a=>a.fieldId===field.fieldId);return (shared.length?shared:[undefined]).map(adapter=>({adapter,field:shared.length>1&&adapter&&PAY_FORMULA_SHARED_FIELD_LABELS[adapter.key]?{...field,label:PAY_FORMULA_SHARED_FIELD_LABELS[adapter.key],labelKey:'payFormula.fields.'+adapter.key}:field}));}).map(({adapter,field})=>{
  const legacy=Object.entries(PAY_FORMULA_LEGACY_PERSONNEL_FIELDS[field.group]).find(([,id])=>id===field.fieldId),registration=adapter?registrations.find(row=>row.sourceKey===adapter.key):undefined;
  const supported=!!adapter||!!legacy,permitted=permissions.get(field.sensitivity)===true,enabled=registration?.enabled!==false;
  const key=adapter?.key??legacy?.[0]??field.fieldId,sourceType=adapter?.type??(field.type==='date'?'date':'string');
  const unavailableReason=field.unavailableReason??(!supported?'adapter':!permitted?'permission':!enabled?'disabled':null);
  const usable=supported&&permitted&&enabled&&!unavailableReason;
  return {...field,key,...(adapter&&personnelFormulaInternalId(adapter)?{compatibility:true}:{}),...(codeCatalogues.has(key)?{codeValuesTotal:codeCatalogues.get(key)!.total}:{}),label:registration?.label??field.label,description:registration?.description??`${field.section} · ${field.label}`,formulaType:sourceType,functionCode:field.group==='profile'?'EmployeeProfile':'EmployeeInformation',dateBasis:adapter?.dateBasis??'legacy-current-snapshot',enabled:usable,unavailableReason,listValues:!usable?[]:codeCatalogues.has(key)?codeCatalogues.get(key)!.items:key==='companyId'?personnelCompanies.map(company=>({value:company.id,label:company.name+' · '+company.id})):catalogs.filter(row=>row.sourceKey===key).map(({value,label})=>({value,label}))};
 });
}

/** Provider-safe authoring vocabulary only: no employee reads, catalogue labels, source values or
 * administrator-authored registration text. Native admission owns the surrounding locks/entitlements. */
export async function payFormulaPermittedDraftFieldsTx(tx:Tx,ctx:SessionContext):Promise<{profile:string[];employee:string[]}>{
 const permitted={profile:[] as string[],employee:[] as string[]};if(!ctx.userId)return permitted;
 const companies=await tx.execute<{id:string}>(sql`select id from company where tenant_id=${ctx.tenantId}::uuid and archived_at is null and app.principal_snapshot_current() and app.pay_formula_catalog_access() and app.can_admin_payroll_for(id) order by id`);
 if(!companies.length)return permitted;
 // Read only the registration state needed for admission. Private labels/descriptions never enter
 // this projection, including when an enabled registration changes the UI's display vocabulary.
 const registrations=await tx.execute<{sourceKey:string;enabled:boolean}>(sql`select distinct on(source_key) source_key as "sourceKey",enabled from pay_formula_personnel_registration where tenant_id=${ctx.tenantId}::uuid order by source_key,ordinal desc`);
 const disabledKeys=new Set(registrations.filter(row=>!row.enabled).map(row=>row.sourceKey));
 const disabledLegacyFields=new Set(PAY_FORMULA_PERSONNEL_ADAPTERS.filter(adapter=>disabledKeys.has(adapter.key)).map(adapter=>adapter.fieldId));
 const candidates=[...(['profile','employee'] as const).flatMap(group=>Object.entries(PAY_FORMULA_LEGACY_PERSONNEL_FIELDS[group]).map(([key,fieldId])=>({group,key,fieldId,legacy:true}))),...PAY_FORMULA_PERSONNEL_ADAPTERS.map(adapter=>({group:adapter.group,key:adapter.key,fieldId:adapter.fieldId,legacy:false}))];
 const permissionKeys=[...new Set(PERSONNEL_FIELDS.map(field=>personnelPermissionKey(field.sensitivity)))];
 const permissions=await personnelFormulaPermissionsTx(tx,ctx,companies.map(company=>company.id),permissionKeys);
 for(const candidate of candidates){
  if(disabledKeys.has(candidate.key)||candidate.legacy&&disabledLegacyFields.has(candidate.fieldId))continue;
  const field=PERSONNEL_FIELDS.find(field=>field.id===candidate.fieldId);if(!field)continue;
  if(permissions.get(personnelPermissionKey(field.sensitivity))?.size)permitted[candidate.group].push(candidate.key);
 }
 return {profile:[...new Set(permitted.profile)].sort(),employee:[...new Set(permitted.employee)].sort()};
}

const personnelPermissionKey=(sensitivity:string):PayrollPermissionKey=>'report.read.'+(sensitivity==='payroll'?'compensation':sensitivity==='restricted'||sensitivity==='documents'?'confidential_hr':sensitivity==='identity'||sensitivity==='bank'||sensitivity==='statutory'?sensitivity:'personnel') as PayrollPermissionKey;

/** Fresh-authority, SQL-paged code choices; no employee record or registration text is returned. */
export async function personnelFormulaCodePageTx(tx:Tx,ctx:SessionContext,input:{key:string;search?:string;offset?:number}){
 if(!isPersonnelBusinessCode(input.key))throw new PayFormulaError('Choose a supported business-code field.');
 const registrations=await loadPersonnelFormulaRegistrationsTx(tx);
 if(registrations.some(row=>row.sourceKey===input.key&&!row.enabled))throw new PayFormulaError('This Personnel source is disabled.');
 const companies=await tx.execute<{id:string}>(sql`select id from company where tenant_id=${ctx.tenantId}::uuid and archived_at is null and app.can_admin_payroll_for(id) order by id`);
 const permitted=await personnelFormulaPermissionsTx(tx,ctx,companies.map(company=>company.id),['report.read.personnel']);
 return personnelBusinessCodeChoicesTx(tx,ctx,[...(permitted.get('report.read.personnel')??[])],input.key,input.search,input.offset);
}
