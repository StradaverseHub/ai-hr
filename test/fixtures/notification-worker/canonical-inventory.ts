/** Pure inventory representation only. No profile activation, SQL or permission. */
import {createHash} from 'node:crypto';
import {z} from 'zod';
const object=z.record(z.string(),z.unknown()),oid=z.number().int().safe().nonnegative().max(4294967295),positiveOid=oid.refine(value=>value>0);
const named=z.object({oid:positiveOid,name:z.string().min(1)}).strict();
const type=z.object({oid:positiveOid,schema:z.string().min(1),namespaceOid:positiveOid,name:z.string().min(1),identity:z.string().min(1),formatted:z.string().min(1),raw:object}).strict();
const acl=z.object({grantorOid:positiveOid,granteeOid:oid,privilege:z.string().min(1),grantable:z.boolean()}).strict();
const role=z.object({oid,name:z.string().min(1)}).strict();
const support=z.object({oid:positiveOid,identity:z.string().min(1),regprocText:z.string().min(1).refine(value=>value!=='-','Positive native support cannot encode the zero sentinel'),raw:object}).strict();
const functionSchema=z.object({raw:object,signature:z.string().min(1),namespaceOid:positiveOid,ownerOid:positiveOid,languageOid:positiveOid,returnTypeOid:positiveOid,inputTypeOids:z.array(positiveOid).max(1024),allTypeOids:z.array(positiveOid).max(2048).nullable(),transformTypeOids:z.array(positiveOid).max(1024).nullable(),variadicTypeOid:oid,supportOid:oid,supportText:z.string(),acl:z.array(acl).max(10000),nativeArguments:z.string(),nativeIdentityArguments:z.string(),nativeResult:z.string().nullable(),nativeDefaults:z.string().nullable(),nativeDefinition:z.string().nullable(),sourceBytes:z.number().int().safe().nonnegative(),sourceSha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const count=z.number().int().safe().nonnegative();
const catalogueSchema=z.object({formatVersion:z.literal(2),columns:z.array(z.string().min(1)).max(256),functionCount:count,
 referenceCounts:z.object({types:count,namespaces:count,languages:count,roles:count,supports:count}).strict(),
 dictionaries:z.object({types:z.record(z.string(),type),namespaces:z.record(z.string(),named.extend({raw:object})),languages:z.record(z.string(),named.extend({raw:object})),roles:z.record(z.string(),role),supports:z.record(z.string(),support)}).strict(),
 functions:z.array(functionSchema).max(100000),dependencies:z.array(object).max(250000),sharedDependencies:z.array(object).max(250000)}).strict();
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
/** OID-keyed records are dictionaries, never last-wins aliases. Exact key,
 * embedded OID, raw OID and complete referenced membership all must agree. */
function oidDictionary<T extends {oid:number}>(entries:Record<string,T>,label:string){
 if(Object.keys(entries).length>100000)throw Error('Native reference dictionary bound');const map=new Map<number,T>();
 for(const [key,value]of Object.entries(entries)){const id=rawOid(key);if(map.has(value.oid))throw Error('Duplicate native '+label+' dictionary OID');same(id,value.oid,label+' dictionary key');map.set(id,value);}return map;
}
function referenced<T>(map:Map<number,T>,id:number,label:string){const value=map.get(id);if(value===undefined)throw Error('Dangling native '+label+' reference');return value;}
/** Raw body/default/node metadata is NEVER rewritten. Only explicit typed
 * references resolve through the complete same-query dictionaries. */
export function normalizeNotificationCanonicalInventory(input:unknown){
 const capture=catalogueSchema.parse(input),signatures=new Set<string>(),oids=new Set<number>(),normalized:Record<string,unknown>[]=[],unresolved:Array<{signature:string;field:string;sha256:string;reason:string}>=[];
 if(new Set(capture.columns).size!==capture.columns.length||capture.functionCount!==capture.functions.length||capture.functions.length===0)throw Error('Complete nonempty native function inventory required');
 const maps={types:oidDictionary(capture.dictionaries.types,'type'),namespaces:oidDictionary(capture.dictionaries.namespaces,'namespace'),languages:oidDictionary(capture.dictionaries.languages,'language'),roles:oidDictionary(capture.dictionaries.roles,'role'),supports:oidDictionary(capture.dictionaries.supports,'support')};
 const wanted={types:new Set<number>(),namespaces:new Set<number>(),languages:new Set<number>(),roles:new Set<number>(),supports:new Set<number>()};
 for(const item of maps.types.values()){
  same(rawOid(item.raw.oid),item.oid,'referenced type OID');same(rawOid(item.raw.typnamespace),item.namespaceOid,'referenced type namespace');same(item.raw.typname,item.name,'referenced type name');
  const namespace=referenced(maps.namespaces,item.namespaceOid,'type namespace');same(item.schema,namespace.name,'type namespace identity');wanted.namespaces.add(item.namespaceOid);
 }
 for(const item of maps.namespaces.values()){same(rawOid(item.raw.oid),item.oid,'raw namespace OID');same(item.raw.nspname,item.name,'raw namespace name');}
 for(const item of maps.languages.values()){same(rawOid(item.raw.oid),item.oid,'raw language OID');same(item.raw.lanname,item.name,'raw language name');}
 for(const item of maps.supports.values())same(rawOid(item.raw.oid),item.oid,'support raw OID');
 for(const item of maps.roles.values())if((item.oid===0)!==(item.name==='PUBLIC'))throw Error('Native PUBLIC role identity differs');
 const nativeType=(id:number)=>{wanted.types.add(id);return referenced(maps.types,id,'type');};
 const nativeTypes=(ids:readonly number[]|null)=>ids===null?null:ids.map(id=>identity(nativeType(id)));
 const nativeRole=(id:number)=>{wanted.roles.add(id);return referenced(maps.roles,id,'role').name;};
 const unknownColumns=capture.columns.filter(field=>![...scalarFields,...referenceFields].includes(field));let sourceBytes=0,maximumBodyBytes=0;
 for(const row of capture.functions){
  const raw=row.raw;same(Object.keys(raw).sort(),[...capture.columns].sort(),'complete pg_proc column membership');
  const actualOid=rawOid(raw.oid);if(actualOid===0||signatures.has(row.signature)||oids.has(actualOid))throw Error('Duplicate native function signature or OID');signatures.add(row.signature);oids.add(actualOid);
  same(rawOid(raw.pronamespace),row.namespaceOid,'namespace reference');same(rawOid(raw.proowner),row.ownerOid,'owner reference');same(rawOid(raw.prolang),row.languageOid,'language reference');same(rawOid(raw.prorettype),row.returnTypeOid,'return type reference');
  same(rawOids(raw.proargtypes),row.inputTypeOids,'input OID vector');same(rawOids(raw.proallargtypes),row.allTypeOids,'all argument type references');same(rawOids(raw.protrftypes),row.transformTypeOids,'transform type references');same(rawOid(raw.provariadic),row.variadicTypeOid,'variadic type reference');same(raw.prosupport,row.supportText,'native support regproc representation');if((row.supportOid===0)!==(row.supportText==='-'))throw Error('Native support OID/text binding differs');same(row.supportText,row.supportOid?referenced(maps.supports,row.supportOid,'support').regprocText:'-','native support OID/text binding');
  same(raw.pronargs,row.inputTypeOids.length,'native argument count');
  if(typeof raw.prosrc!=='string'||Buffer.byteLength(raw.prosrc)!==row.sourceBytes||hash(Buffer.from(raw.prosrc))!==row.sourceSha256)throw Error('Exact native source bytes differ after JSON roundtrip');
  sourceBytes+=row.sourceBytes;maximumBodyBytes=Math.max(maximumBodyBytes,row.sourceBytes);
  unresolved.push({signature:row.signature,field:'prosrc',sha256:row.sourceSha256,reason:'OPAQUE_EXACT_IMPLEMENTATION_BODY_RETAINED; dynamic source OIDs are never text-rewritten; source attribution remains pending'});
  for(const field of ['proargdefaults','prosqlbody','probin',...unknownColumns])if(raw[field]!==null)unresolved.push({signature:row.signature,field,sha256:hash(nativeInventoryCanonical(raw[field])),reason:field==='proargdefaults'?'OPAQUE_NATIVE_DEFAULT_NODE_RETAINED_NO_TEXT_REWRITE':field==='prosqlbody'?'OPAQUE_NATIVE_BODY_NODE_RETAINED_NO_TEXT_REWRITE':field==='probin'?'EXTERNAL_IMPLEMENTATION_REQUIRES_REVIEW':'UNKNOWN_NATIVE_FIELD_RETAINED_UNNORMALIZED'});
  wanted.namespaces.add(row.namespaceOid);wanted.languages.add(row.languageOid);if(row.supportOid)wanted.supports.add(row.supportOid);
  const namespace=referenced(maps.namespaces,row.namespaceOid,'namespace'),language=referenced(maps.languages,row.languageOid,'language');
  const nativeAcl=row.acl.map(item=>({grantor:nativeRole(item.grantorOid),grantee:nativeRole(item.granteeOid),privilege:item.privilege,grantable:item.grantable})).sort((a,b)=>Buffer.compare(Buffer.from(nativeInventoryCanonical(a)),Buffer.from(nativeInventoryCanonical(b))));
  normalized.push({...raw,oid:row.signature,pronamespace:namespace.name,proowner:nativeRole(row.ownerOid),prolang:language.name,
   prorettype:identity(nativeType(row.returnTypeOid)),proargtypes:nativeTypes(row.inputTypeOids),proallargtypes:nativeTypes(row.allTypeOids),protrftypes:nativeTypes(row.transformTypeOids),
   provariadic:row.variadicTypeOid?identity(nativeType(row.variadicTypeOid)):null,prosupport:row.supportOid?referenced(maps.supports,row.supportOid,'support').identity:null,
   proacl:{explicit:raw.proacl!==null,entries:nativeAcl},nativeIdentityArguments:row.nativeIdentityArguments,nativeArguments:row.nativeArguments,nativeResult:row.nativeResult,nativeDefaults:row.nativeDefaults,nativeDefinition:row.nativeDefinition});
 }
 for(const name of ['types','namespaces','languages','roles','supports']as const){same([...maps[name].keys()].sort((a,b)=>a-b),[...wanted[name]].sort((a,b)=>a-b),name+' complete referenced dictionary membership');same(maps[name].size,capture.referenceCounts[name],name+' native dictionary count');}
 if(new Set(normalized.map(row=>row.oid)).size!==capture.functionCount)throw Error('Normalized native membership lost or duplicated a helper');normalized.sort((a,b)=>Buffer.compare(Buffer.from(String(a.oid)),Buffer.from(String(b.oid))));
 return{kind:'COMPLETE_NATIVE_HELPER_CATALOGUE_DIAGNOSTIC_NOT_EXPECTED_PROFILE',captureFormatVersion:2,captureComplete:true,expectedProfileAuthorized:false,releaseAuthorized:false,
  functionCount:capture.functionCount,sourceBytes,maximumBodyBytes,rawSha256:hash(nativeInventoryCanonical(capture)),normalizedSha256:hash(nativeInventoryCanonical(normalized)),referenceCounts:capture.referenceCounts,
  typedReferenceFields:[...referenceFields],unknownColumns,unresolvedPortability:unresolved,dynamicSourceOidTextNormalization:'NONE; exact prosrc bytes are retained and attributed only during later source-owner review',
  dictionaryDisposition:'Every raw native referenced fact retained once; no extra or dangling typed references; nested opaque raw facts are not text-normalized',
  dependencies:{rawRows:capture.dependencies.length,rawSha256:hash(nativeInventoryCanonical(capture.dependencies)),sharedRows:capture.sharedDependencies.length,sharedSha256:hash(nativeInventoryCanonical(capture.sharedDependencies)),normalization:'NONE; every raw native dependency and native identity descriptor retained'},
  portableExpectedProfileApproved:false,normalized};
}
