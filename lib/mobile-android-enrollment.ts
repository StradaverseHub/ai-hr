/** Canonical Android enrollment bytes. Public context is not authority without its stored challenge. */
import {z} from 'zod';
import {KeyEnrollmentContext} from './mobile-key-enrollment';
import {AndroidKeyPolicy} from './mobile-android-key-policy';
export const AndroidEnrollmentTarget=AndroidKeyPolicy.extend({platform:z.literal('android')}).strict();
export const AndroidEnrollmentSettings=z.object({apiOrigin:KeyEnrollmentContext.shape.apiOrigin,target:AndroidEnrollmentTarget}).strict();
export const AndroidEnrollmentContext=z.object({...KeyEnrollmentContext.shape,target:AndroidEnrollmentTarget}).strict()
 .refine(value=>value.expiresAt>value.issuedAt&&value.expiresAt-value.issuedAt<=600000);
export type AndroidEnrollmentContext=z.infer<typeof AndroidEnrollmentContext>;
export function androidEnrollmentAliasData(input:unknown):string{
 const p=AndroidEnrollmentContext.parse(input);
 return JSON.stringify(['aihr-android-key-alias',1,p.installationId,p.tenantId,p.actorId,p.appInstallationId,p.challengeId]);
}
export function androidEnrollmentClientData(input:unknown):string{
 const p=AndroidEnrollmentContext.parse(input),t=p.target;
 return JSON.stringify(['aihr.mobile.integrity',p.version,p.purpose,
  [p.apiOrigin,p.installationId,p.tenantId,p.actorId,p.employmentId,p.appInstallationId],
  [p.requestId,p.challengeId,p.nonce,p.issuedAt,p.expiresAt],
  [t.platform,t.packageName,t.certificateDigests,t.versionCodes,t.securityLevels,t.provisioningMetadata,
   [t.minimumOsVersion,t.minimumOsPatchLevel,t.minimumVendorPatchLevel,t.minimumBootPatchLevel]],
 ]);
}
