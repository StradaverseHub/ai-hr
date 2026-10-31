/** A resolution refusal in plain words: the message key (offlineClocking.review.errors.<key>) for each typed refusal
 * of the offline-claim review service and of the correction owner it files through. Anything else is `failed`, so no
 * driver text, SQL or name ever reaches the screen. */
import {AttendanceCorrectionFutureDateError,AttendanceCorrectionPendingError,AttendancePayrollClosedError,AttendanceWorkflowError,ClockDataChangedError} from '@/packs/attendance/service';
import {AttendanceLevelError} from '@/lib/attendance-workflow-v3';
import {OfflineClaimReviewError} from '@/packs/attendance/mobile-offline-claim-review';

export const OFFLINE_RESOLVE_ERRORS=['reasonRequired','timeRequired','payrollClosed','dayChanged','correctionPending','workflow','futureDate','notFound','forbidden','self',
 'notResolvable','conflict','timeInvalid','employmentInactive','photoReview','failed'] as const;
export type OfflineResolveError=(typeof OFFLINE_RESOLVE_ERRORS)[number];

export function offlineResolveError(error:unknown):OfflineResolveError{
 if(error instanceof AttendancePayrollClosedError)return 'payrollClosed';
 if(error instanceof ClockDataChangedError)return 'dayChanged';
 if(error instanceof AttendanceCorrectionPendingError)return 'correctionPending';
 if(error instanceof AttendanceCorrectionFutureDateError)return 'futureDate';
 if(error instanceof AttendanceWorkflowError||error instanceof AttendanceLevelError)return 'workflow';
 if(error instanceof OfflineClaimReviewError){
  switch(error.reason){
   case 'not_found':return 'notFound';
   case 'forbidden':return 'forbidden';
   case 'self_resolution':return 'self';
   case 'not_resolvable':return 'notResolvable';
   case 'resolution_conflict':return 'conflict';
   case 'effective_time_invalid':return 'timeInvalid';
   case 'employment_inactive':return 'employmentInactive';
   case 'photo_review_required':return 'photoReview';
   default:return 'failed';
  }
 }
 return 'failed';
}
