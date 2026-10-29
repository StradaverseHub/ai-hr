/** Client half of the Android sync-time Play binding. The server owner is offlineSyncRequestHash in
 * lib/mobile-api/offline-sync-integrity.ts: base64url(sha256(UTF-8 JSON ['aihr.mobile.integrity',1,
 * 'attendance.clock.offline.sync',claimDigest,signatureSha256,syncBuildVersion])), where signatureSha256 is the hex sha256 of
 * the base64-decoded ORIGINAL claim signature and syncBuildVersion the RUNNING build's versionCode. Pure: hashing is a port
 * (Expo on device, node:crypto in the pinning test). It describes the upload only, never the capture. */
const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** Strict canonical standard base64 (the claim signature is already validated canonical by OfflineClockAndroidSignature). */
export function base64Bytes(value:string):Uint8Array{
 if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))throw new Error('Invalid base64');
 const clean=value.replace(/=+$/,''),out=new Uint8Array(Math.floor(clean.length*3/4));let bits=0,buffer=0,at=0;
 for(const char of clean){buffer=((buffer<<6)|alphabet.indexOf(char))&0xffffff;bits+=6;if(bits>=8){bits-=8;out[at++]=(buffer>>bits)&255;}}
 return out;
}
export function base64url(bytes:Uint8Array):string{
 let result='';
 for(let i=0;i<bytes.length;i+=3){const a=bytes[i],b=bytes[i+1],c=bytes[i+2],value=(a<<16)|((b??0)<<8)|(c??0);
  result+=alphabet[(value>>>18)&63]+alphabet[(value>>>12)&63]+(b===undefined?'':alphabet[(value>>>6)&63])+(c===undefined?'':alphabet[value&63]);}
 return result.replace(/\+/g,'-').replace(/\//g,'_');
}
const hex=(bytes:Uint8Array)=>Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');
export async function offlineSyncRequestHash(input:{claimDigest:string;signature:string;syncBuildVersion:string},sha256:(bytes:Uint8Array)=>Promise<Uint8Array>):Promise<string>{
 const signatureSha256=hex(await sha256(base64Bytes(input.signature)));
 const canonical=JSON.stringify(['aihr.mobile.integrity',1,'attendance.clock.offline.sync',input.claimDigest,signatureSha256,input.syncBuildVersion]);
 const digest=await sha256(new TextEncoder().encode(canonical));
 if(digest.byteLength!==32)throw new Error('Invalid digest');
 return base64url(digest);
}
