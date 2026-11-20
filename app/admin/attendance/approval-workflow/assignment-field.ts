import { ATTENDANCE_CRITERIA_KEYS, type AttendanceCriteriaGroup } from '@/lib/attendance-workflow';

export type WorkflowAssignmentField = Exclude<keyof AttendanceCriteriaGroup, 'employmentTypes'>;
export type WorkflowAssignmentOption = { id: string; name: string };

export function isWorkflowAssignmentField(value: unknown): value is WorkflowAssignmentField {
  return value !== 'employmentTypes' && ATTENDANCE_CRITERIA_KEYS.some(key => key === value);
}
