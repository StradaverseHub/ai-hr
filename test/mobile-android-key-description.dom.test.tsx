/** Captured upstream and synthetic ASN.1 cases. Parsing is not certificate/vendor/hardware validation. */
import {readFileSync} from 'node:fs';
import {createHash,X509Certificate} from 'node:crypto';
import {Certificate} from 'pkijs';
import {fromBER,Sequence,Set as AsnSet,Integer,Enumerated,OctetString,Constructed,Boolean as AsnBoolean,Null} from 'asn1js';
import {describe,expect,it} from 'vitest';
import {decodeAndroidKeyDescription,AndroidKeyDescriptionError} from '../lib/mobile-api/android-key-description';
import provenance from './fixtures/mobile-integrity/android/provenance.json';
const base='test/fixtures/mobile-integrity/android/';
function extension(file:string){
  const certs=readFileSync(base+file,'utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)!;
  for(const pem of certs){
    const raw=new X509Certificate(pem).raw,parsed=fromBER(new Uint8Array(raw));
    const cert=new Certificate({schema:parsed.result}),extension=cert.extensions?.find(item=>item.extnID==='1.3.6.1.4.1.11129.2.1.17');
    if(extension)return Buffer.from(extension.extnValue.getValue());
  }
  throw new Error('Fixture extension missing');
}
const int=(value:number)=>new Integer({value}),enumeration=(value:number)=>new Enumerated({value});
const bytes=(value:Buffer)=>new OctetString({valueHex:new Uint8Array(value).buffer});
const tag=(id:number,value:any)=>new Constructed({idBlock:{tagClass:3,tagNumber:id},value:[value]});
const set=(values:number[])=>new AsnSet({value:values.map(int)});
const root=(locked=true,state=0)=>new Sequence({value:[bytes(Buffer.alloc(32,1)),new AsnBoolean({value:locked}),enumeration(state),bytes(Buffer.alloc(32,2))]});
function synthetic(options:{version?:number;software?:any[];hardware?:any[];keyMint?:number}={}){
  return Buffer.from(new Sequence({value:[int(options.version??400),enumeration(1),int(options.keyMint??400),enumeration(1),bytes(Buffer.alloc(32,7)),bytes(Buffer.alloc(0)),
    new Sequence({value:options.software??[]}),new Sequence({value:options.hardware??[tag(1,set([2])),tag(2,int(3)),tag(3,int(256)),tag(5,set([4])),tag(10,int(1)),tag(704,root())]})]}).toBER());
}
describe('bounded unverified Android KeyDescription',()=>{
  it('pins the upstream fixture revision, license and downloaded bytes',()=>{
    expect(provenance.revision).toBe('34652d3df68b8d6887a6670b00eb0856090dae6d');
    for(const record of provenance.files)expect(createHash('sha256').update(readFileSync(base+record.file)).digest('hex')).toBe(record.sha256);
  });
  it.each(['tee-v3','tee-rkp','strongbox-2026'])('decodes captured %s fields against independently published expectations',file=>{
    const expected=JSON.parse(readFileSync(base+file+'.json','utf8')),actual=decodeAndroidKeyDescription(extension(file+'.pem'));
    const level=(value:string)=>({TRUSTED_ENVIRONMENT:'tee',STRONG_BOX:'strongbox',SOFTWARE:'software'})[value as 'SOFTWARE'];
    expect(actual).toMatchObject({verification:'not_verified',attestationVersion:Number(expected.attestationVersion),keyMintVersion:Number(expected.keyMintVersion),
      attestationSecurityLevel:level(expected.attestationSecurityLevel),keyMintSecurityLevel:level(expected.keyMintSecurityLevel),uniqueIdPresent:false});
    expect(actual.challenge.toString('base64')).toBe(expected.attestationChallenge);
    expect(actual.softwareEnforced.applicationId).toEqual({packages:expected.softwareEnforced.attestationApplicationId.packages,certificateDigests:expected.softwareEnforced.attestationApplicationId.signatures});
    expect(actual.hardwareEnforced).toMatchObject({algorithm:Number(expected.hardwareEnforced.algorithms),keySize:Number(expected.hardwareEnforced.keySize),
      purposes:expected.hardwareEnforced.purposes.map(Number),digests:expected.hardwareEnforced.digests.map(Number),curve:Number(expected.hardwareEnforced.ecCurve),
      rootOfTrust:{deviceLocked:expected.hardwareEnforced.rootOfTrust.deviceLocked,state:expected.hardwareEnforced.rootOfTrust.verifiedBootState.toLowerCase(),
        bootKeyBytes:Buffer.from(expected.hardwareEnforced.rootOfTrust.verifiedBootKey,'base64').length,bootHashBytes:Buffer.from(expected.hardwareEnforced.rootOfTrust.verifiedBootHash,'base64').length}});
    const visible=JSON.stringify(actual);if(expected.hardwareEnforced.rootOfTrust.verifiedBootKey)expect(visible).not.toContain(expected.hardwareEnforced.rootOfTrust.verifiedBootKey);
    expect(visible).not.toContain(expected.hardwareEnforced.rootOfTrust.verifiedBootHash);
    expect(actual).not.toHaveProperty('accepted');expect(actual).not.toHaveProperty('trustTier');
  });
  it('preserves software and hardware facts without upgrading an unlocked or unverified boot state',()=>{
    const actual=decodeAndroidKeyDescription(synthetic({software:[tag(2,int(1))],hardware:[tag(2,int(3)),tag(704,root(false,2))]}));
    expect(actual.softwareEnforced.algorithm).toBe(1);expect(actual.hardwareEnforced.algorithm).toBe(3);
    expect(actual.hardwareEnforced.rootOfTrust).toMatchObject({deviceLocked:false,state:'unverified'});expect(actual.verification).toBe('not_verified');
  });
  it.each(['malformed-locked.pem','unordered-tags.pem'])('rejects upstream negative fixture %s',file=>{
    expect(()=>decodeAndroidKeyDescription(extension(file))).toThrow(AndroidKeyDescriptionError);
  });
  it('rejects duplicate, unordered and implicitly encoded authorizations',()=>{
    for(const hardware of [[tag(2,int(3)),tag(2,int(1))],[tag(10,int(1)),tag(2,int(3))],
      [new Constructed({idBlock:{tagClass:3,tagNumber:2},value:[int(3),int(1)]})]])
      expect(()=>decodeAndroidKeyDescription(synthetic({hardware}))).toThrow(AndroidKeyDescriptionError);
  });
  it('distinguishes unsupported future schema and refuses mismatched version pairs',()=>{
    expect(()=>decodeAndroidKeyDescription(synthetic({version:600,keyMint:600}))).toThrow(expect.objectContaining({reason:'unsupported_schema'}));
    expect(()=>decodeAndroidKeyDescription(synthetic({version:400,keyMint:300}))).toThrow(expect.objectContaining({reason:'malformed'}));
  });
  it('rejects every truncated prefix, trailing bytes, indefinite and nonminimal DER',()=>{
    const good=synthetic();for(let length=0;length<good.length;length++)expect(()=>decodeAndroidKeyDescription(good.subarray(0,length))).toThrow(AndroidKeyDescriptionError);
    for(const data of [Buffer.concat([good,Buffer.from([0])]),Buffer.from([0x30,0x80,0,0]),Buffer.from([0x30,0x81,0]),Buffer.alloc(16385)])
      expect(()=>decodeAndroidKeyDescription(data)).toThrow(AndroidKeyDescriptionError);
  });
  it('bounds constructed nesting and refuses noncanonical integers, booleans and sets',()=>{
    let deep:any=int(1);for(let i=0;i<10;i++)deep=new Sequence({value:[deep]});
    for(const hardware of [[tag(999,deep)],[tag(2,new Integer({valueHex:Uint8Array.from([0,3]).buffer}))],
      [tag(704,new Sequence({value:[bytes(Buffer.alloc(32)),new AsnBoolean({valueHex:Uint8Array.from([1]).buffer}),enumeration(0),bytes(Buffer.alloc(32))]}))],
      [tag(1,set([3,2]))],[tag(1,set([2,2]))]])expect(()=>decodeAndroidKeyDescription(synthetic({hardware}))).toThrow(AndroidKeyDescriptionError);
  });
  it('reports identifier field presence without returning identity values',()=>{
    const result=decodeAndroidKeyDescription(synthetic({hardware:[tag(600,new Null()),tag(713,bytes(Buffer.from('synthetic private serial')))]}));
    expect(result.hardwareEnforced.identifierFieldsPresent).toBe(true);expect(result.hardwareEnforced.allApplications).toBe(true);
    expect(JSON.stringify(result)).not.toContain('synthetic private serial');
  });
});
