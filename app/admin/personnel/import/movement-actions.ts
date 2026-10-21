'use server';
import {revalidatePath} from 'next/cache';
import {requireAdmin} from '@/lib/authz';
import {movementImportCatalog,previewMovementImport,commitMovementImport} from '@/core/movement-import';
export async function movementCatalogAction(companyId:string){const catalog=await movementImportCatalog(await requireAdmin(),companyId);return {...catalog,fields:{departmentId:catalog.fields.departmentId,businessUnitId:catalog.fields.businessUnitId,gradeId:catalog.fields.gradeId,locationId:catalog.fields.locationId}};}
export async function previewMovementAction(companyId:string,csv:string,selection?:number[]){return previewMovementImport(await requireAdmin(),{companyId,csv,selection});}
export async function commitMovementAction(input:Parameters<typeof commitMovementImport>[1]){
 const {companyId,csv,selection,inputHash,fingerprints,acknowledgeExcluded}=input;
 const result=await commitMovementImport(await requireAdmin(),{companyId,csv,selection,inputHash,fingerprints,acknowledgeExcluded});
 if(result.imported){revalidatePath('/admin/personnel');revalidatePath('/admin/personnel/import');for(const employee of result.employees)if(employee.employmentId&&employee.rows.some(row=>row.status==='imported'))revalidatePath('/admin/personnel/'+employee.employmentId);}
 return result;
}
