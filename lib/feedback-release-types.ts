/** Release evidence stored against a feedback cycle. */
export type FeedbackReleaseStages = readonly ['staging', 'production_ready', 'production'];
export type FeedbackReleaseStage = FeedbackReleaseStages[number];
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
