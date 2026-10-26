/** Server-side only: never import into a public contract/client module. The fresh secret nonce
 * lives only inside the encrypted review body. Public tokens must not expose low-entropy private
 * native source fingerprints through an unkeyed deterministic hash. No new key/env/storage owner.
 * This is an integrity/commitment primitive, not authority, source freshness or effect consent. */
import {createHash,randomBytes} from 'node:crypto';
import {z} from 'zod';
export const PrivateReviewNonce=z.string().regex(/^[a-f0-9]{64}$/);
export function newPrivateReviewNonce():string{return randomBytes(32).toString('hex');}
export function privateReviewCommitment(scope:readonly unknown[],body:{reviewNonce:string}):string{
 PrivateReviewNonce.parse(body.reviewNonce);
 return createHash('sha256').update(JSON.stringify(['assistant-private-review:1',scope,body])).digest('hex');
}
