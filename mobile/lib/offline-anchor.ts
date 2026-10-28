/** Device-only offline identity anchor (owner decisions 3 and 5, 2026-10-28). Not authority: it only lets an offline cold
 * start open THIS session's own sealed journals without `me`. A sealed file under the submission master. The former
 * issuer-registry cache is gone (owner decision D16, 29 October 2026: the server signs no context).
 *
 * Anchor lifecycle: written (online, from a verified `me` + offline capabilities) before an offline reservation, rebuilt by
 * the same actor's next online open while its exchange exists, deleted when that exchange clears, and deleted by every
 * logout (auth.ts remove), so a different user signing in can never open, see or send another account's queue. */
import {z} from 'zod';
import {AppleEnrollmentSettings} from '../../lib/mobile-key-enrollment';
import {offlineClockingBuild} from './config';
import {isNoConnectivity} from './errors';
import {readSealedDeviceRecord,writeSealedDeviceRecord,deleteSealedDeviceRecord} from './submission-native';
const uuid=z.string().uuid().transform(value=>value.toLowerCase());
export const OfflineAnchor=z.object({version:z.literal(1),namespace:z.string().min(1).max(2048),apiOrigin:AppleEnrollmentSettings.shape.apiOrigin,
 actorId:uuid,employmentId:uuid,companyId:uuid,platform:z.enum(['ios','android'])}).strict();
export type OfflineAnchor=z.infer<typeof OfflineAnchor>;
/** An unreadable record is absent, never another identity. */
export async function readOfflineAnchor(assertCurrent:()=>void):Promise<OfflineAnchor|null>{
 if(!offlineClockingBuild)return null;
 let raw:unknown;try{raw=await readSealedDeviceRecord('offline-anchor',assertCurrent);}catch{assertCurrent();return null;}
 const parsed=OfflineAnchor.safeParse(raw);return parsed.success?parsed.data:null;
}
export async function writeOfflineAnchor(anchor:OfflineAnchor,assertCurrent:()=>void){
 const value=OfflineAnchor.parse(anchor),current=await readOfflineAnchor(assertCurrent);
 if(current&&JSON.stringify(current)===JSON.stringify(value))return;
 await writeSealedDeviceRecord('offline-anchor',value,assertCurrent);
}
/** Clears only this actor's anchor (another account's anchor is left to its own exchange). */
export async function clearOfflineAnchor(expected:{namespace:string;actorId:string},assertCurrent:()=>void){
 const current=await readOfflineAnchor(assertCurrent);
 if(current&&current.namespace===expected.namespace&&current.actorId===expected.actorId)deleteSealedDeviceRecord('offline-anchor');
}
/** Logout: synchronous file removal, no key or network, safe after session ownership has ended. */
export function endOfflineAnchor(){deleteSealedDeviceRecord('offline-anchor');}
/** The offline cold-start identity: only after a no-response failure, and only for this exact connection and employment. */
export async function anchoredIdentity(error:unknown,expected:{namespace:string;apiOrigin:string;employmentId:string},assertCurrent:()=>void){
 if(!offlineClockingBuild||!isNoConnectivity(error))return null;
 const anchor=await readOfflineAnchor(assertCurrent);
 return anchor&&anchor.namespace===expected.namespace&&anchor.apiOrigin===expected.apiOrigin&&anchor.employmentId===expected.employmentId?anchor:null;
}
