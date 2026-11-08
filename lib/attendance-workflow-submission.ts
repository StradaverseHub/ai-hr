import { AttendanceWorkflowError } from './attendance-workflow';
import type { AttendanceLevelProblem } from './attendance-workflow-v3';

/** A finite, public new-submission refusal. Setup previews keep their detailed administrator errors. */
export class AttendanceWorkflowSubmissionError extends AttendanceWorkflowError {
  constructor(code: 'noMatch' | 'tie' | 'unresolved', public readonly problem?: AttendanceLevelProblem) {
    super(code, 'Please Contact the HR Administrator.');
    this.name = 'AttendanceWorkflowSubmissionError';
  }
}
