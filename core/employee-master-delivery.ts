/** Existing provision runner calls this bounded owner-only orchestration; canonical rendering stays in
 * the separately installed app-role child. No owner database handle crosses the rendering boundary. */
import {asc,sql} from 'drizzle-orm';
import type {createDb} from '../db/client';
import {customReportSchedule} from '../db/schema';
import {nextMasterScheduleAt} from '../lib/employee-master-schedule';
import {employeeMasterDeliveryIpc} from '../lib/employee-master-delivery-ipc';
import type {MasterDeliveryRequest} from '../lib/employee-master-delivery-model';
export type MasterReportTransport=<T>(request:MasterDeliveryRequest)=>Promise<T>;
export const MASTER_REPORT_DELIVERY_JOB='reports.employee-master.deliver' as const;
export async function sweepEmployeeMasterReports(owner:ReturnType<typeof createDb>['db'],options:{limit?:number;transport?:MasterReportTransport}={}){
 const limit=options.limit??10;if(!Number.isInteger(limit)||limit<1||limit>50)throw new Error('Report sweep limit must be between one and 50.');
 const transport=options.transport??employeeMasterDeliveryIpc;
 let ready=false;try{const status=await transport<{version:number;ready:boolean}>({op:'status'});ready=status?.version===1&&status.ready===true;}catch{}
 // Do not consume occurrences while the reviewed root service/renderer is not installed and ready.
 if(!ready)return {queued:0,attempted:0,sent:0,failed:0,skipped:0,uncertain:0,unavailable:true,cappedOut:false};
 const now=new Date(),due=await owner.select({id:customReportSchedule.id,config:customReportSchedule.config,scheduled:customReportSchedule.nextRunAt}).from(customReportSchedule).where(sql`${customReportSchedule.enabled}=true and ${customReportSchedule.nextRunAt}<=${now}`).orderBy(asc(customReportSchedule.nextRunAt),asc(customReportSchedule.id)).limit(limit);
 let queued=0;
 for(const schedule of due){if(!schedule.scheduled)continue;const next=nextMasterScheduleAt(schedule.config,now);const [row]=await owner.execute(sql`select identity_email.queue_report(${schedule.id}::uuid,${schedule.scheduled.toISOString()}::timestamptz,${next.toISOString()}::timestamptz) as added`) as unknown as {added:number}[];queued+=Number(row?.added??0);}
 const jobs=await owner.execute(sql`select * from identity_email.claim_reports(${limit})`) as unknown as {id:string;lease_token:string}[];
 const counts={queued,attempted:0,sent:0,failed:0,skipped:0,uncertain:0,unavailable:false,cappedOut:jobs.length===limit||due.length===limit};
 for(const job of jobs){counts.attempted++;try{const response=await transport<{outcome:string}>({op:'sendReport',occurrenceId:job.id,leaseToken:job.lease_token});if(['sent','failed','skipped','uncertain'].includes(response?.outcome))counts[response.outcome as 'sent'|'failed'|'skipped'|'uncertain']++;else if(response?.outcome==='unavailable')counts.unavailable=true;}catch{counts.unavailable=true;/* Worker may have accepted SMTP. Its durable started state governs reclaim, never retry here. */}}
 return counts;
}
