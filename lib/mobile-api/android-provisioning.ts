/** Provisioning CBOR decoder only; caller must verify the containing signed issuer first. */
import 'server-only';
import cbor from 'cbor';
export function decodeAndroidProvisioningInfo(raw:Buffer){
 if(!Buffer.isBuffer(raw)||raw.length<1||raw.length>2048)throw new Error('Invalid Android provisioning evidence');
 const tags=new Proxy(Object.create(null),{get:()=>null});
 const info:unknown=cbor.decodeFirstSync(raw,{required:true,preferMap:true,preventDuplicateKeys:true,max_depth:3,tags});
 if(!(info instanceof Map)||info.size>16||!Number.isSafeInteger(info.get(1))||info.get(1)<0||
   info.has(4)&&!['TEE','STRONG_BOX'].includes(info.get(4))||info.has(6)&&typeof info.get(6)!=='boolean'||
   [...info.keys()].some(key=>!Number.isSafeInteger(key)))throw new Error('Invalid Android provisioning evidence');
 // Older signed captures predate entity/lost-device metadata. Missing is unavailable, never false.
 return {entity:info.has(4)?(info.get(4)==='TEE'?'tee' as const:'strongbox' as const):null,
  lostDevice:info.has(6)?info.get(6) as boolean:null};
}
