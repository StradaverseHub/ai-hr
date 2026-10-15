import { scopedAdmin } from '@/lib/scope';
import { adminCompanies } from '@/core/read';
import { SystemLabelImport } from './system-label-import';
export async function SystemLabelImportTools(){
 const {s,scopeIds}=await scopedAdmin();
 const companies=await adminCompanies(s);
 return <SystemLabelImport companies={companies.map(c=>({id:c.id,name:c.name}))} selectedCompanyIds={scopeIds}/>;
}
