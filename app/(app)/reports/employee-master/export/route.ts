import {getLocale} from 'next-intl/server';
import {employeeMasterFieldLabels} from '@/lib/employee-master-field-labels';
import { scopedSession } from '@/lib/scope';
import { authorizeEmployeeMasterRun, recordEmployeeMasterRun, runEmployeeMasterReport } from '@/core/employee-master-reports';
import { employeeMasterSnapshot } from '@/core/employee-master-snapshots';
import { serializeEmployeeMaster, type MasterExportFormat } from '@/lib/employee-master-export';
export const runtime='nodejs';
export async function POST(request:Request){
 const {s,scopeIds,allowedCount}=await scopedSession();
 try{const body=await request.json() as {id?:string;spec?:unknown;format?:MasterExportFormat;snapshotToken?:string};if(!['xlsx','csv','pdf'].includes(body.format??''))return new Response('Invalid format',{status:400});
  const run=body.snapshotToken?await employeeMasterSnapshot(s,scopeIds,body.snapshotToken,{id:body.id,spec:body.spec}):await runEmployeeMasterReport(s,scopeIds,{id:body.id,spec:body.spec,includeWithoutCompany:scopeIds.length===allowedCount});
  const file=await serializeEmployeeMaster(run.result,run.spec,await employeeMasterFieldLabels(run.catalogue,await getLocale()),run.name,body.format!,run.brand);await authorizeEmployeeMasterRun(s,scopeIds,run);await recordEmployeeMasterRun(s,run,'export',body.format!);
  return new Response(new Uint8Array(file.bytes),{headers:{'Content-Type':file.contentType,'Content-Disposition':`attachment; filename="${file.filename}"`,'Cache-Control':'private, no-store'}});
 }catch{return new Response('Report generation or access changed. Refresh the preview and try again.',{status:400});}
}
