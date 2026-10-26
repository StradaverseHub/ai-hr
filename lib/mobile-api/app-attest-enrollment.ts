/** Vendor proof only. Enrollment ownership, one-use challenges and revocation remain transaction work. */
import 'server-only';
import {createHash,timingSafeEqual,webcrypto,X509Certificate,type KeyObject} from 'node:crypto';
import {Constructed,OctetString,Sequence,fromBER} from 'asn1js';
import {Certificate,CertificateChainValidationEngine,CryptoEngine} from 'pkijs';
import {decodeFirstSync} from 'cbor';
import pinnedRoot from './apple-app-attest-root.json';

type Reason='invalid_configuration'|'malformed'|'certificate_path'|'nonce_mismatch'|'key_mismatch'|'wrong_app'|'wrong_environment'|'metadata_mismatch';
export class AppAttestEnrollmentError extends Error{
  constructor(readonly reason:Reason){super('App Attest enrollment proof check failed');this.name='AppAttestEnrollmentError';}
}
function fail(reason:Reason):never{throw new AppAttestEnrollmentError(reason);}
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest();
const tags=new Proxy(Object.create(null),{get:()=>null});
const decode=(bytes:Buffer,extendedResults=false)=>decodeFirstSync(bytes,{required:true,preferMap:true,preventDuplicateKeys:true,max_depth:6,tags,extendedResults});
const rootBytes=Buffer.from(pinnedRoot.der,'base64');
if(hash(rootBytes).toString('hex')!==pinnedRoot.sha256)throw new Error('App Attest root pin differs');
const root=new X509Certificate(rootBytes);
const engine=new CryptoEngine({name:'node-webcrypto',crypto:webcrypto as unknown as Crypto});

function certificate(bytes:Buffer):Certificate{
  const decoded=fromBER(new Uint8Array(bytes),{maxDepth:20,maxNodes:2048,maxContentLength:16384,parseEmbedded:false});
  if(decoded.offset!==bytes.length)fail('malformed');
  return new Certificate({schema:decoded.result});
}
function nonceExtension(cert:Certificate):Buffer{
  const matches=cert.extensions?.filter(extension=>extension.extnID==='1.2.840.113635.100.8.2');
  if(matches?.length!==1)fail('nonce_mismatch');
  const bytes=matches[0].extnValue.getValue();
  const decoded=fromBER(bytes,{maxDepth:4,maxNodes:8,maxContentLength:128,parseEmbedded:false});
  if(decoded.offset!==bytes.byteLength||!(decoded.result instanceof Sequence))fail('nonce_mismatch');
  const children=decoded.result.valueBlock.value;
  if(children.length!==1||!(children[0] instanceof Constructed)||children[0].idBlock.tagClass!==3||children[0].idBlock.tagNumber!==1)fail('nonce_mismatch');
  const inner=children[0].valueBlock.value;
  if(inner.length!==1||!(inner[0] instanceof OctetString)||inner[0].idBlock.isConstructed)fail('nonce_mismatch');
  const nonce=Buffer.from(inner[0].getValue());if(nonce.length!==32)fail('nonce_mismatch');return nonce;
}
export type AppAttestEnrollmentProof={publicKey:KeyObject;keyId:string;environment:'production'|'development';
  validationCategory:number;bundleVersion:string;receipt:Buffer;receiptVerification:'not_checked';revocation:'not_checked'};

/** All expected values and now are server-owned, never taken from submitted claims or HTTP headers.
 * The caller must bind clientDataHash to its stored scoped challenge and persist the key uniquely.
 * No online revocation/fraud-receipt service is contacted here. No attendance is accepted here.
 */
export async function checkAppAttestEnrollment(input:{attestation:Buffer;clientDataHash:Buffer;keyId:string;appId:string;
  environment:'production'|'development';expectedValidationCategory:number;expectedBundleVersion:string;now?:Date}):Promise<AppAttestEnrollmentProof>{
  const {attestation,clientDataHash,keyId,appId,environment,expectedValidationCategory,expectedBundleVersion}=input;
  const now=input.now??new Date();
  if(typeof appId!=='string'||appId.length>300||appId.trim()!==appId||!/^[A-Za-z0-9]{10}\.[A-Za-z0-9][A-Za-z0-9.-]+$/.test(appId)||
    !['production','development'].includes(environment)||![1,2,3,4,5,6,10].includes(expectedValidationCategory)||
    typeof expectedBundleVersion!=='string'||expectedBundleVersion.length<1||expectedBundleVersion.length>64||
    !(now instanceof Date)||!Number.isFinite(now.getTime()))fail('invalid_configuration');
  if(!Buffer.isBuffer(attestation)||attestation.length<1||attestation.length>65536||!Buffer.isBuffer(clientDataHash)||clientDataHash.length!==32||
    typeof keyId!=='string'||keyId.length!==44||Buffer.from(keyId,'base64').length!==32||Buffer.from(keyId,'base64').toString('base64')!==keyId)fail('malformed');
  try{
    const data:unknown=decode(attestation);
    if(!(data instanceof Map)||data.size!==3||data.get('fmt')!=='apple-appattest')fail('malformed');
    const statement:unknown=data.get('attStmt'),auth:unknown=data.get('authData');
    if(!(statement instanceof Map)||statement.size!==2||!statement.has('x5c')||!statement.has('receipt')||!Buffer.isBuffer(auth)||auth.length<164||auth.length>4096)fail('malformed');
    const chain:unknown=statement.get('x5c'),receipt:unknown=statement.get('receipt');
    if(!Array.isArray(chain)||chain.length<2||chain.length>4||!chain.every(c=>Buffer.isBuffer(c)&&c.length>0&&c.length<=16384)||
      !Buffer.isBuffer(receipt)||receipt.length<1||receipt.length>32768)fail('malformed');
    const certs=chain.map(c=>new X509Certificate(c)),leaf=certs[0];
    if(leaf.ca||!certs.slice(1).every(c=>c.ca)||leaf.publicKey.asymmetricKeyType!=='ec'||leaf.publicKey.asymmetricKeyDetails?.namedCurve!=='prime256v1')fail('certificate_path');
    for(let i=0;i<certs.length;i++){
      const issuer=certs[i+1]??root;
      if(!certs[i].checkIssued(issuer)||!certs[i].verify(issuer.publicKey))fail('certificate_path');
    }
    const parsed=chain.map(c=>certificate(c)),trusted=certificate(rootBytes);
    const path=await new CertificateChainValidationEngine({certs:[...parsed.slice(1),parsed[0]],trustedCerts:[trusted],checkDate:now}).verify({},engine);
    if(!path.result)fail('certificate_path');
    const expectedNonce=hash(Buffer.concat([auth,clientDataHash]));
    if(!timingSafeEqual(nonceExtension(parsed[0]),expectedNonce))fail('nonce_mismatch');
    const jwk=leaf.publicKey.export({format:'jwk'});
    if(!jwk.x||!jwk.y)fail('key_mismatch');
    const x=Buffer.from(jwk.x,'base64url'),y=Buffer.from(jwk.y,'base64url'),keyHash=hash(Buffer.concat([Buffer.from([4]),x,y]));
    if(x.length!==32||y.length!==32||!timingSafeEqual(keyHash,Buffer.from(keyId,'base64')))fail('key_mismatch');
    if(!timingSafeEqual(hash(Buffer.from(appId,'utf8')),auth.subarray(0,32)))fail('wrong_app');
    if(auth.readUInt32BE(33)!==0)fail('malformed');
    const aaguid=environment==='production'?Buffer.concat([Buffer.from('appattest'),Buffer.alloc(7)]):Buffer.from('appattestdevelop');
    if(!timingSafeEqual(auth.subarray(37,53),aaguid))fail('wrong_environment');
    if(auth.readUInt16BE(53)!==32||!timingSafeEqual(auth.subarray(55,87),keyHash))fail('key_mismatch');
    const cose=decode(auth.subarray(87),true),key:unknown=cose.value;
    if(!(key instanceof Map)||key.size!==5||key.get(1)!==2||key.get(3)!==-7||key.get(-1)!==1||
      !Buffer.isBuffer(key.get(-2))||!Buffer.isBuffer(key.get(-3))||!key.get(-2).equals(x)||!key.get(-3).equals(y))fail('key_mismatch');
    if(!Buffer.isBuffer(cose.unused)||cose.unused.length<1)fail('metadata_mismatch');
    const extensions:unknown=decode(cose.unused);
    if(!(extensions instanceof Map)||extensions.size!==2)fail('metadata_mismatch');
    const category:unknown=extensions.get('apple_validation_category_01'),version:unknown=extensions.get('apple_bundle_version_01');
    if(!Buffer.isBuffer(category)||category.length!==4||category.readUInt32LE()!==expectedValidationCategory||version!==expectedBundleVersion)fail('metadata_mismatch');
    return {publicKey:leaf.publicKey,keyId,environment,validationCategory:expectedValidationCategory,bundleVersion:expectedBundleVersion,receipt:Buffer.from(receipt),receiptVerification:'not_checked',revocation:'not_checked'};
  }catch(error){if(error instanceof AppAttestEnrollmentError)throw error;fail('malformed');}
}
