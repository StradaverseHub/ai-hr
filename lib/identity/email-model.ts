import type { ManagedEmailSenderProfile } from '../managed-email-policy';
import { z } from 'zod';
import { domainToASCII } from 'node:url';
import { isIP } from 'node:net';

export const emailConfigSchema = z.object({
  host: z.string().trim().min(1).max(253).transform(h => isIP(h) ? h : domainToASCII(h).toLowerCase()).refine(h => !!h && (isIP(h) !== 0 || /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(h)) && !h.includes('..')),
  port: z.number().int().min(1).max(65535),
  security: z.enum(['tls', 'starttls']),
  from: z.email().max(320).regex(/^[\x21-\x7e]+$/),
  fromName: z.string().trim().max(160).regex(/^[^\x00-\x1f\x7f]*$/),
  replyTo: z.union([z.literal(''),z.email().max(320).regex(/^[\x21-\x7e]+$/)]),
  auth: z.boolean(),
  user: z.string().trim().max(320).regex(/^[^\x00-\x1f\x7f]*$/),
  authentication: z.literal('microsoft365').optional(),
  oauth2: z.object({tenantId:z.uuid(),clientId:z.uuid()}).strict().optional(),
}).strict().superRefine((c,ctx) => {
  if (c.auth && !c.user) ctx.addIssue({code:'custom',path:['user'],message:'Username required.'});
  if(c.authentication==='microsoft365') {
    if(!c.auth||!c.oauth2||!z.email().safeParse(c.user).success||c.host!=='smtp.office365.com'||c.port!==587||c.security!=='starttls')
      ctx.addIssue({code:'custom',path:['authentication'],message:'Microsoft 365 requires a mailbox, tenant/application IDs and smtp.office365.com:587 with STARTTLS.'});
  } else if(c.oauth2) ctx.addIssue({code:'custom',path:['oauth2'],message:'OAuth configuration requires Microsoft 365 authentication.'});
});
export type EmailConfig = z.infer<typeof emailConfigSchema>;
/** A blank secret may retain only the same credential identity, never another tenant/application. */
export function sameEmailCredential(a:EmailConfig,b:EmailConfig) {
  return a.auth&&b.auth&&a.host===b.host&&a.user===b.user&&a.authentication===b.authentication
    &&a.oauth2?.tenantId===b.oauth2?.tenantId&&a.oauth2?.clientId===b.oauth2?.clientId;
}
// PostgreSQL accepts canonical UUIDs without an RFC version/variant restriction (including existing seed IDs).
const internalId = z.string().regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
export const identityEmailActorSchema = z.object({userId:internalId,tenantId:internalId,issuer:z.string().url().max(500),subject:z.string().min(1).max(500)}).strict();
export type IdentityEmailActor = z.infer<typeof identityEmailActorSchema>;
export const emailFailureCodes = ['unavailable','forbidden','invalid','conflict','needsTest','needsReceipt','authenticationFailed','connectionFailed','tlsFailed','rejected','uncertain','appliedAuditFailed'] as const;
export type EmailFailureCode = typeof emailFailureCodes[number];
export class EmailSettingsError extends Error {
  constructor(public readonly code: EmailFailureCode) { super(`Identity email settings: ${code}`); }
}
export type EmailSettingsView = {
  supportsLifecycleSenders?: boolean;
  lifecycleSenders?: { profile: ManagedEmailSenderProfile; from: string | null; connectionId?: string; appliedAt?: string; hasUnappliedChanges: boolean }[];
  connections?: {id:string;name:string;config:EmailConfig;hasPassword:boolean;active:boolean;hasUnappliedChanges:boolean;testedAt:string|null}[];
  selectedConnectionId?:string;
  selectedConnectionName?:string;
  active: (EmailConfig & {hasPassword:boolean}) | null;
  revision: string;
  draft: {id:string;config:EmailConfig;hasPassword:boolean;testedAt:string|null} | null;
  testRecipient: string;
};
export const defaultEmailConfig: EmailConfig = {host:'',port:465,security:'tls',from:'',fromName:'AI HR',replyTo:'',auth:true,user:''};
export type EmailSettingsRequest =
  | {op:'readiness'}
  | {op:'view';actor:IdentityEmailActor;connectionId?:string}
  | {op:'save';actor:IdentityEmailActor;revision:string;config:EmailConfig;password?:string;connectionId?:string;connectionName?:string}
  | {op:'test';actor:IdentityEmailActor;draftId:string;connectionId?:string}
  | {op:'apply';actor:IdentityEmailActor;draftId:string;received:boolean;connectionId?:string;lifecycleSender?:ManagedEmailSenderProfile};
