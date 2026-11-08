import {z} from 'zod';
/** Bank arrangement evidence is explicit; the supplied format does not disclose its hash algorithm. */
export const maybankPaymentSettingsSchema=z.object({version:z.literal('7.4'),hashMode:z.enum(['unconfirmed','not-required']),zakatClassification:z.enum(['1','2','3','4','5']).default('1')}).strict();
export type MaybankPaymentSettings=z.infer<typeof maybankPaymentSettingsSchema>;
