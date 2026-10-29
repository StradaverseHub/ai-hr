/** Pins the native client's Android sync-time Play requestHash (mobile/lib/offline-sync-hash.ts) to the server owner
 * (offlineSyncRequestHash in lib/mobile-api/offline-sync-integrity.ts), including the signatureSha256 derivation the
 * deployed preparer uses (hex sha256 of the base64-decoded original claim signature). No network, database or device. */
import {createHash,randomBytes} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {offlineSyncRequestHash as serverHash} from '../lib/mobile-api/offline-sync-integrity';
import {offlineSyncRequestHash as clientHash,base64Bytes,base64url} from '../mobile/lib/offline-sync-hash';
import {OfflineClockAndroidSignature} from '../lib/mobile-offline-clock';
const sha256=async(bytes:Uint8Array)=>new Uint8Array(createHash('sha256').update(bytes).digest());
describe('offline sync requestHash: client and server agree',()=>{
 it.each([8,70,71,72])('a %i-byte original signature, several builds and digests',async length=>{
  for(const syncBuildVersion of ['1','4','9223372036854775807']){
   const signature=randomBytes(length).toString('base64'),claimDigest=createHash('sha256').update(randomBytes(16)).digest('hex');
   expect(OfflineClockAndroidSignature.safeParse(signature).success).toBe(true);
   const expected=serverHash({claimDigest,signatureSha256:createHash('sha256').update(Buffer.from(signature,'base64')).digest('hex'),syncBuildVersion});
   const actual=await clientHash({claimDigest,signature,syncBuildVersion},sha256);
   expect(actual).toBe(expected);expect(actual).toMatch(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
  }
 });
 it('changes with every bound input (digest, signature, build)',async()=>{
  const signature=randomBytes(70).toString('base64'),claimDigest='a'.repeat(64),base=await clientHash({claimDigest,signature,syncBuildVersion:'4'},sha256);
  expect(await clientHash({claimDigest:'b'.repeat(64),signature,syncBuildVersion:'4'},sha256)).not.toBe(base);
  expect(await clientHash({claimDigest,signature:randomBytes(70).toString('base64'),syncBuildVersion:'4'},sha256)).not.toBe(base);
  expect(await clientHash({claimDigest,signature,syncBuildVersion:'5'},sha256)).not.toBe(base);
 });
 it('decodes and encodes base64 exactly as Node does, and refuses non-canonical input',()=>{
  for(let length=0;length<80;length++){
   const bytes=randomBytes(length);
   expect(Buffer.from(base64Bytes(bytes.toString('base64')))).toEqual(bytes);
   expect(base64url(Uint8Array.from(bytes))).toBe(bytes.toString('base64url'));
  }
  for(const bad of ['A','AA=','A===','AB C','AB-_'])expect(()=>base64Bytes(bad)).toThrow();
 });
});
