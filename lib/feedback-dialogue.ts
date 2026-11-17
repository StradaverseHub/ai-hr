/** Shared limits for a grouped asynchronous question and its answer. No database/client imports. */
export const FEEDBACK_QUESTION_LIMIT = 4000;
export const FEEDBACK_ANSWER_LIMIT = 8000;
export const FEEDBACK_PREPLAN_STATES = ['open', 'contested'] as const;
export function dialogueText(value: string, limit: number): string {
  const text = typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim() : '';
  if (!text || text.length > limit) throw new Error(`Enter between 1 and ${limit} characters.`);
  return text;
}
export type FeedbackDialogueFormState = { error?: string; sent?: boolean };
