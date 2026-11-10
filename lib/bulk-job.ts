/** Shared background bulk-job kernel: browser-safe states, progress shape and completion-notice copy keys.
 * The kernel itself is core/bulk-job.ts (admission, reads, cancel) and core/bulk-job-worker.ts (worker loop). */
export const BULK_JOB_ACTIVE_STATES=['queued','preparing','running','finalizing','discarding'] as const;
export type BulkJobActiveState=typeof BULK_JOB_ACTIVE_STATES[number];
export type BulkJobState=BulkJobActiveState|'completed'|'failed'|'cancelled';
export const bulkJobActive=(state:BulkJobState)=>(BULK_JOB_ACTIVE_STATES as readonly string[]).includes(state);
/** A row-level outcome kept on the job: identity and reason only, never IC, bank or salary values. */
export type BulkJobRowError={rowNum:number;ref:string;message:string};
/** Whether a worker serving the job's kind reported in recently. `unavailable` keeps the job visibly queued. */
export type BulkJobWorkerStatus='running'|'unavailable';
export type BulkJobProgress={
 id:string;kind:string;state:BulkJobState;phase:string|null;sourceName:string;
 stepsTotal:number;stepsDone:number;counters:Record<string,number>;
 error:string|null;errors:BulkJobRowError[];result:unknown;cancelRequested:boolean;
 createdAt:string;updatedAt:string;finishedAt:string|null;
};
export function bulkJobPercent(job:Pick<BulkJobProgress,'state'|'stepsDone'|'stepsTotal'>){
 if(job.state==='completed')return 100;
 return job.stepsTotal>0?Math.min(99,Math.floor(job.stepsDone/job.stepsTotal*100)):0;
}

/** Completion notice (ADR: shared bulk-job kernel). Stored as message KEYS and rendered in the reader's language by
 * the bell (components/notification-center.tsx), like the payroll cut-off reminder. One entry per kind: the
 * `bulkJobs.notification.<messages>` catalogue group and the Import History (or equivalent) page it opens. */
export const BULK_JOB_FINISHED_EVENT='bulk-job.finished';
export const BULK_JOB_NOTICE_KIND='bulk-job.finished';
export type BulkJobNoticeOutcome='completed'|'failed'|'cancelled';
export const BULK_JOB_NOTICES:Record<string,{messages:string;linkPath:string}>={
 employee_import:{messages:'employeeImport',linkPath:'/admin/personnel/import/history'},
 leave_ledger:{messages:'leaveImport',linkPath:'/admin/leave-config/import'},
 leave_generation:{messages:'leaveProcessing',linkPath:'/admin/leave-config/generate'},
 leave_accrual:{messages:'leaveProcessing',linkPath:'/admin/leave-config/earned-accrual'},
 roster_bulk:{messages:'roster',linkPath:'/roster'},
 schedule_group_bulk:{messages:'scheduleGroup',linkPath:'/admin/attendance/schedule-assignment/bulk'},
 clocking_import:{messages:'clockingImport',linkPath:'/attendance/import/logs'},
 attendance_recompute_preview:{messages:'attendanceRecomputePreview',linkPath:'/attendance/recompute'},
 attendance_recompute:{messages:'attendanceRecompute',linkPath:'/attendance/recompute'},
 payroll_process:{messages:'payrollProcess',linkPath:'/payroll'},
 system_label_import:{messages:'systemLabelImport',linkPath:'/admin/settings/system-labels'},
 section_import:{messages:'sectionImport',linkPath:'/admin/personnel/import'},
 register_import:{messages:'registerImport',linkPath:'/admin/personnel/import'},
 employee_import_revert:{messages:'employeeImportRevert',linkPath:'/admin/personnel/import/history'},
};
export function bulkJobNoticeKeys(kind:string,outcome:string){
 const notice=BULK_JOB_NOTICES[kind];
 const result=outcome==='completed'||outcome==='cancelled'?outcome:'failed';
 if(!notice)return null;
 return{title:`bulkJobs.notification.${notice.messages}.${result}.title`,body:`bulkJobs.notification.${notice.messages}.${result}.body`,linkPath:notice.linkPath};
}
/** Inverse of bulkJobNoticeKeys for the bell: only exact known keys are translated, anything else is shown as stored. */
export function parseBulkJobNoticeKey(key:string):{group:string;outcome:BulkJobNoticeOutcome;part:'title'|'body'}|null{
 const match=/^bulkJobs\.notification\.([a-zA-Z]+)\.(completed|failed|cancelled)\.(title|body)$/.exec(key);
 if(!match||!Object.values(BULK_JOB_NOTICES).some(n=>n.messages===match[1]))return null;
 return{group:match[1],outcome:match[2] as BulkJobNoticeOutcome,part:match[3] as 'title'|'body'};
}
