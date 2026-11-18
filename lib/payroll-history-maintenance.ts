/** Versioned native payroll-history maintenance contracts. Money remains decimal text. */
import type {HistoryRevisionPlan,ImportedPayrollValues} from './payroll-history-revisions';
export type PayrollHistoryUploadMaintenance={version:1;mode:'replace'|'update_listed';reason?:string};
export type PayrollHistoryMaintenanceItem={key:string;code:string;label:string;originalCodes:string[];amount:string;direction:'earning'|'deduction'|'noncash'|'statutory';sourceAttemptId:string|null;sourceName:string|null;sourceRows:number[];laterCorrection:boolean};
export type PayrollHistoryMaintenanceImpact={kind:'payroll'|'report'|'payment'|'issued'|'review';message:string;count?:number};
export type PayrollHistoryMaintenanceRecord={id:string;companyId:string;companyName:string;employmentId:string;employeeNo:string;employeeName:string;period:string;cycleId:string;cycleName:string;currency:string|null;currentRevisionId:string;withdrawn:boolean;itemCount:number;canEdit:boolean;canRemove:boolean;values:ImportedPayrollValues|null;items:PayrollHistoryMaintenanceItem[];impact:PayrollHistoryMaintenanceImpact[]};
export type PayrollHistoryMaintenancePage={items:PayrollHistoryMaintenanceRecord[];total:number;offset:number;limit:number};
export type PayrollHistoryMaintenanceAudit={id:string;ordinal:number;kind:string;operation:string;reason:string|null;actor:string;at:string;attemptId:string;sourceName:string;previousRevisionId:string|null;snapshotId:string|null};
export type PayrollHistoryMaintenanceDetail=PayrollHistoryMaintenanceRecord&{audit:PayrollHistoryMaintenanceAudit[];auditTotal:number};
export type PayrollHistoryMaintenanceQuery={companyId?:string;period?:string;search?:string;offset?:number;limit?:number;includeWithdrawn?:boolean};
export type PayrollHistoryMaintenanceRequest=
 |{version:1;operation:'edit';recordId:string;expectedRevisionId:string;items:{key:string;amount:string}[];reason:string}
 |{version:1;operation:'remove_items';recordId:string;expectedRevisionId:string;itemKeys:string[];reason:string}
 |{version:1;operation:'remove_batch';attemptId:string;reason:string};
export type PayrollHistoryMaintenancePreview={attemptId:string;plan:HistoryRevisionPlan};
