/** Pure inventory representation only. No profile activation, SQL or permission. */
import {createHash} from 'node:crypto';
import {z} from 'zod';
const object=z.record(z.string(),z.unknown()),oid=z.number().int().safe().nonnegative().max(4294967295),positiveOid=oid.refine(value=>value>0);
const named=z.object({oid:positiveOid,name:z.string().min(1)}).strict();
const type=z.object({oid:positiveOid,schema:z.string().min(1),namespaceOid:positiveOid,name:z.string().min(1),identity:z.string().min(1),formatted:z.string().min(1),raw:object}).strict();
const acl=z.object({grantorOid:positiveOid,grantor:z.string().min(1),granteeOid:oid,grantee:z.string().min(1),privilege:z.string().min(1),grantable:z.boolean()}).strict();
const functionSchema=z.object({raw:object,signature:z.string().min(1),namespace:named.extend({raw:object}),owner:named,language:named.extend({raw:object}),returnType:type,inputTypes:z.array(type).max(1024),allTypes:z.array(type).max(2048).nullable(),transformTypes:z.array(type).max(1024).nullable(),variadicType:type.nullable(),support:z.object({oid:positiveOid,identity:z.string().min(1),raw:object}).strict().nullable(),supportOid:oid,supportText:z.string(),acl:z.array(acl).max(10000),nativeArguments:z.string(),nativeIdentityArguments:z.string(),nativeResult:z.string().nullable(),nativeDefaults:z.string().nullable(),nativeDefinition:z.string().nullable(),sourceBytes:z.number().int().safe().nonnegative(),sourceSha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const catalogueSchema=z.object({columns:z.array(z.string().min(1)).max(256),functionCount:z.number().int().safe().nonnegative(),functions:z.array(functionSchema).max(100000),dependencies:z.array(object).max(250000),sharedDependencies:z.array(object).max(250000)}).strict();
const scalarFields=['proname','procost','prorows','prokind','prosecdef','proleakproof','proisstrict','proretset','provolatile','proparallel','pronargs','pronargdefaults','proargmodes','proargnames','prosrc','probin','prosqlbody','proconfig','proargdefaults'];
const referenceFields=['oid','pronamespace','proowner','prolang','prorettype','proargtypes','proallargtypes','protrftypes','provariadic','prosupport','proacl'];
const hash=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
export const nativeInventoryLimits=Object.freeze({fileBytes:16*1024*1024,functions:100000,dependencies:250000});
/** Native JSON values only: undefined/Date/BigInt must not vanish in serialization. */
export function nativeInventoryCanonical(value:unknown):string{
 if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
 if(typeof value==='number'){if(!Number.isFinite(value))throw Error('Finite native JSON number required');return JSON.stringify(value);}
 if(Array.isArray(value)){if(Object.keys(value).length!==value.length||Reflect.ownKeys(value).some(key=>typeof key!=='string'||key!=='length'&&!/^(?:0|[1-9][0-9]*)$/.test(key)))throw Error('Dense native JSON arrays required');return'['+value.map(nativeInventoryCanonical).join(',')+']';}
 if(value&&typeof value==='object'&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null)){
  if(Reflect.ownKeys(value).some(key=>typeof key!=='string'))throw Error('Native JSON symbol fields refused');
  return'{'+Object.keys(value).sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b))).map(key=>JSON.stringify(key)+':'+nativeInventoryCanonical(Reflect.get(value,key))).join(',')+'}';
 }
 throw Error('Lossless native JSON value required');
}
const same=(actual:unknown,expected:unknown,label:string)=>{if(nativeInventoryCanonical(actual)!==nativeInventoryCanonical(expected))throw Error('Native inventory '+label+' differs');};
const identity=(value:z.infer<typeof type>)=>({schema:value.schema,name:value.name,identity:value.identity,formatted:value.formatted});
const rawOid=(value:unknown)=>{const parsed=z.union([oid,z.string().regex(/^(?:0|[1-9][0-9]{0,9})$/).transform(value=>Number(value)).pipe(oid)]).parse(value);return parsed;};
const rawOids=(value:unknown)=>value===null?null:z.array(z.unknown()).parse(value).map(rawOid);
const ids=(value:readonly z.infer<typeof type>[]|null)=>value===null?null:value.map(item=>item.oid);
const types=(value:readonly z.infer<typeof type>[]|null)=>value===null?null:value.map(identity);
/** Resolve ONLY columns whose native catalog type is an OID reference. Full raw
 * metadata and source/default/body-node bytes remain separately inseparable. */
export function normalizeNotificationCanonicalInventory(input:unknown){
 const capture=catalogueSchema.parse(input),signatures=new Set<string>(),oids=new Set<number>(),normalized:Record<string,unknown>[]=[],unresolved:Array<{signature:string;field:string;sha256:string;reason:string}>=[];
 if(new Set(capture.columns).size!==capture.columns.length||capture.functionCount!==capture.functions.length||capture.functions.length===0)throw Error('Complete nonempty native function inventory required');
 const unknownColumns=capture.columns.filter(field=>![...scalarFields,...referenceFields].includes(field));
 let sourceBytes=0,maximumBodyBytes=0;
 for(const row of capture.functions){
  const raw=row.raw;
  same(Object.keys(raw).sort(),[...capture.columns].sort(),'complete pg_proc column membership');
  const actualOid=rawOid(raw.oid);if(actualOid===0||signatures.has(row.signature)||oids.has(actualOid))throw Error('Duplicate native function signature or OID');signatures.add(row.signature);oids.add(actualOid);
  same(rawOid(raw.pronamespace),row.namespace.oid,'namespace reference');same(rawOid(raw.proowner),row.owner.oid,'owner reference');same(rawOid(raw.prolang),row.language.oid,'language reference');same(rawOid(raw.prorettype),row.returnType.oid,'return type reference');
  same(rawOids(raw.proargtypes),row.inputTypes.map(item=>item.oid),'input OID vector');same(rawOids(raw.proallargtypes),ids(row.allTypes),'all argument type references');same(rawOids(raw.protrftypes),ids(row.transformTypes),'transform type references');same(rawOid(raw.provariadic),row.variadicType?.oid??0,'variadic type reference');same(row.supportOid,row.support?.oid??0,'support function reference');same(raw.prosupport,row.supportText,'native support regproc representation');
  same(raw.pronargs,row.inputTypes.length,'native argument count');
  if(typeof raw.prosrc!=='string'||Buffer.byteLength(raw.prosrc)!==row.sourceBytes||hash(Buffer.from(raw.prosrc))!==row.sourceSha256)throw Error('Exact native source bytes differ after JSON roundtrip');
  sourceBytes+=row.sourceBytes;maximumBodyBytes=Math.max(maximumBodyBytes,row.sourceBytes);
  unresolved.push({signature:row.signature,field:'prosrc',sha256:row.sourceSha256,reason:'OPAQUE_EXACT_IMPLEMENTATION_BODY_RETAINED; dynamic source OIDs are never text-rewritten; source attribution remains pending'});
  for(const item of [...row.inputTypes,...(row.allTypes??[]),...(row.transformTypes??[]),row.returnType,...(row.variadicType?[row.variadicType]:[])]){same(rawOid(item.raw.oid),item.oid,'referenced type OID');same(rawOid(item.raw.typnamespace),item.namespaceOid,'referenced type namespace');same(item.raw.typname,item.name,'referenced type name');}
  same(rawOid(row.namespace.raw.oid),row.namespace.oid,'raw namespace OID');same(row.namespace.raw.nspname,row.namespace.name,'raw namespace name');same(rawOid(row.language.raw.oid),row.language.oid,'raw language OID');same(row.language.raw.lanname,row.language.name,'raw language name');if(row.support)same(rawOid(row.support.raw.oid),row.support.oid,'support raw OID');
  for(const field of ['proargdefaults','prosqlbody','probin',...unknownColumns])if(raw[field]!==null){
   unresolved.push({signature:row.signature,field,sha256:hash(nativeInventoryCanonical(raw[field])),reason:field==='proargdefaults'?'OPAQUE_NATIVE_DEFAULT_NODE_RETAINED_NO_TEXT_REWRITE':field==='prosqlbody'?'OPAQUE_NATIVE_BODY_NODE_RETAINED_NO_TEXT_REWRITE':field==='probin'?'EXTERNAL_IMPLEMENTATION_REQUIRES_REVIEW':'UNKNOWN_NATIVE_FIELD_RETAINED_UNNORMALIZED'});
  }
  // No ACL/default/body/source text is parsed as an OID. Resolved ACL references
  // come from native aclexplode, preserving NULL-vs-explicit ACL representation.
  const nativeAcl=row.acl.map(item=>({grantor:item.grantor,grantee:item.grantee,privilege:item.privilege,grantable:item.grantable})).sort((a,b)=>Buffer.compare(Buffer.from(nativeInventoryCanonical(a)),Buffer.from(nativeInventoryCanonical(b))));
  normalized.push({...raw,oid:row.signature,pronamespace:row.namespace.name,proowner:row.owner.name,prolang:row.language.name,prorettype:identity(row.returnType),proargtypes:types(row.inputTypes),proallargtypes:types(row.allTypes),protrftypes:types(row.transformTypes),provariadic:row.variadicType?identity(row.variadicType):null,prosupport:row.support?.identity??null,proacl:{explicit:raw.proacl!==null,entries:nativeAcl},nativeIdentityArguments:row.nativeIdentityArguments,nativeArguments:row.nativeArguments,nativeResult:row.nativeResult,nativeDefaults:row.nativeDefaults,nativeDefinition:row.nativeDefinition});
 }
 if(new Set(normalized.map(row=>row.oid)).size!==capture.functionCount)throw Error('Normalized native membership lost or duplicated a helper');
 normalized.sort((a,b)=>Buffer.compare(Buffer.from(String(a.oid)),Buffer.from(String(b.oid))));
 return{kind:'COMPLETE_NATIVE_HELPER_CATALOGUE_DIAGNOSTIC_NOT_EXPECTED_PROFILE',captureComplete:true,expectedProfileAuthorized:false,releaseAuthorized:false,
  functionCount:capture.functionCount,sourceBytes,maximumBodyBytes,rawSha256:hash(nativeInventoryCanonical(capture)),normalizedSha256:hash(nativeInventoryCanonical(normalized)),
  typedReferenceFields:[...referenceFields],unknownColumns,unresolvedPortability:unresolved,dynamicSourceOidTextNormalization:'NONE; exact prosrc bytes are retained and attributed only during later source-owner review',
  dependencies:{rawRows:capture.dependencies.length,rawSha256:hash(nativeInventoryCanonical(capture.dependencies)),sharedRows:capture.sharedDependencies.length,sharedSha256:hash(nativeInventoryCanonical(capture.sharedDependencies)),normalization:'NONE; every raw native dependency and native identity descriptor retained'},
  portableExpectedProfileApproved:false,normalized};
}
