/** Fictional pure transport fixture only; not an authenticated source/effect proof. */
import {OffboardingCaseCancel as C} from '../../lib/assistant-actions/offboarding-case-cancel-contract';
export const caseId='00000000-0000-4000-8000-000000000001',actionId='00000000-0000-4000-8000-000000000002',eventId='00000000-0000-4000-8000-000000000003';
export const cancelHuman={caseId,caseNumber:'OFB-0001',reason:'Opened in error',confirmCaseCancellation:true as const};
export const cancelPrepared={action:C.action,contractVersion:1 as const,actionId,reviewedDigest:'a'.repeat(64),createdAt:'2026-10-30T00:00:00.000Z',expiresAt:'2099-10-30T00:10:00.000Z',content:cancelHuman,review:{caseId,caseNumber:'OFB-0001',companyId:caseId,resignationDate:'2026-10-01',lastWorkingDay:null,before:{status:'in_progress' as const,cancelReason:null},after:{status:'cancelled' as const,cancelReason:cancelHuman.reason}}};
export const cancelCompleted={action:C.action,contractVersion:1 as const,actionId,state:'completed' as const,receipt:{caseId,status:'cancelled' as const,eventId}};
