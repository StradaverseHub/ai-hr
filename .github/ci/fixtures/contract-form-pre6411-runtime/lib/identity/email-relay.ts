/** Closed stored-vs-delivery credential shapes. No database, Auth key or token acquisition. */
import {z} from 'zod';
import {emailConfigSchema} from './email-model';
export const storedEmailRelay=z.object({config:emailConfigSchema,password:z.string().max(4096).optional()}).strict()
 .refine(value=>!value.config.auth||Boolean(value.password));
export const deliveryEmailRelay=z.object({config:emailConfigSchema,password:z.string().max(4096).optional(),
 accessToken:z.string().min(1).max(16384).regex(/^[\x21-\x7e]+$/).optional(),accessTokenExpiresAt:z.number().int().positive().optional(),
}).strict().superRefine((value,ctx)=>{
 if(value.config.authentication==='microsoft365') {
  if(value.password!==undefined||!value.accessToken||!value.accessTokenExpiresAt)
   ctx.addIssue({code:'custom',message:'Microsoft 365 delivery requires only a short-lived token.'});
 } else if(value.accessToken!==undefined||value.accessTokenExpiresAt!==undefined||value.config.auth&&!value.password)
  ctx.addIssue({code:'custom',message:'Invalid SMTP delivery credentials.'});
});
export type StoredEmailRelay=z.infer<typeof storedEmailRelay>;
export type DeliveryEmailRelay=z.infer<typeof deliveryEmailRelay>;
export type EmailRelay=StoredEmailRelay|DeliveryEmailRelay;
