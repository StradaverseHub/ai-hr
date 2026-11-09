import { expectTypeOf, test } from 'vitest';
import type { assessmentSummary, attendanceAllowancePolicy, feedbackRequest } from '../db/schema';
import type { AllowanceRules, AllowanceRulesV2 } from '../lib/attendance-allowance-rules';
import type { FeedbackRelease } from '../lib/feedback-release';
import type { CompetencyInsight } from '../packs/performance/onehr/competency-insight-model';
import type { IdpFitInsight } from '../packs/performance/onehr/idp-fit-model';
import type { PotentialInsight } from '../packs/performance/onehr/potential-insight-model';
import type { TalentInsight } from '../packs/performance/onehr/talent-insight-model';

test('schema JSON columns preserve their public payload contracts', () => {
  type Rules = (typeof attendanceAllowancePolicy.$inferSelect)['rules'];
  type Release = (typeof feedbackRequest.$inferSelect)['release'];
  type Summary = (typeof assessmentSummary.$inferSelect)['data'];

  expectTypeOf<Rules>().toEqualTypeOf<AllowanceRules | null>();
  expectTypeOf<Release>().toEqualTypeOf<FeedbackRelease | null>();
  expectTypeOf<Summary>().toEqualTypeOf<CompetencyInsight | IdpFitInsight | PotentialInsight | TalentInsight>();

  expectTypeOf<Omit<AllowanceRulesV2, 'v'> & { v: 5 }>().not.toExtend<Rules>();
  expectTypeOf<Omit<FeedbackRelease, 'stage'> & { stage: 'deployed' }>().not.toExtend<Release>();
  expectTypeOf<Omit<TalentInsight, 'decision'> & { decision: number }>().not.toExtend<Summary>();
});
