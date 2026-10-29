/** Portable expected Android app/key policy. Parsing never verifies evidence or authorizes a device. */
import {z} from 'zod';
const digest=z.string().length(44).regex(/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/);
const version=z.string().max(20).regex(/^(0|[1-9][0-9]*)$/).refine(value=>value.trim()===value&&BigInt(value)<=BigInt('18446744073709551615'));
const month=z.number().int().min(200001).max(999912).refine(value=>value%100>=1&&value%100<=12);
const day=z.number().int().min(20000101).max(99991231).refine(value=>{const s=String(value),date=`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;return z.iso.date().safeParse(date).success;});
export const AndroidKeyPolicy=z.object({packageName:z.string().min(3).max(255).refine(value=>value.trim()===value).regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/),
 certificateDigests:z.array(digest).min(1).max(8).transform(values=>[...new Set(values)].sort()),
 versionCodes:z.array(version).min(1).max(20).transform(values=>[...new Set(values)].sort()),
 provisioningMetadata:z.enum(['allow_legacy','require_entity_and_lost_device']),
 securityLevels:z.array(z.enum(['tee','strongbox'])).min(1).max(2).transform(values=>[...new Set(values)].sort()),
 minimumOsVersion:z.number().int().min(0).max(999999).nullable(),minimumOsPatchLevel:month.nullable(),
 minimumVendorPatchLevel:day.nullable(),minimumBootPatchLevel:day.nullable(),
}).strict();
