'use server';
import { scopedSession } from '@/lib/scope';
import { publicErrorMessage } from '@/lib/public-error';
import { revalidatePath } from 'next/cache';
import { authorizeEmployeeMasterRun, deleteEmployeeMasterReport, duplicateEmployeeMasterReport, masterPreview, recordEmployeeMasterRun, runEmployeeMasterReport, saveEmployeeMasterReport } from '@/core/employee-master-reports';
import { rememberMasterSnapshot } from '@/core/employee-master-snapshots';
export async function previewEmployeeMaster(spec:unknown,id?:string,expectedVersion?:number){const {s,scopeIds,allowedCount}=await scopedSession();try{const run=await runEmployeeMasterReport(s,scopeIds,{spec,id,expectedVersion:id?expectedVersion:undefined,includeWithoutCompany:scopeIds.length===allowedCount});await authorizeEmployeeMasterRun(s,scopeIds,run);await recordEmployeeMasterRun(s,run,'preview',null);return {ok:true as const,result:masterPreview(run).result,snapshotToken:rememberMasterSnapshot(s,scopeIds,run)};}catch(error){return {ok:false as const,error:publicErrorMessage(error)};}}
export async function saveEmployeeMaster(input:Parameters<typeof saveEmployeeMasterReport>[2]){const {s,scopeIds}=await scopedSession();try{const saved=await saveEmployeeMasterReport(s,scopeIds,input);revalidatePath('/reports');revalidatePath('/reports/employee-master');return {ok:true as const,...saved};}catch(error){return {ok:false as const,error:publicErrorMessage(error)};}}
export async function duplicateEmployeeMaster(id:string){const {s,scopeIds}=await scopedSession();try{const saved=await duplicateEmployeeMasterReport(s,scopeIds,id);revalidatePath('/reports');return {ok:true as const,...saved};}catch(error){return {ok:false as const,error:publicErrorMessage(error)};}}
export async function deleteEmployeeMaster(id:string){const {s}=await scopedSession();try{await deleteEmployeeMasterReport(s,id);revalidatePath('/reports');return {ok:true as const};}catch(error){return {ok:false as const,error:publicErrorMessage(error)};}}
export async function saveMasterSchedule(input:Parameters<typeof import('@/core/employee-master-schedules').saveEmployeeMasterSchedule>[2]){
 const {s,scopeIds}=await scopedSession();try{const {saveEmployeeMasterSchedule}=await import('@/core/employee-master-schedules');await saveEmployeeMasterSchedule(s,scopeIds,input);revalidatePath('/reports');revalidatePath('/reports/employee-master/'+input.reportId);return {ok:true as const};}catch(error){return {ok:false as const,error:publicErrorMessage(error)};}
}

export async function masterScheduleRecipients(reportId:string){
 const {s,scopeIds}=await scopedSession();try{const {employeeMasterRecipientOptions}=await import('@/core/employee-master-schedules');return {ok:true as const,recipients:(await employeeMasterRecipientOptions(s,scopeIds,reportId)).map(({userId,employmentId,label})=>({userId,employmentId,label}))};}catch(error){return {ok:false as const,error:publicErrorMessage(error)};}
}
