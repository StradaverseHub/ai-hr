/** Closed human review contract. No posted actor, native receipt, identity, service or model executor. */
import {z} from 'zod';
import {OwnNotificationPreferencesIntent,OwnNotificationPreferencesReview} from './own-notification-preferences-contract';
import {notificationPreferenceCategory,notificationEmailLocales} from '../notification-email-model';
export const MODULE_NOTIFICATION_ACTION='notifications.email_preferences.save' as const;
const digest=z.string().regex(/^[a-f0-9]{64}$/);
export const ModuleActionPrepare=z.object({action:z.literal(MODULE_NOTIFICATION_ACTION),contractVersion:z.literal(1),intent:OwnNotificationPreferencesIntent}).strict();
export const ModuleActionConfirmation=z.object({action:z.literal(MODULE_NOTIFICATION_ACTION),contractVersion:z.literal(1),actionId:z.uuid(),reviewedDigest:digest}).strict();
export const ModuleActionPreparedReview=z.object({action:z.literal(MODULE_NOTIFICATION_ACTION),contractVersion:z.literal(1),actionId:z.uuid(),reviewedDigest:digest,
 createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),review:OwnNotificationPreferencesReview}).strict();
/** Recorded native effect reconciled with current values; never a latest-event or delivery claim. */
export const ModuleActionCompletedReceipt=z.object({action:z.literal(MODULE_NOTIFICATION_ACTION),contractVersion:z.literal(1),actionId:z.uuid(),state:z.literal('completed'),
 sourceEventId:z.uuid(),employmentId:z.uuid(),enabledCategories:z.array(notificationPreferenceCategory),locale:z.enum(notificationEmailLocales),
 semantics:z.literal('recorded_effect_current_values')}).strict();
export const ModuleActionRetiredReceipt=z.object({action:z.literal(MODULE_NOTIFICATION_ACTION),contractVersion:z.literal(1),actionId:z.uuid(),state:z.enum(['discarded','expired','refused'])}).strict();
export const ModuleActionReviewIndexResult=z.object({kind:z.literal('module_review_index'),reviews:z.array(z.object({action:z.literal(MODULE_NOTIFICATION_ACTION),actionId:z.uuid(),state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25).refine(rows=>new Set(rows.map(row=>row.actionId)).size===rows.length)}).strict();
