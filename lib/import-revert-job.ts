/** A background import Revert (core/movement-import-revert-job.ts): the browser-safe progress shape, the same as the
 * employee import revert job's on claude/bulkjob-register-20261110 (lib/employee-import-revert.ts). */
import type {BulkJobState} from './bulk-job';
export type ImportRevertJobBlocker={itemId:string;label:string;reason:string};
export type ImportRevertJobProgress={id:string;state:BulkJobState;attemptId:string;error:string|null;blockers:ImportRevertJobBlocker[];restored:number|null};
