/** Movement import background job (shared bulk-job kernel): browser-safe states and the progress contract. */
import type {MovementImportResult} from './movement-import-contract';

export const MOVEMENT_IMPORT_ACTIVE_STATES=['queued','validating','importing','finishing'] as const;
export type MovementImportJobState=typeof MOVEMENT_IMPORT_ACTIVE_STATES[number]|'completed'|'failed'|'cancelled';
export const movementImportJobActive=(state:MovementImportJobState)=>(MOVEMENT_IMPORT_ACTIVE_STATES as readonly string[]).includes(state);
/** What the synchronous confirmation returned; the finished job carries the same result. */
export type MovementImportJobResult=MovementImportResult&{attemptId:string;alreadyCommitted:boolean};
/** One step is one employee. `imported`/`failed` count movements, as the result does. `worker`: whether the import
 * service is reporting in; a queued job with no worker stays visibly queued. */
export type MovementImportJobProgress={id:string;sourceName:string;state:MovementImportJobState;stepsTotal:number;stepsDone:number;imported:number;failed:number;
 attemptId:string|null;error:string|null;result:MovementImportJobResult|null;updatedAt:string;createdAt:string;worker?:'running'|'unavailable'};
/** Stable code, translated on the screen, for a confirmation refused because the same person's movement import is
 * still running. */
export const MOVEMENT_IMPORT_ALREADY_RUNNING='movement-import-already-running';
export function movementImportJobPercent(job:Pick<MovementImportJobProgress,'state'|'stepsDone'|'stepsTotal'>){
 if(job.state==='completed')return 100;
 return job.stepsTotal>0?Math.min(99,Math.floor(job.stepsDone/job.stepsTotal*100)):0;
}
