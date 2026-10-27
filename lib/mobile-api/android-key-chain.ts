/** Signed Android key evidence. No actor custody, attendance acceptance or current device-state claim. */
import 'server-only';
import {createHash,timingSafeEqual,webcrypto,X509Certificate} from 'node:crypto';
import {fromBER} from 'asn1js';
import {Certificate,CertificateChainValidationEngine,CryptoEngine} from 'pkijs';
import roots from './android-attestation-roots.json';
import {decodeAndroidKeyDescription} from './android-key-description';
import {createAndroidRevocationChecker,type AndroidRevocationResult} from './android-revocation';
const ATTESTATION='1.3.6.1.4.1.11129.2.1.17',PROVISIONING='1.3.6.1.4.1.11129.2.1.30';
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const engine=new CryptoEngine({name:'node-webcrypto',crypto:webcrypto as unknown as Crypto});
for(const root of roots.roots){
 const cert=new X509Certificate(Buffer.from(root.der,'base64'));
 if(digest(cert.raw)!==root.sha256||digest(cert.publicKey.export({type:'spki',format:'der'}))!==root.spkiSha256||!cert.ca||!cert.verify(cert.publicKey))throw new Error('Android root pin differs');
}
export class AndroidKeyChainError extends Error{
 constructor(readonly reason:'configuration'|'malformed'|'certificate_path'|'unsupported_path'|'expired'|'extension'|'key_mismatch'|'challenge_mismatch'|'revoked'|'suspended'|'revocation_unavailable'){
  super('Android certificate evidence unavailable');this.name='AndroidKeyChainError';
 }
}
function fail(reason:AndroidKeyChainError['reason']):never{throw new AndroidKeyChainError(reason);}
function parsed(bytes:Buffer){
 const value=fromBER(new Uint8Array(bytes),{maxDepth:24,maxNodes:2048,maxContentLength:16384,parseEmbedded:false});
 if(value.offset!==bytes.length)fail('malformed');return new Certificate({schema:value.result});
}
function extensions(cert:Certificate,oid:string){return cert.extensions?.filter(value=>value.extnID===oid)??[];}
/** Expected challenge/SPKI and clock MUST be reconstructed from the server-owned enrollment intent.
 * The revocation port is a trusted server test/assembly seam, never a request field. */
export function createAndroidKeyChainVerifier(ports:{revocation?:(serials:readonly string[],signal?:AbortSignal)=>Promise<AndroidRevocationResult>;now?:()=>number}={}){
 const now=ports.now??Date.now,revocation=ports.revocation??createAndroidRevocationChecker({now});
 return async(input:{certificateChain:Buffer[];publicKeySpki:Buffer;challenge:Buffer},signal?:AbortSignal)=>{
  const started=now();if(!Number.isSafeInteger(started)||started<1)fail('configuration');
  if(!Array.isArray(input.certificateChain)||input.certificateChain.length<3||input.certificateChain.length>8||
   input.certificateChain.some(value=>!Buffer.isBuffer(value)||value.length<1||value.length>16384)||
   !Buffer.isBuffer(input.publicKeySpki)||input.publicKeySpki.length<64||input.publicKeySpki.length>2048||
   !Buffer.isBuffer(input.challenge)||input.challenge.length<1||input.challenge.length>128)fail('malformed');
  const bytes=input.certificateChain.map(value=>Buffer.from(value)),spki=Buffer.from(input.publicKeySpki),challenge=Buffer.from(input.challenge);
  if(new Set(bytes.map(digest)).size!==bytes.length)fail('certificate_path');
  try{
   const chain=bytes.map(value=>new X509Certificate(value)),certs=bytes.map(parsed),root=chain[chain.length-1],leaf=chain[0];
   const anchor=roots.roots.find(value=>value.spkiSha256===digest(root.publicKey.export({type:'spki',format:'der'})));
   if(!anchor||!root.ca||!root.checkIssued(root)||!root.verify(root.publicKey)||leaf.ca||!chain.slice(1).every(cert=>cert.ca))fail('certificate_path');
   for(let i=0;i<chain.length-1;i++)if(!chain[i].checkIssued(chain[i+1])||!chain[i].verify(chain[i+1].publicKey))fail('certificate_path');
   // Require exactly one attestation extension, at the target. Appended child chains cannot choose
   // their own fake extension, and duplicate/critical unknown extensions never pass silently.
   const allowedCritical=new Set(['2.5.29.19','2.5.29.15',ATTESTATION,PROVISIONING]);
   for(let i=0;i<certs.length;i++){
    const all=certs[i].extensions??[];
    if(new Set(all.map(value=>value.extnID)).size!==all.length||all.some(value=>value.critical&&!allowedCritical.has(value.extnID)))fail('extension');
    if(extensions(certs[i],ATTESTATION).length!==(i===0?1:0))fail('extension');
   }
   const provisioning=certs.flatMap((cert,i)=>extensions(cert,PROVISIONING).map(()=>i));
   if(provisioning.length>1||provisioning.length===1&&provisioning[0]!==1)fail('extension');
   // Known factory profile is 4 certificates with the factory intermediate serial-number DN.
   // RKP is 5, with the Google Droid CA2 intermediate. Unknown profile is not a downgrade.
   const intermediate=chain[chain.length-2],factory=anchor.factory&&chain.length===4&&/^serialNumber=[a-fA-F0-9]+(?:\n|$)/.test(intermediate.subject);
   const rkp=chain.length===5&&intermediate.subject.split('\n').includes('CN=Droid CA2')&&intermediate.subject.split('\n').includes('O=Google LLC');
   if(!factory&&!rkp)fail('unsupported_path');
   if(factory&&provisioning.length)fail('unsupported_path');
   const expectedSpki=leaf.publicKey.export({type:'spki',format:'der'});
   if(leaf.publicKey.asymmetricKeyType!=='ec'||leaf.publicKey.asymmetricKeyDetails?.namedCurve!=='prime256v1'||spki.length!==expectedSpki.length||!timingSafeEqual(spki,expectedSpki))fail('key_mismatch');
   // Target validity is device-chosen. RKP issuer validity is mandatory; factory issuer expiration
   // is exempt, but future issuers still refuse. Root is an externally pinned trust anchor.
   const issuers=chain.slice(1,-1),dates=issuers.map(cert=>({from:Date.parse(cert.validFrom),to:Date.parse(cert.validTo)}));
   if(dates.some(value=>!Number.isFinite(value.from)||!Number.isFinite(value.to)||value.from>started||value.to<value.from))fail('expired');
   if(rkp&&dates.some(value=>value.to<started))fail('expired');
   // PKI structural verification needs a common date. Factory expiration exceptions use the last
   // mutually valid instant. Never widen an RKP period or bypass certificate signature validation.
   const allDates=chain.map(cert=>({from:Date.parse(cert.validFrom),to:Date.parse(cert.validTo)}));
   const earliest=Math.max(...allDates.map(value=>value.from)),latest=Math.min(...allDates.map(value=>value.to));
   if(!Number.isFinite(earliest)||!Number.isFinite(latest)||earliest>latest)fail('unsupported_path');
   const checkDate=new Date(Math.max(earliest,Math.min(started,latest)));
   const path=await new CertificateChainValidationEngine({certs:[...certs.slice(1,-1),certs[0]],trustedCerts:[certs[certs.length-1]],checkDate}).verify({},engine);
   if(!path.result)fail('certificate_path');
   const description=decodeAndroidKeyDescription(Buffer.from(extensions(certs[0],ATTESTATION)[0].extnValue.getValue()));
   if(description.challenge.length!==challenge.length||!timingSafeEqual(description.challenge,challenge))fail('challenge_mismatch');
   const serials=chain.map(cert=>cert.serialNumber.toLowerCase().replace(/^0+/,''));
   const status=await revocation(serials,signal);
   if(status.status==='refused')fail(status.reason);
   if(status.status!=='checked'||status.certificateCount!==chain.length)fail('revocation_unavailable');
   const checkedAt=now();
   if(signal?.aborted||!Number.isSafeInteger(checkedAt)||checkedAt<started||status.checkedAt<started||status.checkedAt>checkedAt)fail('revocation_unavailable');
   if(rkp&&dates.some(value=>value.to<checkedAt))fail('expired');
   return {verification:'google_root_path_and_status' as const,publicKey:leaf.publicKey,description,
    provisioning:factory?'factory' as const:'remote' as const,factoryExpiryException:factory&&dates.some(value=>value.to<checkedAt),checkedAt};
  }catch(error){if(error instanceof AndroidKeyChainError)throw error;fail('malformed');}
 };
}
