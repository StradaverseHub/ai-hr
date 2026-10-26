/** M04 protocol primitive. Parsing or hashing this data grants no identity, trust or attendance. */
import {z} from 'zod';

const uuid=z.string().uuid().transform(value=>value.toLowerCase());
const instant=z.number().int().positive().max(8640000000000000);
const sha256=z.string().length(64).regex(/^[0-9a-f]{64}$/);
const nonce=z.string().length(43).regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
const origin=z.string().max(300).refine(value=>{
  try{const url=new URL(value);return url.protocol==='https:'&&url.origin===value&&!url.username&&!url.password;}
  catch{return false;}
});

export const OnlineClockIntegrityData=z.object({
  version:z.literal(1),purpose:z.literal('attendance.clock.online'),
  // The server must supply this origin from deployment configuration, never Host/Forwarded headers.
  scope:z.object({apiOrigin:origin,tenantId:uuid,actorId:uuid,employmentId:uuid,deviceKeyId:uuid}).strict(),
  // A stored, one-use server challenge. These fields alone do not prove issuance or freshness.
  challenge:z.object({id:uuid,nonce,expiresAt:instant}).strict(),
  command:z.object({requestId:uuid,action:z.enum(['in','out']),
    lat:z.number().finite().min(-90).max(90),lng:z.number().finite().min(-180).max(180),
    accuracy:z.number().finite().nonnegative(),sampledAt:instant,
    // Digest of the exact transmitted attachment bytes, before any image decoding/transformation.
    photo:z.object({sha256,byteLength:z.number().int().positive().max(2*1024*1024),
      mimeType:z.enum(['image/jpeg','image/png'])}).strict().nullable(),
  }).strict(),
}).strict();
export type OnlineClockIntegrityData=z.infer<typeof OnlineClockIntegrityData>;

/** Fixed positional encoding, independent of JSON property insertion order. SHA-256 the UTF-8 bytes.
 * Do not use the journal's private storage digest, raw multipart bytes or a caller-provided digest.
 * Scope/challenge must be reconstructed from authenticated server records at verification time.
 */
export function onlineClockClientData(input:unknown):string{
  const data=OnlineClockIntegrityData.parse(input),s=data.scope,c=data.challenge,p=data.command;
  return JSON.stringify(['aihr.mobile.integrity',data.version,data.purpose,
    [s.apiOrigin,s.tenantId,s.actorId,s.employmentId,s.deviceKeyId],
    [c.id,c.nonce,c.expiresAt],
    [p.requestId,p.action,p.lat,p.lng,p.accuracy,p.sampledAt,
      p.photo?[p.photo.sha256,p.photo.byteLength,p.photo.mimeType]:null],
  ]);
}
