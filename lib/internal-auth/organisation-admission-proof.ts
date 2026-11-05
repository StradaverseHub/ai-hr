/** Purpose key cannot decrypt Auth records. Proof contains bounded account identifiers and availability, without credential secrets or employee field values. */
import {createHmac} from 'node:crypto';
import {z} from 'zod';
import {isCalendarDate} from '../calendar-date';
const PURPOSE='aihr-company-organisation-admission-v1';
// Existing PostgreSQL tenant/user/person IDs need canonical UUID syntax, not RFC version/variant bits.
// Auth subjects remain server-generated RFC UUIDs; proof binding and availability are checked separately.
const databaseId=z.guid();
export function organisationAdmissionKey(master:string):Buffer {
 if(!/^[a-fA-F0-9]{64}$/.test(master))throw Error('Invalid authentication key.');
 return createHmac('sha256',Buffer.from(master,'hex')).update(PURPOSE).digest();
}
export const organisationAdmissionClaims=z.object({v:z.literal(1),purpose:z.literal(PURPOSE),tenantId:databaseId,userId:databaseId,personId:databaseId.nullable(),issuer:z.string().url().max(500),subject:z.uuid(),bindingCreatedAt:z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),credentialDigest:z.string().regex(/^[a-f0-9]{64}$/),available:z.boolean(),activeUntil:z.string().refine(isCalendarDate).nullable(),issuedAt:z.number().int().nonnegative().safe(),expiresAt:z.number().int().nonnegative().safe()}).strict().refine(c=>c.expiresAt>c.issuedAt&&c.expiresAt-c.issuedAt<=60_000);
export type OrganisationAdmissionClaims=z.infer<typeof organisationAdmissionClaims>;
export function signOrganisationAdmission(claims:Omit<OrganisationAdmissionClaims,'v'|'purpose'>,master:string){
 const payload=JSON.stringify(organisationAdmissionClaims.parse({v:1,purpose:PURPOSE,...claims}));
 return {payload,signature:createHmac('sha256',organisationAdmissionKey(master)).update(payload).digest('hex')};
}
