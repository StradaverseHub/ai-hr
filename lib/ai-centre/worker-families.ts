/** ADR-0170 §3.13: every automated worker belongs to exactly one family. This file is the presentation map
 * from the closed AI feature inventory (lib/ai/features.ts) and the Control Tower's built-in checks
 * (core/control-domains.ts agentStatuses) to a family, a trigger and an effect. It holds no state: whether a
 * worker is on, ready or paused is always read from the system by the page that renders it.
 *
 * A test (test/ai-centre-workers.test.ts) fails when a feature or built-in check exists without a row here,
 * so a new worker cannot ship without being placed in a family. */
import type { AiFeatureId } from '@/lib/ai/features';

export const WORKER_FAMILIES = ['watcher', 'chaser', 'preparer', 'decider', 'explainer', 'platform'] as const;
export type WorkerFamily = (typeof WORKER_FAMILIES)[number];

export type WorkerTrigger = 'payrollRun' | 'nightly' | 'onChange' | 'onSubmit' | 'scheduled' | 'onRequest' | 'onFinding' | 'afterCheck';
export type WorkerEffect = 'findings' | 'flag' | 'remindTemplate' | 'remind' | 'prepare' | 'draft' | 'suggest' | 'explain' | 'analyse' | 'answer' | 'decide';
export type WorkerPlacement = Readonly<{ family: WorkerFamily; trigger: WorkerTrigger; effect: WorkerEffect }>;

const performance: WorkerPlacement = { family: 'preparer', trigger: 'onRequest', effect: 'draft' };

export const FEATURE_PLACEMENT: Readonly<Record<AiFeatureId, WorkerPlacement>> = {
  hr_assistant: { family: 'platform', trigger: 'onRequest', effect: 'answer' },
  performance_assistant: { family: 'platform', trigger: 'onRequest', effect: 'answer' },
  provider_evaluation: { family: 'platform', trigger: 'onRequest', effect: 'analyse' },
  module_agent_evaluation: { family: 'platform', trigger: 'onRequest', effect: 'analyse' },
  module_agent_planning: { family: 'platform', trigger: 'onRequest', effect: 'suggest' },
  feedback_planning: { family: 'platform', trigger: 'onRequest', effect: 'draft' },
  claims_triage: { family: 'watcher', trigger: 'onSubmit', effect: 'flag' },
  readiness_reminders: { family: 'chaser', trigger: 'scheduled', effect: 'remind' },
  approval_chasers: { family: 'chaser', trigger: 'scheduled', effect: 'remindTemplate' },
  review_chasers: { family: 'chaser', trigger: 'scheduled', effect: 'remindTemplate' },
  clock_reminders: { family: 'chaser', trigger: 'scheduled', effect: 'remindTemplate' },
  document_reminders: { family: 'chaser', trigger: 'scheduled', effect: 'remindTemplate' },
  lifecycle_chasers: { family: 'chaser', trigger: 'scheduled', effect: 'remindTemplate' },
  personnel_import_mapping: { family: 'preparer', trigger: 'onRequest', effect: 'suggest' },
  pay_rule_draft: { family: 'preparer', trigger: 'onRequest', effect: 'draft' },
  performance_360: performance,
  performance_tc: performance,
  performance_pm: performance,
  performance_review: performance,
  performance_idp: performance,
  performance_calib: performance,
  payroll_explanation: { family: 'explainer', trigger: 'onFinding', effect: 'explain' },
  payroll_hypotheses: { family: 'explainer', trigger: 'nightly', effect: 'suggest' },
  report_insight: { family: 'explainer', trigger: 'onRequest', effect: 'analyse' },
};

/** Built-in checks from core/control-domains.ts agentStatuses that are not switchable AI features. The
 * other agentStatuses ids are features listed above (narrator = payroll_explanation, and so on). */
export const BUILT_IN_PLACEMENT: Readonly<Record<string, WorkerPlacement>> = {
  detectors: { family: 'watcher', trigger: 'payrollRun', effect: 'findings' },
  sweep: { family: 'watcher', trigger: 'nightly', effect: 'findings' },
  actions: { family: 'preparer', trigger: 'afterCheck', effect: 'prepare' },
  autonomy: { family: 'decider', trigger: 'onRequest', effect: 'decide' },
};

/** agentStatuses ids that duplicate a feature row above; the Workers page shows the feature row instead. */
export const BUILT_IN_SHOWN_AS_FEATURE: readonly string[] = ['narrator', 'assistant', 'hypotheses', 'triage', 'nudge', 'payRuleDrafter', 'reportDesigner', 'onehrEvidenceDrafter', 'reviewDrafter', 'planDrafter'];

export function groupByFamily<T>(rows: readonly T[], familyOf: (row: T) => WorkerFamily): Readonly<Record<WorkerFamily, T[]>> {
  const out = Object.fromEntries(WORKER_FAMILIES.map(family => [family, [] as T[]])) as Record<WorkerFamily, T[]>;
  for (const row of rows) out[familyOf(row)].push(row);
  return out;
}
