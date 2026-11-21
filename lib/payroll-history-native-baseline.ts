/** A captured open-native source is immutable evidence; its live payslip is never adopted or frozen. */
import {createHash} from 'node:crypto';
import type {ImportedPayrollValues} from './payroll-history-revisions';
export type NativeHistorySource={sourceBatchId:string;sourcePayslipId:string;sourceVersion:number;sourceHash:string;values:ImportedPayrollValues};
export type DetachedNativeHistoryBaseline=NativeHistorySource&{batchId:string;snapshotId:string;valueHash:string};
export type NativeHistoryBaselineProof={version:1;sourceBatchId:string;sourcePayslipId:string;sourceVersion:number;sourceHash:string;baselineBatchId:string;baselineSnapshotId:string};
function nativeHistoryId(attemptId:string,sourceId:string,kind:'batch'|'snapshot'){
 const bytes=createHash('sha256').update(['history-native-baseline-v1',attemptId.toLowerCase(),sourceId.toLowerCase(),kind].join(':')).digest('hex').slice(0,32).split('');bytes[12]='5';bytes[16]='8';const value=bytes.join('');return[value.slice(0,8),value.slice(8,12),value.slice(12,16),value.slice(16,20),value.slice(20)].join('-');
}
export function nativeHistoryBaselineIds(attemptId:string,sourceBatchId:string,sourcePayslipId:string){return{batchId:nativeHistoryId(attemptId,sourceBatchId,'batch'),snapshotId:nativeHistoryId(attemptId,sourcePayslipId,'snapshot')};}

/** Same decimal-text canonical value commitment as the existing immutable history snapshot owner. */
export function nativeHistoryBaselineValueHash(values:ImportedPayrollValues){return createHash('sha256').update(JSON.stringify(values,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)):item)).digest('hex');}
