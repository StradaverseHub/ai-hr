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
