export const TAX_BASIS_PREVIEW_CHUNK_SIZE=20;

/** Serializable contract for explicit historical income-tax basis corrections. */
export type TaxBasisSelection={companyId:string;year:number;upToMonth:number;employmentIds:string[]|null};
export type TaxBasisItem={code:string;name:string;amount:number;previousTreatment:string|null;latestTreatment:string;taxable:number;exempt:number};
export type TaxBasisMonth={payslipId:string;period:string;sourceHash:string;payrollInputsChanged?:boolean;beforeTaxable:number|null;difference:number|null;taxable:number;beforeExempt:number|null;exempt:number;ytdTaxable:number;ytdExempt:number;items:TaxBasisItem[];basis:TaxBasisValue};
export type TaxBasisValue={version:1;pcb:number;exemptionUsed:Record<string,number>;lp?:number;items:TaxBasisItem[];rulesHash:string;[key:string]:unknown};
export type TaxBasisMissingEvidence={field:string;affects:string[];reason:string};
export type TaxBasisPartialMonth={payslipId:string;period:string;items:{code:string;name:string;amount:number;direction:'earning'|'deduction'|'noncash';includedInPcb:boolean;remunerationType:string|null;exemptionCode:string|null}[]};
export type TaxBasisEmployee={openingExemptionSource?:'no_tp3_default_zero';id:string;employeeNo:string;name:string;companyName?:string;companyId?:string;status:'ready'|'unchanged'|'skipped'|'blocked'|'completed'|'failed';reason:string|null;recordCount:number;beforeTaxable:number|null;difference:number|null;taxable:number|null;beforeExempt:number|null;exempt:number|null;months:TaxBasisMonth[];pcbComparison?:{state:'unavailable';originalPaid:number|null;missingInputs:string[]};partialMonths?:TaxBasisPartialMonth[];missingEvidence?:TaxBasisMissingEvidence[]};
export type TaxBasisPreview={previewId:string;previewHash:string;companyId:string;companyName:string;year:number;upToMonth:number;selection:'all'|'selected';createdAt:string;expiresAt:string;settingsHash:string;totals:{beforeTaxable:number|null;taxable:number|null;difference:number|null;beforeExempt:number|null;exempt:number|null};eligibleCount:number;unchangedCount:number;blockedCount:number;skippedCount?:number;recordCount:number;employees:TaxBasisEmployee[]};
export type TaxBasisBatch={id:string;reference:string;companyId:string;companyName:string;year:number;upToMonth:number;selection:'all'|'selected';status:'pending'|'processing'|'completed'|'completed_with_errors'|'failed';createdAt:string;completedAt:string|null;actorName:string;recoverable?:boolean;workerManaged?:boolean;lastProgressAt?:string;employeeCount:number;recordCount:number;completedCount:number;failedCount:number;employees:TaxBasisEmployee[]};
export class PayrollTaxBasisError extends Error{constructor(message:string){super(message);this.name='PayrollTaxBasisError';}}

/** a16382b4 — progress from recorded work only. Unfinished work never reads 100%, even when every counted employee is
 * done but the final outcome is not yet recorded (the same rule as bulkJobPercent). */
export function taxBasisProgressPercent(processed:number,total:number,finished:boolean):number{
 if(finished)return 100;
 return total>0?Math.min(99,Math.max(0,Math.floor(processed/total*100))):0;
}
export type TaxBasisProgressState='pending'|'processing'|'completed'|'completed_with_errors'|'failed';
/** One row of the Recalculation history page: a saved company batch, or (submitter only) a company still queued in a
 * multi-company run whose batch the worker has not created yet. Summary fields only — no employee detail. */
export type TaxBasisHistoryRow={
 id:string;kind:'batch'|'queued';reference:string|null;companyId:string;companyName:string;year:number|null;upToMonth:number|null;
 status:TaxBasisProgressState;createdAt:string;completedAt:string|null;actorName:string;
 employeeCount:number;processedCount:number;completedCount:number;failedCount:number;notIncludedCount:number;
 /** Unfinished, not worker-owned and without progress for 5 minutes: review it from a batch's detail page. */
 interrupted:boolean;
 /** The saved employee-group batches behind this row, oldest first; each has its own detail page. Empty when queued. */
 batches:{id:string;reference:string}[];
};
export type TaxBasisHistoryCursor={createdAt:string;id:string};
export const TAX_BASIS_HISTORY_PAGE_SIZE=25;
