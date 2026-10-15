import { z } from 'zod';
import { emailConfigSchema } from './identity/email-model';

export const demoSmtpSchema=z.object({
  host:emailConfigSchema.shape.host,
  port:emailConfigSchema.shape.port,
  security:z.enum(['tls','starttls']),
  auth:z.boolean(),user:emailConfigSchema.shape.user,password:z.string().max(4096),
}).strict().superRefine((c,ctx)=>{
  if(c.auth&&(!c.user||!c.password))ctx.addIssue({code:'custom',path:['password'],message:'Enter username and password.'});
});
export type DemoSmtpConfig=z.infer<typeof demoSmtpSchema>;
export type DemoSmtpFailure='forbidden'|'invalid'|'blockedHost'|'busy'|'authenticationFailed'|'tlsFailed'|'connectionFailed'|'unavailable';
export type DemoSmtpResult={status:'success';authenticated:boolean}|{status:'error';code:DemoSmtpFailure};
