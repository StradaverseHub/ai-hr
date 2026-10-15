import { scopedAdmin } from '@/lib/scope';
import { allowedCompanies } from '@/core/read';
import { SystemLabelImport } from './system-label-import';
export async function SystemLabelImportTools(){
 const {s,scopeIds}=await scopedAdmin();
 const companies=await allowedCompanies(s);
 return <SystemLabelImport companies={companies.map(c=>({id:c.id,name:c.name}))} selectedCompanyIds={scopeIds}/>;
}
