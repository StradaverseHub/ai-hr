import {z} from 'zod';
/** The reporter approved an initial blank hash. Bank upload acceptance is a separate check. */
export const maybankPaymentSettingsSchema=z.object({version:z.literal('7.4'),hashMode:z.enum(['unconfirmed','not-required']),zakatClassification:z.enum(['1','2','3','4','5']).default('1')}).strict();
export type MaybankPaymentSettings=z.infer<typeof maybankPaymentSettingsSchema>;

export const DEFAULT_MAYBANK_PAYMENT_SETTINGS:MaybankPaymentSettings=Object.freeze({version:'7.4',hashMode:'not-required',zakatClassification:'1'});
