/** Canonical Android enrollment bytes. Public context is not authority without its stored challenge. */
import {z} from 'zod';
import {KeyEnrollmentContext} from './mobile-key-enrollment';
import {AndroidKeyPolicy} from './mobile-android-key-policy';
export const AndroidEnrollmentTarget=AndroidKeyPolicy.extend({platform:z.literal('android')}).strict();
export const AndroidEnrollmentSettings=z.object({apiOrigin:KeyEnrollmentContext.shape.apiOrigin,target:AndroidEnrollmentTarget}).strict();
export const AndroidEnrollmentContext=z.object({...KeyEnrollmentContext.shape,target:AndroidEnrollmentTarget}).strict()
 .refine(value=>value.expiresAt>value.issuedAt&&value.expiresAt-value.issuedAt<=600000);
export type AndroidEnrollmentContext=z.infer<typeof AndroidEnrollmentContext>;
const spkiReference=z.string().min(88).max(344).refine(value=>value.trim()===value)
 .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$/)
 .refine(value=>{const size=value.length/4*3-(value.endsWith('==')?2:value.endsWith('=')?1:0);return size>=64&&size<=256;});
const certificate=z.string().min(4).max(21848).refine(value=>value.trim()===value)
 .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$/)
 .refine(value=>value.length/4*3-(value.endsWith('==')?2:value.endsWith('=')?1:0)<=16384);
export const AndroidEnrollmentKeyArtifact=z.object({publicKeySpki:spkiReference,certificateChain:z.array(certificate).min(2).max(8)}).strict()
 .refine(value=>JSON.stringify(['aihr.android.enrollment.proof',1,value.publicKeySpki,value.certificateChain]).length<=32768);
export const AndroidEnrollmentPreparation=z.object({protocol:z.literal(2),state:z.enum(['active','expired','consumed']),context:AndroidEnrollmentContext,
 clientDataHash:z.string().length(44).regex(/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/),alias:z.string().length(69).regex(/^aihr_[0-9a-f]{64}$/)});
/** Public-key receipt reference only. Parsing these bytes never verifies a key or certificate. */
export function androidNativeKeyReferenceData(publicKeySpki:string):string{
 return JSON.stringify(['aihr.android.native-key',1,spkiReference.parse(publicKeySpki)]);
}
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
