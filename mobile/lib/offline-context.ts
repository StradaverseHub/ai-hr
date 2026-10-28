/** The phone's check of an offline context received over HTTPS from its own paired server (owner decision D16,
 * 29 October 2026: keyless). The server signs no context, so there is no signature to verify and no issuer registry to
 * cache: transport authenticity comes from TLS to the paired company origin, and the server accepts a claim only against
 * its own record of this exact context. This check keeps the strict shape and binding (scope incl. apiOrigin,
 * installation, employment, app installation and device key; request id/nonce; app target) and computes the digest the
 * claim must reference. No fetching, persistence, permit consumption, elapsed-time trust or attendance effect. */
import {CryptoDigestAlgorithm,digest} from 'expo-crypto';
import {OfflineClockContextBinding,type OfflineClockContextVerificationResult,bindOfflineClockContext} from '../../lib/mobile-offline-context';
export class OfflineContextVerificationUnavailable extends Error{constructor(){super('Offline context verification unavailable');this.name='OfflineContextVerificationUnavailable';}}
export type ExpectedOfflineContext=OfflineClockContextBinding;
export type NativeOfflineContextResult=OfflineClockContextVerificationResult;
// JSON.stringify escapes lone surrogates; this counts the actual UTF-8 bytes that are hashed.
function utf8(value:string):Uint8Array{
 const encoded=encodeURIComponent(value).replace(/%([0-9A-F]{2})/g,(_,hex:string)=>String.fromCharCode(parseInt(hex,16)));
 return Uint8Array.from(encoded,char=>char.charCodeAt(0));
}
/** The expected binding is supplied by the current trusted connection owner, never read from the context.
 * A valid result does not establish current permission, trusted elapsed time or permit consumption. */
export async function verifyNativeOfflineClockContext(raw:string,expected:ExpectedOfflineContext,assertCurrent:()=>void):Promise<NativeOfflineContextResult>{
 assertCurrent();
 let binding:ExpectedOfflineContext;
 try{binding=OfflineClockContextBinding.parse(expected);}catch{throw new OfflineContextVerificationUnavailable();}
 const checked=bindOfflineClockContext(raw,binding);
 if(checked.outcome!=='bound')return checked;
 assertCurrent();let output:ArrayBuffer;
 try{output=await digest(CryptoDigestAlgorithm.SHA256,utf8(checked.canonical));}
 catch{assertCurrent();throw new OfflineContextVerificationUnavailable();}
 assertCurrent();
 if(!(output instanceof ArrayBuffer)||output.byteLength!==32)throw new OfflineContextVerificationUnavailable();
 const hash=Array.from(new Uint8Array(output),byte=>byte.toString(16).padStart(2,'0')).join('');
 return {outcome:'context_valid',context:checked.context,digest:hash,authorization:'not_granted'};
}
