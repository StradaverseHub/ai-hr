/** Fictional, metadata-only UI fixture. No employee source values or connected catalogues. */
import {PERSONNEL_FIELDS} from '../lib/personnel-field-registry';
import {PAY_FORMULA_PERSONNEL_ADAPTERS,type PersonnelFormulaLibraryField} from '../lib/pay-formula-personnel';
export function personnelFormulaLibraryFixture():PersonnelFormulaLibraryField[]{
 const row=(fieldId:string,key:string,reason:string|null=null):PersonnelFormulaLibraryField=>{
  const field=PERSONNEL_FIELDS.find(field=>field.id===fieldId)!;if(!field)throw new Error('Fixture descriptor missing');
  const adapter=PAY_FORMULA_PERSONNEL_ADAPTERS.find(adapter=>adapter.key===key);
  return {fieldId,key,label:field.label,labelKey:field.labelKey,section:field.section,group:field.tab==='Profile'?'employee':'profile',type:field.type,history:field.history,sensitivity:field.sensitivity,grain:field.grain,unavailableReason:reason,description:field.section+' · '+field.label,formulaType:adapter?.type??'string',functionCode:field.tab==='Profile'?'EmployeeInformation':'EmployeeProfile',dateBasis:adapter?.dateBasis??'current-only',enabled:reason===null,listValues:[]};
 };
 const company=row('employment.organisation_assignment.companyname','companyId');company.listValues=[{value:'10000000-0000-4000-8000-000000000001',label:'Example Operating Company · 10000000-0000-4000-8000-000000000001'},{value:'10000000-0000-4000-8000-000000000002',label:'Example Operating Company · 10000000-0000-4000-8000-000000000002'}];
 return [company,row('employment.employment_dates_and_service.probationvalue','employment.employment_dates_and_service.probationvalue'),row('employment.employment_dates_and_service.contractstartdate','employment.employment_dates_and_service.contractstartdate'),row('profile.emergency_contact.fullname','profile.emergency_contact.fullname','repeating'),row('profile.personal_details.fullname','profile.personal_details.fullname','permission')];
}
