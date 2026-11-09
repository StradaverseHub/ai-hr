import { AttendanceWorkflowError } from './attendance-workflow';
import type { AttendanceLevelProblem } from './attendance-workflow-v3';

export const ATTENDANCE_SUBMISSION_REASONS = ['noMatch', 'tie', 'unresolved', 'routeChanged'] as const;
export type AttendanceSubmissionReason = typeof ATTENDANCE_SUBMISSION_REASONS[number];
export const attendanceSubmissionCopy = {
  noMatch: 'No saved approval workflow matches your request. Ask HR to check your company and employee assignment.',
  tie: 'Multiple approval workflows match at the same priority. Ask HR to adjust their priorities.',
  unresolved: 'A required approver is missing or unavailable. Ask HR to check your reporting line or assigned approvers.',
  routeChanged: 'Your approval route changed. Refresh to review who will receive your request before submitting again.',
} satisfies Record<AttendanceSubmissionReason, string>;

/** Setup previews keep detailed administrator errors. Employees see only these finite refusal reasons. */
export class AttendanceWorkflowSubmissionError extends AttendanceWorkflowError {
  constructor(public readonly reason: AttendanceSubmissionReason, public readonly problem?: AttendanceLevelProblem) {
    super(reason === 'routeChanged' ? 'stale' : reason, attendanceSubmissionCopy[reason]);
    this.name = 'AttendanceWorkflowSubmissionError';
  }
}
