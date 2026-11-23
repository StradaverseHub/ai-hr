export const TAX_BASIS_PREVIEW_CHUNK_SIZE=20;

/** Serializable contract for explicit historical income-tax basis corrections. */
export type TaxBasisSelection={companyId:string;year:number;upToMonth:number;employmentIds:string[]|null};
export type TaxBasisItem={code:string;name:string;amount:number;previousTreatment:string|null;latestTreatment:string;taxable:number;exempt:number};
export type TaxBasisMonth={payslipId:string;period:string;sourceHash:string;payrollInputsChanged?:boolean;beforeTaxable:number|null;difference:number|null;taxable:number;beforeExempt:number|null;exempt:number;ytdTaxable:number;ytdExempt:number;items:TaxBasisItem[];basis:TaxBasisValue};
export type TaxBasisValue={version:1;pcb:number;exemptionUsed:Record<string,number>;lp?:number;items:TaxBasisItem[];rulesHash:string;[key:string]:unknown};
export type TaxBasisMissingEvidence={field:string;affects:string[];reason:string};
export type TaxBasisPartialMonth={payslipId:string;period:string;items:{code:string;name:string;amount:number;direction:'earning'|'deduction'|'noncash';includedInPcb:boolean;remunerationType:string|null;exemptionCode:string|null}[]};
/** Where the prior-employer annual exemption opening came from (ADR-0167, 23 November 2026 decision, board item 0af23331).
 * saved_payslip: year-bound opening saved with the original payslips; accepted_tp3: the employee's accepted TP3 for the year
 * (canonical employee_tp3, else the employee_statutory_my projection for that year); no_accepted_tp3: RM0 because neither exists.
 * no_tp3_default_zero is the 20 November label kept only so earlier saved results still read. */
export type TaxOpeningSource='saved_payslip'|'accepted_tp3'|'no_accepted_tp3';
export type TaxBasisOpening={source:TaxOpeningSource;used:Record<string,number>;tp3?:{kind:'form'|'statutory_projection';id:string|null;revision:string};previousEmployerDeclared?:boolean};
export type TaxBasisHoldReason='saved_evidence_conflict'|'access_insufficient';
/** One Pay Item's draw on one annual exemption limit, in replay order. Calculated by the country pack; display only. */
export type TaxBasisLedgerEntry={payslipId:string;period:string;itemCode:string;itemName:string;code:string;cap:number;usedBefore:number;remainingBefore:number;eligible:number;exempt:number;excess:number;usedAfter:number;remainingAfter:number};
export type TaxBasisLedgerCode={code:string;cap:number;openingUsed:number;openingSource:TaxOpeningSource|null;eligible:number;exempt:number;excess:number;usedAfter:number;remaining:number;items:{code:string;name:string}[]};
/** Review-only ranges for an employee whose opening is still held. Never persisted and never confirmable. */
export type TaxBasisBounds={codes:{code:string;cap:number;eligible:number;exemptMax:number;certainExcess:number}[];months:{payslipId:string;period:string;taxableMin:number;exemptMax:number;items:{code:string;name:string;amount:number;exemptionCode:string|null;exact:boolean;exemptMax:number;taxableMin:number}[]}[]};
export type TaxBasisEmployee={openingExemptionSource?:'no_tp3_default_zero'|TaxOpeningSource;openingExemption?:TaxBasisOpening;holdReason?:TaxBasisHoldReason;exemptionLedger?:TaxBasisLedgerCode[];bounds?:TaxBasisBounds;id:string;employeeNo:string;name:string;companyName?:string;companyId?:string;status:'ready'|'unchanged'|'skipped'|'blocked'|'completed'|'failed';reason:string|null;recordCount:number;beforeTaxable:number|null;difference:number|null;taxable:number|null;beforeExempt:number|null;exempt:number|null;months:TaxBasisMonth[];pcbComparison?:{state:'unavailable';originalPaid:number|null;missingInputs:string[]};partialMonths?:TaxBasisPartialMonth[];missingEvidence?:TaxBasisMissingEvidence[]};
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
