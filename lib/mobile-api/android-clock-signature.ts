/** Cryptographic command binding only. Caller owns stored-key scope, revocation and one-use receipt. */
import 'server-only';
import {createHash,KeyObject,verify} from 'node:crypto';
import {OnlineClockIntegrityData,onlineClockClientData} from '../mobile-clock-integrity';
export class AndroidClockSignatureError extends Error{
 constructor(readonly reason:'configuration'|'invalid_key'|'malformed'|'wrong_app'|'invalid_signature'){
  super('Android command signature check failed');this.name='AndroidClockSignatureError';
 }
}
function fail(reason:AndroidClockSignatureError['reason']):never{throw new AndroidClockSignatureError(reason);}
const order=BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
function canonicalSignature(signature:Buffer){
 if(signature.length<8||signature.length>72||signature[0]!==0x30||signature[1]!==signature.length-2)fail('malformed');
 let at=2;
 for(let i=0;i<2;i++){
  if(signature[at++]!==2||at>=signature.length)fail('malformed');
  const length=signature[at++];if(length<1||length>33||at+length>signature.length)fail('malformed');
  const bytes=signature.subarray(at,at+length);at+=length;
  if(bytes[0]&128||length>1&&bytes[0]===0&&!(bytes[1]&128))fail('malformed');
  let scalar=BigInt(0);for(const byte of bytes)scalar=scalar*BigInt(256)+BigInt(byte);
  if(scalar<1||scalar>=order)fail('malformed');
 }
 if(at!==signature.length)fail('malformed');
}
/** The public key MUST be loaded from already verified actor/installation-owned registration.
 * Reconstruct clientData from stored challenge, actual command and actual attachment bytes. This
 * function does not accept a caller digest, retrieve a key, authorize a subject, enforce time or
 * consume a challenge. Android ECDSA has no App Attest counter: enforce replay atomically elsewhere.
 */
export function checkAndroidClockSignature(input:{publicKey:KeyObject;signature:Buffer;clientData:unknown;expectedAppId:string;allowedBuildVersions:readonly string[]}){
 const {publicKey,signature,expectedAppId,allowedBuildVersions}=input;
 if(typeof expectedAppId!=='string'||expectedAppId.length<3||expectedAppId.length>200||expectedAppId.trim()!==expectedAppId||
   !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(expectedAppId)||
   !Array.isArray(allowedBuildVersions)||allowedBuildVersions.length<1||allowedBuildVersions.length>20||
   allowedBuildVersions.some(value=>typeof value!=='string'||value.length<1||value.length>20||value.trim()!==value||!/^(0|[1-9][0-9]*)$/.test(value)||BigInt(value)>BigInt('18446744073709551615')))fail('configuration');
 if(!(publicKey instanceof KeyObject)||publicKey.type!=='public'||publicKey.asymmetricKeyType!=='ec'||publicKey.asymmetricKeyDetails?.namedCurve!=='prime256v1')fail('invalid_key');
 if(!Buffer.isBuffer(signature))fail('malformed');canonicalSignature(signature);
 const parsed=OnlineClockIntegrityData.safeParse(input.clientData);if(!parsed.success)fail('malformed');
 if(parsed.data.evidence.platform!=='android'||parsed.data.evidence.appId!==expectedAppId||!allowedBuildVersions.includes(parsed.data.evidence.buildVersion))fail('wrong_app');
 const canonical=Buffer.from(onlineClockClientData(parsed.data),'utf8');if(canonical.length<1||canonical.length>16384)fail('malformed');
 let valid=false;try{valid=verify('sha256',canonical,{key:publicKey,dsaEncoding:'der'},signature);}catch{}
 if(!valid)fail('invalid_signature');
 // No signature hash is an idempotency key: ECDSA may produce multiple valid signatures per command.
 return {verification:'command_signature' as const,clientDataHash:createHash('sha256').update(canonical).digest('hex')};
}
