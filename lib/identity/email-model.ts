import { z } from 'zod';
import { domainToASCII } from 'node:url';
import { isIP } from 'node:net';

export const emailConfigSchema = z.object({
  host: z.string().trim().min(1).max(253).transform(h => isIP(h) ? h : domainToASCII(h).toLowerCase()).refine(h => !!h && (isIP(h) !== 0 || /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(h)) && !h.includes('..')),
  port: z.number().int().min(1).max(65535),
  security: z.literal('tls'),
  from: z.email().max(320).regex(/^[\x21-\x7e]+$/),
  fromName: z.string().trim().max(160).regex(/^[^\x00-\x1f\x7f]*$/),
  replyTo: z.union([z.literal(''),z.email().max(320).regex(/^[\x21-\x7e]+$/)]),
  auth: z.boolean(),
  user: z.string().trim().max(320).regex(/^[^\x00-\x1f\x7f]*$/),
}).strict().superRefine((c,ctx) => {
  if (c.auth && !c.user) ctx.addIssue({code:'custom',path:['user'],message:'Username required.'});
});
export type EmailConfig = z.infer<typeof emailConfigSchema>;
export const identityEmailActorSchema = z.object({userId:z.uuid(),tenantId:z.uuid(),issuer:z.string().url().max(500),subject:z.string().min(1).max(500)}).strict();
export type IdentityEmailActor = z.infer<typeof identityEmailActorSchema>;
export const emailFailureCodes = ['unavailable','forbidden','invalid','conflict','needsTest','needsReceipt','authenticationFailed','connectionFailed','tlsFailed','rejected','uncertain','appliedAuditFailed'] as const;
export type EmailFailureCode = typeof emailFailureCodes[number];
export class EmailSettingsError extends Error {
  constructor(public readonly code: EmailFailureCode) { super(`Identity email settings: ${code}`); }
}
export type EmailSettingsView = {
  active: (EmailConfig & {hasPassword:boolean}) | null;
  revision: string;
  draft: {id:string;config:EmailConfig;hasPassword:boolean;testedAt:string|null} | null;
  testRecipient: string;
};
export const defaultEmailConfig: EmailConfig = {host:'',port:465,security:'tls',from:'',fromName:'AI HR',replyTo:'',auth:true,user:''};
export type EmailSettingsRequest =
  | {op:'readiness'}
  | {op:'view';actor:IdentityEmailActor}
  | {op:'save';actor:IdentityEmailActor;revision:string;config:EmailConfig;password?:string}
  | {op:'test';actor:IdentityEmailActor;draftId:string}
  | {op:'apply';actor:IdentityEmailActor;draftId:string;received:boolean};
