import type {IndividualImportMethod,TxnImportPreview,TxnImportRow} from './payroll-txn-import-schema';
import type {ImportActor} from './import-reference';
export type IndividualImportOutcome={row:TxnImportRow;state:'invalid'|'imported'|'failed';transactionId?:string;snapshot?:Record<string,unknown>;eventIds?:string[]};
/** 0ec0ee00 — importing/stopped/reverting: an import written, or reverted, in steps by the background worker. */
export type IndividualImportAttemptState='validated'|'importing'|'completed'|'stopped'|'reverting'|'reverted';
export type IndividualImportAttempt={id:string;sourceName:string;method:IndividualImportMethod;createdBy:string;createdAt:string;state:IndividualImportAttemptState;records:Record<string,string>[];preview:TxnImportPreview;outcomes:IndividualImportOutcome[];written:number;recalcBatchIds:string[];revertedAt:string|null;revertedBy:string|null;events?:{type:string;at:string;actorId:string|null;actor?:ImportActor;reason?:string}[];
 /** Board 8d02748a: readable labels for the people recorded on this attempt, and the batch it belongs to. */
 createdByActor?:ImportActor;revertedByActor?:ImportActor|null;jobId?:string|null;
 /** 0ec0ee00 — rows with a recorded outcome, and imported rows already removed by a revert. */
 processed?:number;revertedCount?:number};

/** 0ec0ee00 — an Import Log entry without its rows, so a 10,000-row batch opens without reading them. */
export type IndividualImportSummary={id:string;sourceName:string;method:IndividualImportMethod;createdAt:string;state:IndividualImportAttemptState;
 total:number;valid:number;invalid:number;processed:number;written:number;failed:number;revertedCount:number;
 fileError:string|null;revertedAt:string|null;periods:string[];cycles:string[];hasErrors:boolean;
 createdByActor?:ImportActor;revertedByActor?:ImportActor|null;jobId:string|null;
 events:{type:string;at:string;actorId:string|null;actor?:ImportActor;reason?:string}[]};

/** One row of an Import Log page: the uploaded values, the verdict, and its outcome once written. */
export type IndividualImportPageRow={rowNum:number;record:Record<string,string>|null;row:TxnImportRow|null;
 outcome:'valid'|'invalid'|'imported'|'failed'|'pending';snapshotUnit:string|null};
export type IndividualImportPage={rows:IndividualImportPageRow[];total:number;page:number;pages:number};
