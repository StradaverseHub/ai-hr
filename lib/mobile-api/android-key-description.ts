/** Bounded Android KeyDescription decoder only. Certificate path/revocation and expected-value checks
 * MUST precede assurance. These bytes may be attacker-controlled; no field is verified by parsing. */
import 'server-only';
export class AndroidKeyDescriptionError extends Error{
  constructor(readonly reason:'malformed'|'unsupported_schema'){super('Android key description unavailable');this.name='AndroidKeyDescriptionError';}
}
const fail=():never=>{throw new AndroidKeyDescriptionError('malformed');};
type Node={cls:number;tag:number;constructed:boolean;bytes:Buffer;encoded:Buffer;children:Node[]};
function decode(input:Buffer):Node{
  if(!Buffer.isBuffer(input)||input.length<2||input.length>16384)fail();
  const source=Buffer.from(input);let count=0;
  function read(start:number,limit:number,depth:number):{node:Node;end:number}{
    if(depth>8||++count>512||start>=limit)fail();
    let at=start;const identifier=source[at++],cls=identifier>>6,constructed=!!(identifier&32);let tag=identifier&31;
    if(tag===31){
      tag=0;let parts=0;
      for(;;){if(at>=limit||++parts>3)fail();const b=source[at++];if(parts===1&&(b&127)===0)fail();tag=tag*128+(b&127);if(!(b&128))break;}
      if(tag<31||tag>65535)fail();
    }
    if(at>=limit)fail();let length=source[at++];
    if(length&128){
      const size=length&127;if(size===0||size>2||at+size>limit||source[at]===0)fail();length=0;
      for(let i=0;i<size;i++)length=length*256+source[at++];
      if(length<128)fail();
    }
    const end=at+length;if(end>limit)fail();
    if(cls!==0&&cls!==2)fail();
    if(cls===0&&(![1,2,4,5,10,16,17].includes(tag)||constructed!==[16,17].includes(tag)))fail();
    if(cls===2&&!constructed)fail();
    const children:Node[]=[];
    if(constructed){let next=at;while(next<end){const value=read(next,end,depth+1);children.push(value.node);next=value.end;}}
    const node={cls,tag,constructed,bytes:source.subarray(at,end),encoded:source.subarray(start,end),children};
    if(cls===0){
      if(tag===1&&(length!==1||![0,255].includes(node.bytes[0])))fail();
      if([2,10].includes(tag))integer(node,tag);
      if(tag===5&&length!==0)fail();
      if(tag===17)for(let i=1;i<children.length;i++)if(Buffer.compare(children[i-1].encoded,children[i].encoded)>=0)fail();
    }
    return {node,end};
  }
  const result=read(0,source.length,0);if(result.end!==source.length)fail();return result.node;
}
function is(node:Node,tag:number){return node.cls===0&&node.tag===tag;}
function sequence(node:Node,tag=16){if(!is(node,tag))fail();return node.children;}
function integer(node:Node,tag=2):bigint{
  if(!is(node,tag)||node.bytes.length<1||node.bytes.length>9||node.bytes[0]&128||
    node.bytes.length>1&&node.bytes[0]===0&&node.bytes[1]<128)fail();
  let value=BigInt(0);for(const b of node.bytes)value=value*BigInt(256)+BigInt(b);
  if(value>BigInt('18446744073709551615'))fail();return value;
}
function number(node:Node,tag=2){const value=integer(node,tag);if(value>BigInt(Number.MAX_SAFE_INTEGER))fail();return Number(value);}
function octets(node:Node,minimum=0,maximum=1024){if(!is(node,4)||node.bytes.length<minimum||node.bytes.length>maximum)fail();return node.bytes;}
function numbers(node:Node){const entries=sequence(node,17);if(entries.length>16)fail();return entries.map(n=>number(n));}
function level(node:Node,version:number){const value=number(node,10);if(value>2||version<3&&value===2)fail();return (['software','tee','strongbox'] as const)[value];}
function boot(node:Node,version:number){
  const values=sequence(node);if(values.length!==(version>=3?4:3))fail();
  octets(values[0],0,128);if(!is(values[1],1))fail();const state=number(values[2],10);if(state>3)fail();
  if(version>=3)octets(values[3],0,128);
  // Do not return boot keys/hashes, which are unnecessary persistent identifiers for this application.
  return {bootKeyBytes:values[0].bytes.length,bootHashBytes:version>=3?values[3].bytes.length:null,deviceLocked:values[1].bytes[0]===255,state:(['verified','self_signed','unverified','failed'] as const)[state]};
}
function application(node:Node){
  const data=sequence(decode(octets(node,1,8192)));if(data.length!==2)fail();
  const packages=sequence(data[0],17),digests=sequence(data[1],17);
  if(packages.length<1||packages.length>8||digests.length<1||digests.length>8)fail();
  const names=new Set<string>();
  return {packages:packages.map(value=>{
    const pair=sequence(value);if(pair.length!==2)fail();
    let name:string;try{name=new TextDecoder('utf-8',{fatal:true}).decode(octets(pair[0],1,255));}catch{fail();}
    if(name!.trim()!==name!||!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/.test(name!)||names.has(name!))fail();
    names.add(name!);return {name:name!,version:integer(pair[1]).toString()};
  }),certificateDigests:digests.map(value=>octets(value,32,32).toString('base64'))};
}
const interpreted=new Set([1,2,3,5,10,503,600,702,704,705,706,709,718,719]);
function authorizations(node:Node,version:number){
  const fields=new Map<number,Node>();let previous=-1;
  for(const field of sequence(node)){
    if(field.cls!==2||!field.constructed||field.children.length!==1||field.tag<=previous)fail();
    previous=field.tag;fields.set(field.tag,field.children[0]);
  }
  if(version===1&&fields.has(709)||version<3&&(fields.has(718)||fields.has(719)))fail();
  const get=(tag:number)=>fields.get(tag),numeric=(tag:number)=>get(tag)?number(get(tag)!):undefined;
  for(const tag of [503,600])if(get(tag)&&!is(get(tag)!,5))fail();
  return {purposes:get(1)?numbers(get(1)!):undefined,algorithm:numeric(2),keySize:numeric(3),digests:get(5)?numbers(get(5)!):undefined,
    curve:numeric(10),noAuthRequired:fields.has(503),allApplications:fields.has(600),origin:numeric(702),
    rootOfTrust:get(704)?boot(get(704)!,version):undefined,osVersion:numeric(705),osPatchLevel:numeric(706),
    applicationId:get(709)?application(get(709)!):undefined,vendorPatchLevel:numeric(718),bootPatchLevel:numeric(719),
    identifierFieldsPresent:[710,711,712,713,714,715,716,717,720,723].some(tag=>fields.has(tag)),
    uninterpretedTags:[...fields.keys()].filter(tag=>!interpreted.has(tag))};
}
const versions=new Map([[1,2],[2,3],[3,4],[4,41],[100,100],[200,200],[300,300],[400,400],[500,500]]);
/** Input is the DER extnValue contents for OID 1.3.6.1.4.1.11129.2.1.17. Selecting that extension
 * from a chain is deliberately NOT done here. Never trust a caller-selected leaf extension. */
export function decodeAndroidKeyDescription(input:Buffer){
  const fields=sequence(decode(input));if(fields.length!==8)fail();
  const attestationVersion=number(fields[0]),keyMintVersion=number(fields[2]);
  if(!versions.has(attestationVersion))throw new AndroidKeyDescriptionError('unsupported_schema');
  if(versions.get(attestationVersion)!==keyMintVersion)fail();
  const attestationSecurityLevel=level(fields[1],attestationVersion),keyMintSecurityLevel=level(fields[3],attestationVersion);
  const challenge=Buffer.from(octets(fields[4],1,128)),uniqueIdPresent=octets(fields[5],0,128).length>0;
  return {verification:'not_verified' as const,attestationVersion,keyMintVersion,attestationSecurityLevel,keyMintSecurityLevel,challenge,uniqueIdPresent,
    softwareEnforced:authorizations(fields[6],attestationVersion),hardwareEnforced:authorizations(fields[7],attestationVersion)};
}
