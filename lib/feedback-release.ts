/** Release progress is separate from plan/build status. Legacy deployments are unverified. */
export const RELEASE_STAGES = ['staging', 'production_ready', 'production'] as const;
export type FeedbackReleaseStage = (typeof RELEASE_STAGES)[number];
export type FeedbackRelease = {
  stage: FeedbackReleaseStage;
  sourceSha: string;
  buildId: string;
  evidence: string;
  recordedAt: string;
  planRevision: number;
  reopenedCount: number;
  buildRef: string;
};
export type FeedbackBoardStatus = import('../db/schema').FeedbackStatus | FeedbackReleaseStage;
export const FEEDBACK_BOARD_STATUSES = ['open', 'planned', 'contested', 'approved', 'blocked', 'building', 'done', 'staging', 'production_ready', 'production', 'deployed', 'rejected', 'cancelled'] as const satisfies readonly FeedbackBoardStatus[];

export function feedbackBoardStatus(row: {
  status: import('../db/schema').FeedbackStatus;
  planRevision: number;
  reopenedCount: number;
  buildRef?: string | null;
  release?: FeedbackRelease | null;
}): FeedbackBoardStatus {
  const r = row.release;
  return row.status === 'deployed' && r && RELEASE_STAGES.includes(r.stage) &&
    r.planRevision === row.planRevision && r.reopenedCount === row.reopenedCount && r.buildRef === row.buildRef
    ? r.stage : row.status;
}

export function feedbackStatusTone(status: string): string {
  switch (status) {
    case 'open': case 'blocked': return 'bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300';
    case 'planned': case 'staging': return 'bg-blue-50 text-blue-800 dark:bg-blue-500/10 dark:text-blue-300';
    case 'contested': return 'bg-rose-50 text-rose-800 dark:bg-rose-500/10 dark:text-rose-300';
    case 'approved': case 'building': case 'production_ready': return 'bg-indigo-50 text-indigo-800 dark:bg-indigo-500/10 dark:text-indigo-300';
    case 'production': return 'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300';
    default: return 'bg-muted text-muted-foreground';
  }
}
