/**
 * Revert handler registry (ADR-0155). Each import kind registers exactly one handler here; a kind with no
 * handler shows its history but offers no Revert. Explicit imports, no side-effect registration.
 */
import type {SessionContext} from '../db/client';
import type {ImportKind} from '../lib/import-history';
import {importAttemptKind,planImportRevert,previewImportRevert,revertImport,ImportHistoryError,type ImportRevertHandler} from './import-history';
import {costAllocationRevertHandler} from './cost-allocation-import';
import {bankStatutoryRevertHandler} from './bank-statutory-import';
import {movementRevertHandler} from './movement-import-history';
import {employeeFullRevertHandler} from './employee-import-history';
import {createEmployeeImportRevertJob,type EmployeeImportRevertProgress} from './employee-import-revert-job';

export const IMPORT_REVERT_HANDLERS:Readonly<Partial<Record<ImportKind,ImportRevertHandler>>>={
 cost_allocations:costAllocationRevertHandler,
 bank_statutory:bankStatutoryRevertHandler,
 movement:movementRevertHandler,
 employee_full:employeeFullRevertHandler,
};
export const importKindRevertible=(kind:ImportKind)=>!!IMPORT_REVERT_HANDLERS[kind];
async function handlerFor(ctx:SessionContext,attemptId:string){
 const kind=await importAttemptKind(ctx,attemptId),handler=kind?IMPORT_REVERT_HANDLERS[kind]:undefined;
 if(!handler)throw new ImportHistoryError('This import cannot be reverted.');return handler;
}
/** The employee import's review reads one snapshot without its writer locks (it writes nothing); its revert runs as a
 * background job (core/employee-import-revert-job.ts). Other kinds keep their synchronous review and revert. */
export async function previewImportRevertForAttempt(ctx:SessionContext,attemptId:string){
 const handler=await handlerFor(ctx,attemptId);
 if(handler.kind!=='employee_full')return previewImportRevert(ctx,attemptId,handler);
 const plan=await planImportRevert(ctx,attemptId,handler);
 return{attemptId,kind:plan.attempt.kind,eligible:plan.blockers.length===0,items:plan.inspection,blockers:plan.blockers,previewHash:plan.previewHash};
}
export async function revertImportForAttempt(ctx:SessionContext,attemptId:string,input:{previewHash:string;reason:string}):Promise<Awaited<ReturnType<typeof revertImport>>|{job:EmployeeImportRevertProgress}>{
 const handler=await handlerFor(ctx,attemptId);
 if(handler.kind==='employee_full')return{job:await createEmployeeImportRevertJob(ctx,attemptId,input)};
 return revertImport(ctx,attemptId,handler,input);
}
