import { AttendanceWorkflowError } from './attendance-workflow';

/** A finite, public new-submission refusal. Setup previews keep their detailed administrator errors. */
export class AttendanceWorkflowSubmissionError extends AttendanceWorkflowError {
  constructor(code: 'noMatch' | 'tie' | 'unresolved') {
    super(code, 'Please Contact the HR Administrator.');
    this.name = 'AttendanceWorkflowSubmissionError';
  }
}
