/** Closed human review contract. No posted actor, native receipt, identity, service or model executor. */
import {z} from 'zod';
import {OwnNotificationPreferencesIntent,OwnNotificationPreferencesReview} from './own-notification-preferences-contract';
import {notificationPreferenceCategory,notificationEmailLocales} from '../notification-email-model';
export const MODULE_NOTIFICATION_ACTION='notifications.email_preferences.save' as const;
const digest=z.string().regex(/^[a-f0-9]{64}$/);
export const ModuleActionPrepare=z.object({action:z.literal(MODULE_NOTIFICATION_ACTION),contractVersion:z.literal(1),intent:OwnNotificationPreferencesIntent}).strict();
export const ModuleActionConfirmation=z.object({action:z.literal(MODULE_NOTIFICATION_ACTION),contractVersion:z.literal(1),actionId:z.uuid(),reviewedDigest:digest}).strict();
export const ModuleActionPreparedReview=z.object({action:z.literal(MODULE_NOTIFICATION_ACTION),contractVersion:z.literal(1),actionId:z.uuid(),reviewedDigest:digest,
 createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),review:OwnNotificationPreferencesReview.omit({reviewDigest:true})}).strict();
/** Recorded native effect reconciled with current values; never a latest-event or delivery claim. */
export const ModuleActionCompletedReceipt=z.object({action:z.literal(MODULE_NOTIFICATION_ACTION),contractVersion:z.literal(1),actionId:z.uuid(),state:z.literal('completed'),
 sourceEventId:z.uuid(),employmentId:z.uuid(),enabledCategories:z.array(notificationPreferenceCategory),locale:z.enum(notificationEmailLocales),
 semantics:z.literal('recorded_effect_current_values')}).strict();
export const ModuleActionRetiredReceipt=z.object({action:z.literal(MODULE_NOTIFICATION_ACTION),contractVersion:z.literal(1),actionId:z.uuid(),state:z.enum(['discarded','expired','refused'])}).strict();
export const ModuleActionReviewIndexResult=z.object({kind:z.literal('module_review_index'),reviews:z.array(z.object({action:z.literal(MODULE_NOTIFICATION_ACTION),actionId:z.uuid(),state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25).refine(rows=>new Set(rows.map(row=>row.actionId)).size===rows.length)}).strict();

/** ESS source support is closed and unmounted; existing notification HTTP contracts above stay
 * unchanged. Native policy/source fingerprints are encrypted only, never public confirmation data. */
import {OWN_PROFILE_CHANGE_ACTION,OwnProfileChangeHumanContent} from './own-profile-change-contract';
export const ProfileModuleActionPrepare=OwnProfileChangeHumanContent;
export const ProfileModuleActionConfirmation=z.object({action:z.literal(OWN_PROFILE_CHANGE_ACTION),contractVersion:z.literal(1),actionId:z.uuid(),reviewedDigest:digest}).strict();
export const ProfileModuleActionPreparedReview=z.object({action:z.literal(OWN_PROFILE_CHANGE_ACTION),contractVersion:z.literal(1),actionId:z.uuid(),reviewedDigest:digest,
 createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),content:OwnProfileChangeHumanContent,consequence:z.literal('request_hr_review')}).strict();
export const ProfileModuleActionCompletedReceipt=z.object({action:z.literal(OWN_PROFILE_CHANGE_ACTION),contractVersion:z.literal(1),actionId:z.uuid(),state:z.literal('completed'),
 requestId:z.uuid(),requestedEventId:z.uuid(),employmentId:z.uuid(),currentStatus:z.enum(['pending','approved','rejected']),semantics:z.literal('submitted_not_approved')}).strict();
export const ProfileModuleActionRetiredReceipt=z.object({action:z.literal(OWN_PROFILE_CHANGE_ACTION),contractVersion:z.literal(1),actionId:z.uuid(),state:z.enum(['discarded','expired','refused'])}).strict();
export const ProfileModuleActionReviewIndexResult=z.object({kind:z.literal('profile_module_review_index'),reviews:z.array(z.object({action:z.literal(OWN_PROFILE_CHANGE_ACTION),actionId:z.uuid(),state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25).refine(rows=>new Set(rows.map(row=>row.actionId)).size===rows.length)}).strict();

/** Claims DRAFT custody only; submission remains a separate human action. */
import {OWN_CLAIM_DRAFT_ACTION,OwnClaimDraftHumanContent} from './own-claim-contract';
export const ClaimModuleActionPrepare=OwnClaimDraftHumanContent;
export const ClaimModuleActionConfirmation=z.object({action:z.literal(OWN_CLAIM_DRAFT_ACTION),contractVersion:z.literal(1),actionId:z.uuid(),reviewedDigest:digest}).strict();
export const ClaimModuleActionPreparedReview=z.object({action:z.literal(OWN_CLAIM_DRAFT_ACTION),contractVersion:z.literal(1),actionId:z.uuid(),reviewedDigest:digest,
 createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),content:OwnClaimDraftHumanContent,provisionalAmount:z.string().regex(/^\d+\.\d{2}$/),provisionalQuantityKm:z.string().regex(/^-?\d+\.\d{2}$/).nullable(),provisionalTaxable:z.boolean(),consequence:z.literal('draft_only_no_submission_or_reimbursement')}).strict();
export const ClaimModuleActionCompletedReceipt=z.object({action:z.literal(OWN_CLAIM_DRAFT_ACTION),contractVersion:z.literal(1),actionId:z.uuid(),state:z.literal('completed'),
 draftId:z.uuid(),savedEventId:z.uuid(),employmentId:z.uuid(),currentStatus:z.enum(['draft','pending','approved','rejected','cancelled','paid']),semantics:z.literal('draft_saved_not_submitted_or_reimbursed')}).strict();
export const ClaimModuleActionRetiredReceipt=z.object({action:z.literal(OWN_CLAIM_DRAFT_ACTION),contractVersion:z.literal(1),actionId:z.uuid(),state:z.enum(['discarded','expired','refused'])}).strict();
export const ClaimModuleActionReviewIndexResult=z.object({kind:z.literal('claim_module_review_index'),reviews:z.array(z.object({action:z.literal(OWN_CLAIM_DRAFT_ACTION),actionId:z.uuid(),state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25).refine(rows=>new Set(rows.map(row=>row.actionId)).size===rows.length)}).strict();

import {OwnReviewAcknowledgementIntent,OwnReviewAcknowledgementReview,OwnReviewAcknowledgementReceipt} from './own-review-acknowledgement-contract';
export const MODULE_REVIEW_ACK_ACTION='performance.review.acknowledge' as const;
export const ReviewModuleActionPrepare=z.object({action:z.literal(MODULE_REVIEW_ACK_ACTION),contractVersion:z.literal(1),intent:OwnReviewAcknowledgementIntent}).strict();
export const ReviewModuleActionConfirmation=z.object({action:z.literal(MODULE_REVIEW_ACK_ACTION),contractVersion:z.literal(1),actionId:z.uuid(),reviewedDigest:digest}).strict();
export const ReviewModuleActionPreparedReview=z.object({action:z.literal(MODULE_REVIEW_ACK_ACTION),contractVersion:z.literal(1),actionId:z.uuid(),reviewedDigest:digest,createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),review:OwnReviewAcknowledgementReview.omit({reviewDigest:true})}).strict();
export const ReviewModuleActionCompletedReceipt=z.object({action:z.literal(MODULE_REVIEW_ACK_ACTION),contractVersion:z.literal(1),actionId:z.uuid(),state:z.literal('completed'),receipt:OwnReviewAcknowledgementReceipt}).strict();
export const ReviewModuleActionRetiredReceipt=z.object({action:z.literal(MODULE_REVIEW_ACK_ACTION),contractVersion:z.literal(1),actionId:z.uuid(),state:z.enum(['discarded','expired','refused'])}).strict();
export const ReviewModuleActionReviewIndexResult=z.object({kind:z.literal('review_module_review_index'),reviews:z.array(z.object({action:z.literal(MODULE_REVIEW_ACK_ACTION),actionId:z.uuid(),state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25).refine(rows=>new Set(rows.map(row=>row.actionId)).size===rows.length)}).strict();

import {OwnOnehrPlanAcknowledgementIntent,OwnOnehrPlanAcknowledgementReview,OwnOnehrPlanAcknowledgementReceipt} from './own-onehr-plan-acknowledgement-contract';
export const MODULE_ONEHR_ACK_ACTION='performance.onehr.plan.acknowledge' as const;
export const OnehrModuleActionPrepare=z.object({action:z.literal(MODULE_ONEHR_ACK_ACTION),contractVersion:z.literal(1),intent:OwnOnehrPlanAcknowledgementIntent}).strict();
export const OnehrModuleActionConfirmation=z.object({action:z.literal(MODULE_ONEHR_ACK_ACTION),contractVersion:z.literal(1),actionId:z.uuid(),reviewedDigest:digest}).strict();
export const OnehrModuleActionPreparedReview=z.object({action:z.literal(MODULE_ONEHR_ACK_ACTION),contractVersion:z.literal(1),actionId:z.uuid(),reviewedDigest:digest,createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),review:OwnOnehrPlanAcknowledgementReview.omit({reviewDigest:true})}).strict();
export const OnehrModuleActionCompletedReceipt=z.object({action:z.literal(MODULE_ONEHR_ACK_ACTION),contractVersion:z.literal(1),actionId:z.uuid(),state:z.literal('completed'),receipt:OwnOnehrPlanAcknowledgementReceipt}).strict();
export const OnehrModuleActionRetiredReceipt=z.object({action:z.literal(MODULE_ONEHR_ACK_ACTION),contractVersion:z.literal(1),actionId:z.uuid(),state:z.enum(['discarded','expired','refused'])}).strict();
export const OnehrModuleActionReviewIndexResult=z.object({kind:z.literal('onehr_module_review_index'),reviews:z.array(z.object({action:z.literal(MODULE_ONEHR_ACK_ACTION),actionId:z.uuid(),state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25).refine(rows=>new Set(rows.map(row=>row.actionId)).size===rows.length)}).strict();

/** USER-bound Testing custody: a standalone tester has no invented person/employment identity. */
import {OwnTestingExecutionIntent,OwnTestingExecutionReview,OwnTestingExecutionReceipt} from './own-testing-execution-contract';
export const MODULE_TESTING_EXECUTION_ACTION='system_testing.execution.save' as const;
export const TestingModuleActionPrepare=z.object({action:z.literal(MODULE_TESTING_EXECUTION_ACTION),contractVersion:z.literal(1),intent:OwnTestingExecutionIntent}).strict();
export const TestingModuleActionConfirmation=z.object({action:z.literal(MODULE_TESTING_EXECUTION_ACTION),contractVersion:z.literal(1),actionId:z.uuid(),reviewedDigest:digest}).strict();
export const TestingModuleActionPreparedReview=z.object({action:z.literal(MODULE_TESTING_EXECUTION_ACTION),contractVersion:z.literal(1),actionId:z.uuid(),reviewedDigest:digest,createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),review:OwnTestingExecutionReview.omit({reviewDigest:true})}).strict();
export const TestingModuleActionCompletedReceipt=z.object({action:z.literal(MODULE_TESTING_EXECUTION_ACTION),contractVersion:z.literal(1),actionId:z.uuid(),state:z.literal('completed'),receipt:OwnTestingExecutionReceipt}).strict();
export const TestingModuleActionRetiredReceipt=z.object({action:z.literal(MODULE_TESTING_EXECUTION_ACTION),contractVersion:z.literal(1),actionId:z.uuid(),state:z.enum(['discarded','expired','refused'])}).strict();
export const TestingModuleActionReviewIndexResult=z.object({kind:z.literal('testing_module_review_index'),reviews:z.array(z.object({action:z.literal(MODULE_TESTING_EXECUTION_ACTION),actionId:z.uuid(),state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25).refine(rows=>new Set(rows.map(row=>row.actionId)).size===rows.length)}).strict();

/** Existing human DRAFT submission, distinct from saving a draft or direct-new/upload flows. */
import {OWN_CLAIM_SUBMISSION_ACTION,OwnClaimSubmissionHumanContent,OwnClaimSubmissionReview,OwnClaimSubmissionSourceReceipt} from './own-claim-submission-contract';
export const ClaimSubmissionModuleActionPrepare=OwnClaimSubmissionHumanContent;
export const ClaimSubmissionModuleActionConfirmation=z.object({action:z.literal(OWN_CLAIM_SUBMISSION_ACTION),contractVersion:z.literal(1),actionId:z.uuid(),reviewedDigest:digest}).strict();
export const ClaimSubmissionModuleActionPreparedReview=z.object({action:z.literal(OWN_CLAIM_SUBMISSION_ACTION),contractVersion:z.literal(1),actionId:z.uuid(),reviewedDigest:digest,createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),content:OwnClaimSubmissionHumanContent,review:OwnClaimSubmissionReview,consequence:z.literal('submitted_for_approval_not_approved_or_reimbursed')}).strict();
export const ClaimSubmissionModuleActionCompletedReceipt=z.object({action:z.literal(OWN_CLAIM_SUBMISSION_ACTION),contractVersion:z.literal(1),actionId:z.uuid(),state:z.literal('completed'),receipt:OwnClaimSubmissionSourceReceipt,semantics:z.literal('submitted_not_approved_or_reimbursed')}).strict();
export const ClaimSubmissionModuleActionRetiredReceipt=z.object({action:z.literal(OWN_CLAIM_SUBMISSION_ACTION),contractVersion:z.literal(1),actionId:z.uuid(),state:z.enum(['discarded','expired','refused'])}).strict();
export const ClaimSubmissionModuleActionReviewIndexResult=z.object({kind:z.literal('claim_submission_module_review_index'),reviews:z.array(z.object({action:z.literal(OWN_CLAIM_SUBMISSION_ACTION),actionId:z.uuid(),state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25).refine(rows=>new Set(rows.map(row=>row.actionId)).size===rows.length)}).strict();
