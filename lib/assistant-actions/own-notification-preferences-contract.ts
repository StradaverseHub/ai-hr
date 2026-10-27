/** Human selection only: identity, sender, recipients, templates and delivery retries are absent. */
import {z} from 'zod';
import {employmentNotificationPreferenceCategory as notificationPreferenceCategory,employmentNotificationPreferenceCategories as notificationPreferenceCategories,notificationEmailLocales} from '../notification-email-model';
export const OwnNotificationPreferencesIntent=z.object({version:z.literal(1),employmentId:z.uuid(),
 enabledCategories:z.array(notificationPreferenceCategory).max(notificationPreferenceCategories.length).refine(values=>new Set(values).size===values.length),
 locale:z.enum(notificationEmailLocales),consent:z.literal('selected_categories_only')}).strict().transform(input=>({...input,
 enabledCategories:notificationPreferenceCategories.filter(category=>input.enabledCategories.includes(category))}));
export type OwnNotificationPreferencesIntent=z.infer<typeof OwnNotificationPreferencesIntent>;
const digest=z.string().regex(/^[a-f0-9]{64}$/);
export const OwnNotificationPreferencesReview=z.object({version:z.literal(1),kind:z.literal('own_notification_preferences'),employmentId:z.uuid(),
 before:z.array(z.object({category:notificationPreferenceCategory,enabled:z.boolean(),locale:z.enum(notificationEmailLocales).nullable()}).strict()),
 after:z.object({enabledCategories:z.array(notificationPreferenceCategory),locale:z.enum(notificationEmailLocales)}).strict(),reviewDigest:digest}).strict();
export type OwnNotificationPreferencesReview=z.infer<typeof OwnNotificationPreferencesReview>;
export const OwnNotificationPreferencesReceipt=z.object({version:z.literal(1),kind:z.literal('own_notification_preferences'),employmentId:z.uuid(),
 eventId:z.uuid(),resultDigest:digest,enabledCategories:z.array(notificationPreferenceCategory),locale:z.enum(notificationEmailLocales)}).strict();
export type OwnNotificationPreferencesReceipt=z.infer<typeof OwnNotificationPreferencesReceipt>;
