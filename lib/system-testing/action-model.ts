import type { TestingRefusalCode } from './model';
export type TestingActionState = { error: TestingRefusalCode | 'module_unavailable' | 'feedback_unavailable' | null; savedObservation?: { executionId: string; revision: number }; savedDraft?: { caseId: string; revision: number; versionId: string|null } };
export const INITIAL_TESTING_ACTION_STATE: TestingActionState = { error: null };
