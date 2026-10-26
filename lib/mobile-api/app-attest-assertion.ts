/** Low-level App Attest assertion checks, never an enrollment or attendance verdict. */
import 'server-only';
import {createHash,KeyObject,timingSafeEqual,verify} from 'node:crypto';
import {decodeFirstSync} from 'cbor';

type Reason='malformed'|'invalid_configuration'|'invalid_key'|'wrong_app'|'replayed_counter'|'invalid_signature';
export class AppAttestAssertionError extends Error{
  constructor(readonly reason:Reason){super('App Attest assertion check failed');this.name='AppAttestAssertionError';}
}
function fail(reason:Reason):never{throw new AppAttestAssertionError(reason);}
// Preserve every semantic tag as Tagged rather than executing the decoder's tag conversions.
const tags=new Proxy(Object.create(null),{get:()=>null});
const hash=(data:Buffer)=>createHash('sha256').update(data).digest();

/** The key must come from a previously verified attestation; appId is deployment-owned.
 * clientData must be reconstructed from authenticated records and the actual command/attachment.
 * The caller must atomically compare/update this counter and consume the challenge with its result.
 * This function alone establishes none of those preconditions and does not verify a vendor chain.
 */
export function checkAppAttestAssertion(input:{assertion:Buffer;clientData:Buffer;publicKey:KeyObject;appId:string;previousCounter:number}):{nextCounter:number}{
  const {assertion,clientData,publicKey,appId,previousCounter}=input;
  if(typeof appId!=='string'||appId.length>300||appId.trim()!==appId||!/^[A-Za-z0-9]{10}\.[A-Za-z0-9][A-Za-z0-9.-]+$/.test(appId)||
    !Number.isInteger(previousCounter)||previousCounter<0||previousCounter>0xffffffff)fail('invalid_configuration');
  if(!(publicKey instanceof KeyObject)||publicKey.type!=='public'||publicKey.asymmetricKeyType!=='ec'||
    publicKey.asymmetricKeyDetails?.namedCurve!=='prime256v1')fail('invalid_key');
  if(!Buffer.isBuffer(assertion)||assertion.length<1||assertion.length>8192||
    !Buffer.isBuffer(clientData)||clientData.length<1||clientData.length>16384)fail('malformed');
  let decoded:unknown;
  try{decoded=decodeFirstSync(assertion,{required:true,preferMap:true,preventDuplicateKeys:true,max_depth:4,tags});}
  catch{fail('malformed');}
  if(!(decoded instanceof Map)||decoded.size!==2||!decoded.has('signature')||!decoded.has('authenticatorData'))fail('malformed');
  const signature:unknown=decoded.get('signature'),auth:unknown=decoded.get('authenticatorData');
  // The currently supported iOS assertion authenticator header is 37 bytes. Unknown extensions
  // require explicit protocol support, not best-effort acceptance of an unparsed suffix.
  if(!Buffer.isBuffer(auth)||auth.length!==37||!Buffer.isBuffer(signature)||signature.length<8||signature.length>72)fail('malformed');
  if(signature[0]!==0x30||signature[1]!==signature.length-2)fail('malformed');
  if(!timingSafeEqual(hash(Buffer.from(appId,'utf8')),auth.subarray(0,32)))fail('wrong_app');
  const nextCounter=auth.readUInt32BE(33);
  if(nextCounter<=previousCounter)fail('replayed_counter');
  // Apple's nonce is hashed once here; ECDSA-with-SHA256 verifies that nonce as its message.
  // Do not try alternate hash constructions when verification fails.
  const nonce=hash(Buffer.concat([auth,hash(clientData)]));
  let valid=false;
  try{valid=verify('sha256',nonce,{key:publicKey,dsaEncoding:'der'},signature);}catch{}
  if(!valid)fail('invalid_signature');
  return {nextCounter};
}
