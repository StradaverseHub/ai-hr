import { AttendanceWorkflowSubmissionError, type AttendanceSubmissionReason } from './attendance-workflow-submission';
import { getTranslations } from 'next-intl/server';
import { AttendanceLevelError, attendanceLevelProblemMessageKey } from './attendance-workflow-v3';
import { publicErrorMessage } from './public-error';
/** Server presentation boundary; the domain resolver supplies only finite level/problem facts. */
export async function attendanceWorkflowErrorMessage(error: unknown): Promise<string> {
    if (error instanceof AttendanceWorkflowSubmissionError) return attendanceWorkflowRefusalMessage(error.reason);
    if (!(error instanceof AttendanceLevelError)) return publicErrorMessage(error);
    const t = await getTranslations('attendanceWorkflow');
    const prefix = error.problem.levelIndex == null ? '' : `${t('stageNumber', { number: error.problem.levelIndex + 1 })}: `;
    return prefix + t(`v3.${attendanceLevelProblemMessageKey(error.problem)}`);
}

export async function attendanceWorkflowRefusalMessage(reason: AttendanceSubmissionReason): Promise<string> {
    return (await getTranslations('attendanceWorkflow'))(`submissionRefusals.${reason}`);
}
