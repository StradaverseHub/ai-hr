/** Import provenance is immutable evidence. Effective money remains in the canonical payslip rows. */
export type ImportedPayrollValues = {
 basicSalary:string;allowance:string;overtimePay:string;bonus:string;grossPay:string;
 statutory:Record<string,unknown>;otherDeductions:string;totalDeductions:string;netPay:string;employerCost:string;
};
export type HistoryRevisionRow = {
 companyId:string;companyName:string;currency:string|null;employmentId:string;employeeNo:string;period:string;cycleId:string;cycleName:string;
 rowNums:number[];operation:'create'|'replace'|'unchanged'|'invalid';reasons:string[];
 recordId:string|null;expectedRevisionId:string|null;expectedSnapshotId:string|null;
 values:ImportedPayrollValues|null;beforeValues:ImportedPayrollValues|null;valueHash:string|null;overwrite:boolean;
 /** d28501b8 — the DOE codes the month's lines used, and whether payroll run or reported in AIHR holds it.
  *  Optional: plans saved before d28501b8 carry neither. */
 codes?:string[];protected?:boolean;
 /** d28501b8 r2 — who the row is, what the overwrite would replace, and what has already gone out from it.
  *  `warnings` must be acknowledged before a replacement is applied; they never block it. */
 employeeName?:string|null;overwriteSource?:'processed'|'imported'|null;expectedOrdinaryPayslipId?:string|null;warnings?:string[];
};
/** The identity a replacement is ticked by on the screen and confirmed by on the server. */
export const historyRecordKey=(row:Pick<HistoryRevisionRow,'companyId'|'employmentId'|'period'|'cycleId'>)=>[row.companyId,row.employmentId,row.period,row.cycleId].join(':');
export type HistoryRevisionPlan = {version:1;rows:HistoryRevisionRow[];issues:{rowNum:number;reason:string}[];
 counts:{created:number;replaced:number;unchanged:number;invalid:number};companyIds:string[];sourceHash:string;previewHash:string};
export type HistoryRevisionChange = {recordId:string;revisionId:string;previousRevisionId:string|null;snapshotId:string|null};
