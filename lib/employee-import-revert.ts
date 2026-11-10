/** Employee import Revert as a background job (core/employee-import-revert-job.ts): the browser-safe progress shape. */
import type {BulkJobState} from './bulk-job';
export type EmployeeImportRevertBlocker={itemId:string;label:string;reason:string};
export type EmployeeImportRevertProgress={id:string;state:BulkJobState;attemptId:string;error:string|null;blockers:EmployeeImportRevertBlocker[];restored:number|null};
