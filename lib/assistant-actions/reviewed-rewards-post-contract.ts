/** Human selects an EXISTING approved Rewards unit/revision and optional existing native batch.
 * No budgets, recommendations, performance ratings, salaries or money can be posted as model input. */
import {z} from 'zod';
export const REVIEWED_REWARDS_POST_ACTION='rewards.post' as const;
const base={action:z.literal(REVIEWED_REWARDS_POST_ACTION),contractVersion:z.literal(1)},id=z.guid(),revision=z.number().int().nonnegative(),digest=z.string().regex(/^[a-f0-9]{64}$/),cents=z.number().int().safe();
export const ReviewedRewardsPostNomination=z.object({...base,unitId:id}).strict();
export const ReviewedRewardsPostHumanContent=z.object({...base,unitId:id,revision,batchId:id.nullable(),confirmWholeApprovedUnit:z.literal(true)}).strict();
export type ReviewedRewardsPostHumanContent=z.infer<typeof ReviewedRewardsPostHumanContent>;
export const ReviewedRewardsPostConfirmation=z.object({...base,reviewedDigest:digest}).strict();
export const ReviewedRewardsPostReview=z.object({unitId:id,revision,companyId:id,businessUnitId:id,name:z.string(),cycleName:z.string(),year:z.number().int(),kind:z.enum(['annual','adhoc','midyear']),effectiveFrom:z.iso.date(),batch:z.object({id,payPeriod:z.string().regex(/^\d{4}-\d{2}$/)}).strict().nullable(),hiddenCount:z.number().int().nonnegative(),
 rows:z.array(z.object({entryId:id,employmentId:id,employeeCode:z.string(),name:z.string(),currency:z.string(),basicCents:cents,newBasicCents:cents,promotionGrade:z.string().nullable(),bonusCents:cents,lumpCents:cents}).strict()),
 scope:z.literal('whole_approved_unit_including_restricted_records'),consequence:z.literal('salary_grade_and_draft_payroll_inputs_not_processed_or_paid')}).strict();
/** INTERNAL trusted-owner packet: reviewedDigest commits hidden source/funding/row versions. Keep it
 * inside encrypted custody; NEVER serialize it as a browser digest. Public review is only the Review
 * above; future custody must issue its separate public human-review/content digest. */
export const ReviewedRewardsPostPreparedSource=z.object({kind:z.literal('prepared_source'),content:ReviewedRewardsPostHumanContent,review:ReviewedRewardsPostReview,reviewedDigest:digest,consequence:z.literal('whole_approved_unit_post_subject_to_native_checks')}).strict();
export type ReviewedRewardsPostPreparedSource=z.infer<typeof ReviewedRewardsPostPreparedSource>;
export const ReviewedRewardsPostSourceReceipt=z.object({kind:z.literal('posted'),unitId:id,postedEventId:id,currentStatus:z.enum(['draft','bg','gr','ctro','ec','approved','posted','rejected','withdrawn']),currentRevision:revision,postedRevision:revision,postedBatchId:id.nullable(),proof:z.literal('historical_post_current_unit'),semantics:z.literal('salary_grade_and_draft_payroll_inputs_not_processed_or_paid'),replayed:z.boolean()}).strict();
