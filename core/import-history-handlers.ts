/**
 * Revert handler registry (ADR-0155). Each import kind registers exactly one handler here; a kind with no
 * handler shows its history but offers no Revert. Explicit imports, no side-effect registration.
 */
import type {SessionContext} from '../db/client';
import type {ImportKind} from '../lib/import-history';
import {importAttemptKind,planImportRevert,previewImportRevert,revertImport,ImportHistoryError,type ImportRevertHandler} from './import-history';
import {movementRevertReviewWritesTx} from './movement-import-history';
import {withTenant} from '../db/client';
import {costAllocationRevertHandler} from './cost-allocation-import';
import {bankStatutoryRevertHandler} from './bank-statutory-import';
import {movementRevertHandler} from './movement-import-history';
import {employeeFullRevertHandler} from './employee-import-history';

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
/** A movement import whose items only created movements is reviewed on one read-only snapshot with no writer lock (its
 * review only reads). One with Update or Delete items rehearses their compensation, so it keeps the locked review.
 * Other kinds keep their review. The revert itself re-checks everything under its locks. */
export async function previewImportRevertForAttempt(ctx:SessionContext,attemptId:string){
 const handler=await handlerFor(ctx,attemptId);
 if(handler.kind!=='movement'||await withTenant(ctx,tx=>movementRevertReviewWritesTx(tx,attemptId)))return previewImportRevert(ctx,attemptId,handler);
 const plan=await planImportRevert(ctx,attemptId,handler);
 return{attemptId,kind:plan.attempt.kind,eligible:plan.blockers.length===0,items:plan.inspection,blockers:plan.blockers,previewHash:plan.previewHash};
}
export async function revertImportForAttempt(ctx:SessionContext,attemptId:string,input:{previewHash:string;reason:string}){return revertImport(ctx,attemptId,await handlerFor(ctx,attemptId),input);}
