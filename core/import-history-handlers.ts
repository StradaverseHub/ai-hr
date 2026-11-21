/**
 * Revert handler registry (ADR-0155). Each import kind registers exactly one handler here; a kind with no
 * handler shows its history but offers no Revert. Explicit imports, no side-effect registration.
 */
import type {SessionContext} from '../db/client';
import type {ImportKind} from '../lib/import-history';
import {importAttemptKind,planImportRevert,previewImportRevert,revertImport,ImportHistoryError,type ImportRevertHandler} from './import-history';
import {movementRevertReviewWritesTx} from './movement-import-history';
import {withTenant} from '../db/client';
import {createMovementImportRevertJob} from './movement-import-revert-job';
import type {ImportRevertJobProgress} from '../lib/import-revert-job';
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
 * background job (core/employee-import-revert-job.ts). A movement import whose items only created movements is
 * reviewed the same way (its review only reads); one with Update or Delete items rehearses their compensation, so it
 * keeps the locked review. Other kinds keep their synchronous review. The revert itself re-checks everything under
 * its locks. */
export async function previewImportRevertForAttempt(ctx:SessionContext,attemptId:string){
 const handler=await handlerFor(ctx,attemptId);
 const lockFree=handler.kind==='employee_full'||(handler.kind==='movement'&&!await withTenant(ctx,tx=>movementRevertReviewWritesTx(tx,attemptId)));
 if(!lockFree)return previewImportRevert(ctx,attemptId,handler);
 const plan=await planImportRevert(ctx,attemptId,handler);
 return{attemptId,kind:plan.attempt.kind,eligible:plan.blockers.length===0,items:plan.inspection,blockers:plan.blockers,previewHash:plan.previewHash};
}
/** An employee import's and a movement import's revert run as background jobs (core/employee-import-revert-job.ts;
 * core/movement-import-revert-job.ts: a verified set-based release, with the synchronous revert as its whole-revert
 * fallback). Other kinds keep their synchronous revert. */
export async function revertImportForAttempt(ctx:SessionContext,attemptId:string,input:{previewHash:string;reason:string}):Promise<Awaited<ReturnType<typeof revertImport>>|{job:EmployeeImportRevertProgress|ImportRevertJobProgress}>{
 const handler=await handlerFor(ctx,attemptId);
 if(handler.kind==='employee_full')return{job:await createEmployeeImportRevertJob(ctx,attemptId,input)};
 if(handler.kind==='movement')return{job:await createMovementImportRevertJob(ctx,attemptId,input)};
 return revertImport(ctx,attemptId,handler,input);
}
