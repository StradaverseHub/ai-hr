/** Portable enrollment bytes. Public context is not authority without the server's stored challenge. */
import {z} from 'zod';
const uuid=z.string().uuid().transform(value=>value.toLowerCase());
export const AppleEnrollmentTarget=z.object({platform:z.literal('ios'),appId:z.string().min(12).max(300).refine(value=>value.trim()===value)
  .regex(/^[A-Za-z0-9]{10}\.[A-Za-z0-9][A-Za-z0-9.-]+$/),environment:z.enum(['production','development']),
  requiredMetadata:z.object({validationCategory:z.union([z.literal(1),z.literal(2),z.literal(3),z.literal(4),z.literal(5),z.literal(6),z.literal(10)]),
    bundleVersions:z.array(z.string().min(1).max(64)).min(1).max(20).transform(values=>[...new Set(values)].sort())}).strict().nullable(),
}).strict();
export const KeyEnrollmentContext=z.object({version:z.literal(1),purpose:z.literal('device.key.enrollment'),
  apiOrigin:z.string().max(300).refine(value=>{try{return new URL(value).protocol==='https:'&&new URL(value).origin===value;}catch{return false;}}),
  installationId:uuid,tenantId:uuid,actorId:uuid,employmentId:uuid,appInstallationId:uuid,
  requestId:uuid,challengeId:uuid,nonce:z.string().length(43).regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/),
  issuedAt:z.number().int().positive().max(8640000000000000),expiresAt:z.number().int().positive().max(8640000000000000),
  target:AppleEnrollmentTarget,
}).strict().refine(value=>value.expiresAt>value.issuedAt&&value.expiresAt-value.issuedAt<=600000);
export type KeyEnrollmentContext=z.infer<typeof KeyEnrollmentContext>;
export function keyEnrollmentClientData(input:unknown):string{
  const p=KeyEnrollmentContext.parse(input),t=p.target;
  return JSON.stringify(['aihr.mobile.integrity',p.version,p.purpose,
    [p.apiOrigin,p.installationId,p.tenantId,p.actorId,p.employmentId,p.appInstallationId],
    [p.requestId,p.challengeId,p.nonce,p.issuedAt,p.expiresAt],
    [t.platform,t.appId,t.environment,t.requiredMetadata?[t.requiredMetadata.validationCategory,t.requiredMetadata.bundleVersions]:null],
  ]);
}
