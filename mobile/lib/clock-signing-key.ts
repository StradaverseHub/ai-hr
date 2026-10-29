/** A freshly reconciled local key reference. This is not server authorization or device/GPS trust. */
import {z} from 'zod';
import {AppleEnrollmentSettings} from '../../lib/mobile-key-enrollment';
const uuid=z.string().uuid().transform(value=>value.toLowerCase());
const fields={apiOrigin:AppleEnrollmentSettings.shape.apiOrigin,actorId:uuid,appInstallationId:uuid,
 installationId:uuid,tenantId:uuid,keyId:uuid,appId:z.string().min(1).max(300)};
export const ClockSigningKey=z.discriminatedUnion('platform',[
 z.object({...fields,platform:z.literal('ios'),nativeReference:z.string().length(44).regex(/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/)}).strict(),
 z.object({...fields,platform:z.literal('android'),nativeReference:z.string().length(69).regex(/^aihr_[a-f0-9]{64}$/)}).strict(),
]);
export type ClockSigningKey=z.infer<typeof ClockSigningKey>;
