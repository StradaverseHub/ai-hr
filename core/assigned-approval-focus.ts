/** Admission for one request's existing approval workspace. A URL cannot supply assignment. */
import type {SessionContext} from '../db/client';
import type {AssignedApprovalFocus} from '../lib/assigned-approval-focus';
import {pendingLeaveTaskMetadata,pendingLeaveCancellationTaskMetadata,listPendingReplacementLeaveTasks} from '../packs/leave/service';
import {pendingAttendanceTaskMetadata} from '../packs/attendance/service';
import {pendingClaimTaskMetadata} from '../packs/claims/service';
import {pendingResignationTaskMetadata} from './offboarding';
import {pendingReviewTaskMetadata} from './employment-review';

export async function isCurrentAssignedApproval(ctx:SessionContext,focus:AssignedApprovalFocus,modules:{attendance:boolean;claims:boolean}):Promise<boolean>{
 let rows:{id:string}[];
 switch(focus.kind){
  case 'leave':rows=await pendingLeaveTaskMetadata(ctx);break;
  case 'leaveCancellation':rows=await pendingLeaveCancellationTaskMetadata(ctx);break;
  case 'attendance':rows=modules.attendance?await pendingAttendanceTaskMetadata(ctx):[];break;
  case 'claim':rows=modules.claims?await pendingClaimTaskMetadata(ctx):[];break;
  case 'resignation':rows=await pendingResignationTaskMetadata(ctx);break;
  case 'managerReview':rows=await pendingReviewTaskMetadata(ctx,'manager');break;
  case 'hrReview':rows=await pendingReviewTaskMetadata(ctx,'hr');break;
  case 'replacementLeave':rows=await listPendingReplacementLeaveTasks(ctx);break;
 }
 return rows.some(row=>row.id===focus.id);
}
