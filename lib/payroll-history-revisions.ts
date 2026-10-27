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
};
export type HistoryRevisionPlan = {version:1;rows:HistoryRevisionRow[];issues:{rowNum:number;reason:string}[];
 counts:{created:number;replaced:number;unchanged:number;invalid:number};companyIds:string[];sourceHash:string;previewHash:string};
export type HistoryRevisionChange = {recordId:string;revisionId:string;previousRevisionId:string|null;snapshotId:string|null};
