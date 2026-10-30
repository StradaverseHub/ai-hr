import {providerDataReviewStatus,assertProviderDataContractReviewed} from './provider-data-reviews';
import {PROVIDER_DATA_TRANSFORM_SOURCE_DIGEST} from './provider-data-source-manifest';
/** Provider-data minimization primitives. This module grants neither source access nor permission to
 * dispatch: native owners must authorize/replay sources and the gateway must enforce the review gate.
 * No review is implied by a successful local projection. The initial contract remains PENDING. */
import {createHash,randomBytes} from 'node:crypto';
import {types as nodeTypes} from 'node:util';
import {AGENT_MODULE_CODES} from './module-agents';
import {JOB_FACT_FIELDS,type JobFact} from './module-jobs';
import {AiGatewayError} from './types';
import type {AiFeatureId} from './features';
import type {AiOperation} from './governance';

export const PROVIDER_DATA_LIMITS=Object.freeze({records:128,fields:64,scalarCharacters:4096,totalBytes:262144,lifetimeMs:300000});
export const PROVIDER_DATA_CONTRACT='structured_canonical_records_v1' as const;
export type ProviderDataReviewStatus='pending'|'approved';
export type ProviderDataBinding=Readonly<{
 feature:AiFeatureId;operation:AiOperation;contractId:typeof PROVIDER_DATA_CONTRACT;
 principalDigest:string;scopeDigest:string;providerSnapshotDigest:string;sourceFingerprint:string;expiresAt:number;
}>;
export type ProviderDataScalar=string|number|boolean|null;
declare const preparedBrand:unique symbol;
export type PreparedProviderData=Readonly<{readonly [preparedBrand]:true}>;
export type PreparedProviderDataProjection=Readonly<{
 purpose:'source_selection_only';json:string;sanitizedDigest:string;originalSourceFingerprint:string;contractId:typeof PROVIDER_DATA_CONTRACT;
 contractSourceVersion:string;contractSourceDigest:string;reviewStatus:ProviderDataReviewStatus;
}>;
const modules=Object.freeze([...AGENT_MODULE_CODES]);
const allowedFields=Object.freeze([...JOB_FACT_FIELDS]);
const formats:readonly JobFact['format'][]=Object.freeze(['text','number','date','status','boolean','money','module','gap','blocks','performanceFramework','performanceArtifact','testingStatus']);
/** Closed source contract, not a posted schema or a reviewed:true override. A genuine specialist
 * review and its durable evidence must precede any future source change to this review record. */
const contract=Object.freeze({id:PROVIDER_DATA_CONTRACT,sourceVersion:'structured-canonical-records.v1',feature:'hr_assistant',operation:'conversation',

 sourceDigest:hash(JSON.stringify({version:1,id:PROVIDER_DATA_CONTRACT,purpose:'source_selection_only',shape:{root:['version','records'],record:['ordinal','module','fields'],field:['ordinal','field','format','available','value']},
  protected:'every value scalar becomes a random opaque handle',modules,fields:allowedFields,formats,limits:PROVIDER_DATA_LIMITS}))});
type Owned={binding:ProviderDataBinding;bindingDigest:string;projection:PreparedProviderDataProjection;values:Map<string,ProviderDataScalar>;monotonicDeadline:number;timer?:ReturnType<typeof setTimeout>};
const prepared=new WeakMap<object,Owned>();
function hash(value:string){return createHash('sha256').update(value,'utf8').digest('hex');}
const unavailable=():never=>{throw new AiGatewayError('The AI data disclosure policy could not be confirmed.');};
/** Descriptor reads reject accessors before invocation; JSON parsing/stringifying untrusted objects
 * would invoke toJSON/getters. Only these exact data fields may influence the projection. */
function record(value:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||nodeTypes.isProxy(value)||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return unavailable();
 const descriptors=Object.getOwnPropertyDescriptors(value),actual=Reflect.ownKeys(descriptors);
 if(actual.length!==keys.length||actual.some(key=>typeof key!=='string'||!keys.includes(key)))return unavailable();
 const captured=Object.create(null) as Record<string,unknown>;
 for(const key of keys){const descriptor=descriptors[key];if(!descriptor?.enumerable||!('value'in descriptor))return unavailable();captured[key]=descriptor.value;}
 return captured;
}
function list(value:unknown,maximum:number):readonly unknown[]{
 if(!Array.isArray(value)||nodeTypes.isProxy(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length>maximum)return unavailable();
 const descriptors=Object.getOwnPropertyDescriptors(value);if(Reflect.ownKeys(descriptors).length!==value.length+1)return unavailable();
 return Object.freeze(Array.from({length:value.length},(_,index)=>{const descriptor=descriptors[String(index)];if(!descriptor||!('value'in descriptor))return unavailable();return descriptor.value;}));
}
function captureBinding(value:unknown):ProviderDataBinding{
 const source=record(value,['feature','operation','contractId','principalDigest','scopeDigest','providerSnapshotDigest','sourceFingerprint','expiresAt']);
 if(source.feature!==contract.feature||source.operation!==contract.operation||source.contractId!==contract.id)return unavailable();
 for(const key of ['principalDigest','scopeDigest','providerSnapshotDigest','sourceFingerprint'])if(typeof source[key]!=='string'||!/^[a-f0-9]{64}$/.test(source[key]))return unavailable();
 if(typeof source.expiresAt!=='number'||!Number.isSafeInteger(source.expiresAt)||source.expiresAt<=Date.now()||source.expiresAt>Date.now()+PROVIDER_DATA_LIMITS.lifetimeMs)return unavailable();
 return Object.freeze(source) as ProviderDataBinding;
}
function owned(capability:unknown,current:unknown):Owned{
 if(!capability||typeof capability!=='object')return unavailable();
 const state=prepared.get(capability);if(!state)return unavailable();
 if(state.binding.expiresAt<=Date.now()||performance.now()>=state.monotonicDeadline){state.values.clear();if(state.timer)clearTimeout(state.timer);prepared.delete(capability);return unavailable();}
 const binding=captureBinding(current);if(hash(JSON.stringify(binding))!==state.bindingDigest)return unavailable();
 return state;
}

/** Builds a LOCAL reviewable projection, including for a pending contract. It cannot authorize egress.
 * All protected scalars, including booleans, null, dates, amounts and identifiers, become independent
 * random handles. Only closed module/field/format enums, bounded ordinals and availability survive.
 * This is SELECTOR-ONLY input: unavailable raw values cannot support model numerical analysis.
 * Raw questions, prompts, model prose, images, unknown fields and custom objects have no contract. */
export function prepareProviderData(binding:unknown,payload:unknown):PreparedProviderData{
 try{
  const capturedBinding=captureBinding(binding),root=record(payload,['version','records']);if(root.version!==1)return unavailable();
  const values=new Map<string,ProviderDataScalar>(),seenRecords=new Set<number>();let bytes=0;
  const sourceRecords:unknown[]=[],records=list(root.records,PROVIDER_DATA_LIMITS.records).map(item=>{
   const row=record(item,['ordinal','module','fields']);
   if(typeof row.ordinal!=='number'||!Number.isSafeInteger(row.ordinal)||row.ordinal<0||row.ordinal>=PROVIDER_DATA_LIMITS.records||seenRecords.has(row.ordinal)||
    typeof row.module!=='string'||!(modules as readonly string[]).includes(row.module))return unavailable();
   seenRecords.add(row.ordinal);const seenFields=new Set<number>(),sourceFields:unknown[]=[];
   const fields=list(row.fields,PROVIDER_DATA_LIMITS.fields).map(item=>{
    const field=record(item,['ordinal','field','format','available','value']),value=field.value;
    if(typeof field.ordinal!=='number'||!Number.isSafeInteger(field.ordinal)||field.ordinal<0||field.ordinal>=PROVIDER_DATA_LIMITS.fields||seenFields.has(field.ordinal)||
     typeof field.field!=='string'||!(allowedFields as readonly string[]).includes(field.field)||typeof field.format!=='string'||!formats.includes(field.format as JobFact['format'])||typeof field.available!=='boolean')return unavailable();
    if(value!==null&&typeof value!=='string'&&typeof value!=='boolean'&&typeof value!=='number'||typeof value==='number'&&!Number.isFinite(value)||typeof value==='string'&&value.length>PROVIDER_DATA_LIMITS.scalarCharacters)return unavailable();
    seenFields.add(field.ordinal);bytes+=Buffer.byteLength(JSON.stringify(value),'utf8');if(bytes>PROVIDER_DATA_LIMITS.totalBytes)return unavailable();
    const handle='value_'+randomBytes(18).toString('base64url');if(values.has(handle))return unavailable();values.set(handle,value as ProviderDataScalar);
    sourceFields.push(Object.freeze({...field}));
    return Object.freeze({ordinal:field.ordinal,field:field.field,format:field.format,available:field.available,value:handle});
   });
   sourceRecords.push(Object.freeze({ordinal:row.ordinal,module:row.module,fields:Object.freeze(sourceFields)}));
   return Object.freeze({ordinal:row.ordinal,module:row.module,fields:Object.freeze(fields)});
  });
  const json=JSON.stringify({version:1,purpose:'source_selection_only',records});if(Buffer.byteLength(json,'utf8')>PROVIDER_DATA_LIMITS.totalBytes)return unavailable();
  const originalSourceFingerprint=hash(JSON.stringify({version:1,records:sourceRecords}));
  const projection=Object.freeze({purpose:'source_selection_only' as const,json,sanitizedDigest:hash(json),originalSourceFingerprint,contractId:contract.id,contractSourceVersion:contract.sourceVersion,contractSourceDigest:PROVIDER_DATA_TRANSFORM_SOURCE_DIGEST,reviewStatus:providerDataReviewStatus(contract.id)});
  const capability=Object.freeze(Object.create(null)) as PreparedProviderData;
  const state:Owned={binding:capturedBinding,bindingDigest:hash(JSON.stringify(capturedBinding)),projection,values,monotonicDeadline:performance.now()+Math.max(0,capturedBinding.expiresAt-Date.now())};
  state.timer=setTimeout(()=>{values.clear();prepared.delete(capability);},Math.max(1,capturedBinding.expiresAt-Date.now()));state.timer.unref?.();
  prepared.set(capability,state);
  return capability;
 }catch{return unavailable();}
}
/** The JSON is safe to inspect locally for specialist review; this function does NOT lift the gate. */
export function inspectPreparedProviderData(capability:unknown,current:unknown):PreparedProviderDataProjection{return owned(capability,current).projection;}
/** No generic prose restoration exists. Exact lookup is for an authorized local canonical owner;
 * knowing a handle is never source-read, effect or display authority. */
export function resolveProviderDataHandle(capability:unknown,current:unknown,handle:unknown):ProviderDataScalar{
 const state=owned(capability,current);
 if(typeof handle!=='string'||!/^value_[A-Za-z0-9_-]{24}$/.test(handle)||!state.values.has(handle))return unavailable();
 return state.values.get(handle)!;
}
export function assertProviderDataReviewApproved(capability:unknown,current:unknown):void{
 const state=owned(capability,current);
 try{assertProviderDataContractReviewed(contract.id,state.projection.contractSourceDigest);}catch{return unavailable();}
}
/** Explicit completion/cancellation clears local values immediately; expiration also clears on access.
 * Nothing here persists a mapping, raw scalar, prompt, tenant identifier or model output. */
export function retireProviderData(capability:unknown):void{
 if(!capability||typeof capability!=='object')return;const state=prepared.get(capability);if(!state)return;
 state.values.clear();if(state.timer)clearTimeout(state.timer);prepared.delete(capability);
}
