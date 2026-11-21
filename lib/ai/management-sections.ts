/** Closed AI management page purposes, shared by reads and navigation. */
export const AI_MANAGEMENT_SECTIONS = ['overview','provider','assistant','features','allowances','spending','orchestrator','runs'] as const;
export type AiManagementSection = (typeof AI_MANAGEMENT_SECTIONS)[number];
