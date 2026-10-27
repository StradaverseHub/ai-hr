/** Bounds from UNVERIFIED signed client duration reports, never trusted time or attendance authority. */
import type {OfflineClockClaimData} from '../mobile-offline-clock';
import type {OfflineClockContextData} from '../mobile-offline-context';
export type OfflineClockReportedBounds={status:'reported_interval';minimum:number;maximum:number}|
 {status:'unavailable';reason:'continuity_unknown'|'future_interval'|'invalid_interval'};
export function offlineClockReportedBounds(context:Pick<OfflineClockContextData,'issuedAt'>,claim:Pick<OfflineClockClaimData,'time'>,receivedAt:number):OfflineClockReportedBounds{
 const elapsed=claim.time.elapsed;
 if(elapsed.status==='unknown')return {status:'unavailable',reason:'continuity_unknown'};
 if(!Number.isSafeInteger(receivedAt)||receivedAt<context.issuedAt)return {status:'unavailable',reason:'invalid_interval'};
 const million=BigInt(1000000),base=BigInt(context.issuedAt),lower=base+BigInt(elapsed.minimumNs)/million,
  upper=base+(BigInt(elapsed.maximumNs)+million-BigInt(1))/million,ceiling=BigInt(8640000000000000);
 if(lower>upper||lower>ceiling||upper>ceiling)return {status:'unavailable',reason:'invalid_interval'};
 // A submitted proof already exists at admission; intersect its reported interval with server receipt.
 if(lower>BigInt(receivedAt))return {status:'unavailable',reason:'future_interval'};
 return {status:'reported_interval',minimum:Number(lower),maximum:Number(upper>BigInt(receivedAt)?BigInt(receivedAt):upper)};
}
