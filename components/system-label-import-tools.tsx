import {requireAdmin} from '@/lib/authz';
import {labelMaintenanceCompanies} from '@/core/system-labels';
import {SystemLabelImport} from './system-label-import';
export async function SystemLabelImportTools(){
 const session=await requireAdmin(),companies=(await labelMaintenanceCompanies(session)).filter(company=>!company.archivedAt);
 return <SystemLabelImport companies={companies.map(company=>({id:company.id,name:company.name}))} selectedCompanyIds={companies.map(company=>company.id)}/>;
}
