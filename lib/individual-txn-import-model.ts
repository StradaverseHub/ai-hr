import type {IndividualImportMethod,TxnImportPreview,TxnImportRow} from './payroll-txn-import-schema';
import type {ImportActor} from './import-reference';
export type IndividualImportOutcome={row:TxnImportRow;state:'invalid'|'imported'|'failed';transactionId?:string;snapshot?:Record<string,unknown>;eventIds?:string[]};
export type IndividualImportAttempt={id:string;sourceName:string;method:IndividualImportMethod;createdBy:string;createdAt:string;state:'validated'|'completed'|'reverted';records:Record<string,string>[];preview:TxnImportPreview;outcomes:IndividualImportOutcome[];written:number;recalcBatchIds:string[];revertedAt:string|null;revertedBy:string|null;events?:{type:string;at:string;actorId:string|null;actor?:ImportActor;reason?:string}[];
 /** Board 8d02748a: readable labels for the people recorded on this attempt, and the batch it belongs to. */
 createdByActor?:ImportActor;revertedByActor?:ImportActor|null;jobId?:string|null};
