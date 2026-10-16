/** Existing provision runner calls this bounded owner-only orchestration; canonical rendering stays in
 * the separately installed app-role child. No owner database handle crosses the rendering boundary. */
import {and,asc,eq,inArray,lte,sql} from 'drizzle-orm';
import type {createDb} from '../db/client';
import {customReportSchedule} from '../db/schema';
import {nextMasterScheduleAt} from '../lib/employee-master-schedule';
import {employeeMasterDeliveryIpc} from '../lib/employee-master-delivery-ipc';
import {loadSweepScope} from './sweep-scope';
import {recordJobRun} from './job-run';
import type {MasterDeliveryRequest} from '../lib/employee-master-delivery-model';
export type MasterReportTransport=<T>(request:MasterDeliveryRequest)=>Promise<T>;
export const MASTER_REPORT_DELIVERY_JOB='reports.employee-master.deliver' as const;
export async function sweepEmployeeMasterReports(owner:ReturnType<typeof createDb>['db'],options:{limit?:number;transport?:MasterReportTransport}={}){
 const limit=options.limit??10;if(!Number.isInteger(limit)||limit<1||limit>50)throw new Error('Report sweep limit must be between one and 50.');
 const transport=options.transport??employeeMasterDeliveryIpc;
 let ready=false;try{const status=await transport<{version:number;ready:boolean}>({op:'status'});ready=status?.version===1&&status.ready===true;}catch{}
 // Do not consume occurrences while the reviewed root service/renderer is not installed and ready.
 if(!ready)return {queued:0,attempted:0,sent:0,failed:0,skipped:0,uncertain:0,unavailable:true,cappedOut:false,tenantsFailed:0};
 const startedAt=Date.now(),scope=await loadSweepScope(owner),failedTenants=new Set<string>();
 const now=new Date(),due=scope.run.length===0?[]:await owner.select({id:customReportSchedule.id,tenantId:customReportSchedule.tenantId,config:customReportSchedule.config,scheduled:customReportSchedule.nextRunAt}).from(customReportSchedule).where(and(inArray(customReportSchedule.tenantId,scope.run.map(tenant=>tenant.id)),eq(customReportSchedule.enabled,true),lte(customReportSchedule.nextRunAt,now))).orderBy(asc(customReportSchedule.nextRunAt),asc(customReportSchedule.id)).limit(limit);
 let queued=0;
 for(const schedule of due){
  if(!schedule.scheduled)continue;
  try{
   const next=nextMasterScheduleAt(schedule.config,now);
   const [row]=await owner.execute(sql`select identity_email.queue_report(${schedule.id}::uuid,${schedule.scheduled.toISOString()}::timestamptz,${next.toISOString()}::timestamptz) as added`) as unknown as {added:number}[];
   queued+=Number(row?.added??0);
  }catch{failedTenants.add(schedule.tenantId);}
 }
 const counts={queued,attempted:0,sent:0,failed:0,skipped:0,uncertain:0,unavailable:false,cappedOut:due.length===limit};
 for(let attempt=0;attempt<limit;attempt++){
  // A lease starts immediately before this attempt; later occurrences never wait behind rendering.
  const [job]=await owner.execute(sql`select * from identity_email.claim_reports(1)`) as unknown as {id:string;lease_token:string;tenant_id:string}[];
  if(!job)break;
  counts.attempted++;
  if(counts.attempted===limit)counts.cappedOut=true;
  try{
   const response=await transport<{outcome:string}>({op:'sendReport',occurrenceId:job.id,leaseToken:job.lease_token});
   if(['sent','failed','skipped','uncertain'].includes(response?.outcome)){
    counts[response.outcome as 'sent'|'failed'|'skipped'|'uncertain']++;
    if(response.outcome==='failed'||response.outcome==='uncertain')failedTenants.add(job.tenant_id);
   }
   else {counts.unavailable=true;failedTenants.add(job.tenant_id);break;}
  }catch{counts.unavailable=true;failedTenants.add(job.tenant_id);break;/* Durable started state governs reclaim; never retry SMTP here. */}
 }
 try{await recordJobRun(owner,{jobKey:MASTER_REPORT_DELIVERY_JOB,startedAt,tenantsProcessed:scope.run.length,tenantsFailed:failedTenants.size,tenantsSkipped:scope.skipped.length,result:{queued:counts.queued,attempted:counts.attempted,sent:counts.sent,failed:counts.failed,deliverySkipped:counts.skipped,uncertain:counts.uncertain,unavailable:Number(counts.unavailable),cappedOut:Number(counts.cappedOut)},error:counts.unavailable?'Private report delivery unavailable':failedTenants.size?'One or more report deliveries failed':null});}
 catch{console.error('Report delivery run log unavailable.');}
 return {...counts,tenantsFailed:failedTenants.size};
}
