/**
 * Revert handler registry (ADR-0155). Each import kind registers exactly one handler here; a kind with no
 * handler shows its history but offers no Revert. Explicit imports, no side-effect registration.
 */
import type {SessionContext} from '../db/client';
import type {ImportKind} from '../lib/import-history';
import {importAttemptKind,previewImportRevert,revertImport,ImportHistoryError,type ImportRevertHandler} from './import-history';
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
export async function previewImportRevertForAttempt(ctx:SessionContext,attemptId:string){return previewImportRevert(ctx,attemptId,await handlerFor(ctx,attemptId));}
export async function revertImportForAttempt(ctx:SessionContext,attemptId:string,input:{previewHash:string;reason:string}){return revertImport(ctx,attemptId,await handlerFor(ctx,attemptId),input);}
