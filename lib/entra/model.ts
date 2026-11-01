import { z } from 'zod';
export const entraConfigSchema = z.object({
  tenantId: z.uuid(), organization: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
  directoryTenantId: z.uuid(), clientId: z.union([z.uuid(),z.literal('')]), clientSecret: z.string().max(4096),
  provisioningClientId: z.union([z.uuid(),z.literal('')]), provisioningClientSecret: z.string().max(4096),
  servicePrincipalId: z.union([z.uuid(),z.literal('')]), jobId: z.union([z.string().regex(/^[a-zA-Z0-9._-]{1,200}$/),z.literal('')]),
  sourceAnchorAttribute: z.union([z.string().regex(/^(?:extension_[a-f0-9]{32}_hrSourceId|onPremisesExtensionAttributes\.extensionAttribute(?:[1-9]|1[0-5]))$/),z.literal('')]),
  mode: z.enum(['cloud', 'hybrid']), domain: z.union([z.string().toLowerCase().regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/).max(253),z.literal('')]),
  enabled: z.boolean(), provisioningEnabled: z.boolean(), immutableMatchingConfirmed: z.boolean(),
  revision: z.uuid(),
}).strict().superRefine((value,ctx)=>{
  const keys=value.provisioningEnabled?['provisioningClientId','provisioningClientSecret','servicePrincipalId','jobId','domain','sourceAnchorAttribute'] as const:[];
  for(const key of keys)if(!value[key])ctx.addIssue({code:'custom',path:[key],message:'Required for provisioning'});
  if(value.provisioningEnabled&&!value.immutableMatchingConfirmed)ctx.addIssue({code:'custom',path:['immutableMatchingConfirmed'],message:'Immutable matching must be confirmed'});
  if(value.enabled)for(const key of ['clientId','clientSecret'] as const)if(!value[key])ctx.addIssue({code:'custom',path:[key],message:'Required for Microsoft sign-in'});
});
export type EntraConfig = z.infer<typeof entraConfigSchema>;
export class EntraError extends Error {
  constructor(public code: 'invalid' | 'forbidden' | 'conflict' | 'unavailable' | 'throttled' | 'uncertain', public retryAfter = 60) { super(`Entra: ${code}`); }
}
export const issuerFor = (tenant: string) => `https://login.microsoftonline.com/${z.uuid().parse(tenant).toLowerCase()}/v2.0`;
export const sourceId = (tenant: string, person: string) => `aihr:${z.uuid().parse(tenant)}:${z.uuid().parse(person)}`;
export type WorkforceRecord = { tenant_id: string; person_id: string; full_name: string; active: boolean; revision: number; lease: string; mode: 'cloud'|'hybrid'; last_location: string|null; last_status: string; source_key: string; submitted_revision:number|null; last_active:boolean|null; submission_started_at:string|null };
/** Stable identifier based naming avoids email-based adoption and rename collisions. IT maps userName to UPN. */
export function workforcePayload(record: WorkforceRecord, config: EntraConfig) {
  if (record.tenant_id !== config.tenantId || record.mode !== config.mode) throw new EntraError('forbidden');
  return { schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'], Operations: [{ method: 'POST', bulkId: `${record.person_id}:${record.revision}`, path: '/Users', data: {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], externalId: sourceId(record.tenant_id, record.person_id),
    userName: `hr-${record.person_id.replaceAll('-', '')}@${config.domain}`, displayName: record.full_name, active: record.active,
  } }] };
}
export function trustedGraphUrl(value: string): URL {
  const url = new URL(value);
  if (url.origin !== 'https://graph.microsoft.com' || url.username || url.password || url.hash || !/^\/v1\.0\/auditLogs\/provisioning(?:\/[^/?]+)?\/?$/.test(url.pathname)) throw new EntraError('invalid');
  return url;
}
export function nativeRedirect(value: string) {
  const allowed = (process.env.ENTRA_NATIVE_REDIRECT_URIS || 'aihr://auth/callback').split(',');
  if (!allowed.includes(value) || value.includes('?') || value.includes('#')) throw new EntraError('invalid');
  return value;
}
