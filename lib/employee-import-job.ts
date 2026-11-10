/** Employee import background job: shared states and presentation contract. */
export const EMPLOYEE_IMPORT_ACTIVE_STATES=['queued','validating','importing','activating','discarding'] as const;
export type EmployeeImportState=typeof EMPLOYEE_IMPORT_ACTIVE_STATES[number]|'completed'|'failed';
export type EmployeeImportPhase='employees'|'superiors'|'registers'|'activation';
export const employeeImportActive=(state:EmployeeImportState)=>(EMPLOYEE_IMPORT_ACTIVE_STATES as readonly string[]).includes(state);
/** Row-level outcome kept in job.errors: identity + reason only, never IC/bank/salary. */
export type EmployeeImportRowError={rowNum:number;email:string;fullName?:string;message:string};
/** `worker`: whether the import service is reporting in. A queued job with no worker stays visibly queued. */
export type EmployeeImportProgress={id:string;sourceName:string;state:EmployeeImportState;phase:EmployeeImportPhase|null;total:number;valid:number;invalid:number;stepsTotal:number;stepsDone:number;imported:number;attemptId:string|null;error:string|null;errors:EmployeeImportRowError[];result:EmployeeImportResultSummary|null;updatedAt:string;createdAt:string;worker?:'running'|'unavailable'};
/** Mirrors the fields of ImportResult the existing result panel renders. */
export type EmployeeImportResultSummary={companyId:string;imported:number;failed:{rowNum:number;email:string;message:string}[];skipped:number;dependentsImported:number;registersImported:{qualification:number;emergency:number};superiorFailed:{rowNum:number;email:string;message:string}[];fileErrors:string[];warnings:string[];runId:string|null;attemptId:string|null};
/** Stable code, translated on the screen, for an import refused because another one is still running. */
export const EMPLOYEE_IMPORT_ALREADY_RUNNING='employee-import-already-running';
export function employeeImportPercent(job:Pick<EmployeeImportProgress,'state'|'stepsDone'|'stepsTotal'>){
 if(job.state==='completed')return 100;
 return job.stepsTotal>0?Math.min(99,Math.floor(job.stepsDone/job.stepsTotal*100)):0;
}
