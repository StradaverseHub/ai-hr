/** CLOSED attendance-analysis projection, prepared locally for specialist review only. PENDING means
 * no provider dispatch is authorized. Pseudonymized bands still expose relationships/cardinality and
 * may permit reidentification; provisional cohort thresholds are not an anonymity guarantee.
 * The native attendance owner must derive every band/trend and authorize/replay the complete cohort.
 * Digests supplied here do not prove that authority. No prose, image, exact date, amount or count has
 * a pass-through contract; the AI may explain/compare supplied categories, never calculate HR truth. */
import {createHash,randomBytes} from 'node:crypto';
import {types as nodeTypes} from 'node:util';
import {AiGatewayError} from './types';
import type {ProviderDataReviewStatus} from './provider-data-policy';
export const ATTENDANCE_ANALYSIS_CONTRACT='attendance_trend_analysis_v1' as const;
export const ATTENDANCE_ANALYSIS_LIMITS=Object.freeze({minimumPeoplePerCohort:20,minimumNonzeroSlice:5,maximumPeople:500,maximumCohorts:2,bytes:262144,lifetimeMs:300000});
const windows=Object.freeze(['four_weeks','calendar_month'] as const);
const cohortLabels=Object.freeze(['cohort_a','cohort_b'] as const);
const periods=Object.freeze(['previous','current'] as const);
const attendanceBands=Object.freeze(['full','high','mixed','low'] as const);
const punctualityBands=Object.freeze(['on_time','occasional_lateness','frequent_lateness'] as const);
const trends=Object.freeze(['improved','steady','declined'] as const);
export type AttendanceAnalysisBinding=Readonly<{feature:'hr_assistant';operation:'conversation';contractId:typeof ATTENDANCE_ANALYSIS_CONTRACT;
 principalDigest:string;scopeDigest:string;providerSnapshotDigest:string;sourceFingerprint:string;expiresAt:number}>;
declare const attendanceBrand:unique symbol;
export type PreparedAttendanceAnalysis=Readonly<{readonly [attendanceBrand]:true}>;
export type AttendanceAnalysisProjection=Readonly<{purpose:'attendance_trend_analysis';sourceStatus:'requires_native_owner_replay';risk:'pseudonymized_person_level_bands';
 json:string;sanitizedDigest:string;originalSourceFingerprint:string;contractId:typeof ATTENDANCE_ANALYSIS_CONTRACT;contractSourceVersion:string;contractSourceDigest:string;reviewStatus:ProviderDataReviewStatus}>;
const hash=(text:string)=>createHash('sha256').update(text,'utf8').digest('hex');
const contract=Object.freeze({id:ATTENDANCE_ANALYSIS_CONTRACT,version:'attendance-trend-analysis.v1',reviewStatus:'pending' as ProviderDataReviewStatus,
 digest:hash(JSON.stringify({id:ATTENDANCE_ANALYSIS_CONTRACT,version:1,purpose:'attendance_trend_analysis',windows,cohortLabels,periods,attendanceBands,punctualityBands,trends,
  input:{root:['version','window','cohorts'],cohort:['cohort','trend','records'],trend:['attendance','punctuality'],record:['personKey','period','attendanceBand','punctualityBand']},
  output:'personKey becomes a random per-preparation consistent alias; records reorder by random alias',limits:ATTENDANCE_ANALYSIS_LIMITS}))});
type Row={personKey:string;period:typeof periods[number];attendanceBand:typeof attendanceBands[number];punctualityBand:typeof punctualityBands[number]};
type Owned={binding:AttendanceAnalysisBinding;bindingDigest:string;projection:AttendanceAnalysisProjection;people:Map<string,string>;deadline:number;timer?:ReturnType<typeof setTimeout>};
const vault=new WeakMap<object,Owned>();
const unavailable=():never=>{throw new AiGatewayError('The attendance analysis disclosure policy could not be confirmed.');};
function object(value:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||nodeTypes.isProxy(value)||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return unavailable();
 const descriptors=Object.getOwnPropertyDescriptors(value),actual=Reflect.ownKeys(descriptors);
 if(actual.length!==keys.length||actual.some(key=>typeof key!=='string'||!keys.includes(key)))return unavailable();
 const result=Object.create(null) as Record<string,unknown>;
 for(const key of keys){const descriptor=descriptors[key];if(!descriptor?.enumerable||!('value'in descriptor))return unavailable();result[key]=descriptor.value;}
 return result;
}
function list(value:unknown,maximum:number):readonly unknown[]{
 if(!Array.isArray(value)||nodeTypes.isProxy(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length>maximum)return unavailable();
 const descriptors=Object.getOwnPropertyDescriptors(value);if(Reflect.ownKeys(descriptors).length!==value.length+1)return unavailable();
 return Object.freeze(Array.from({length:value.length},(_,index)=>{const descriptor=descriptors[String(index)];if(!descriptor||!('value'in descriptor))return unavailable();return descriptor.value;}));
}
function member<const T extends readonly string[]>(value:unknown,allowed:T):T[number]{return typeof value==='string'&&(allowed as readonly string[]).includes(value)?value:unavailable();}
function binding(value:unknown):AttendanceAnalysisBinding{
 const captured=object(value,['feature','operation','contractId','principalDigest','scopeDigest','providerSnapshotDigest','sourceFingerprint','expiresAt']);
 if(captured.feature!=='hr_assistant'||captured.operation!=='conversation'||captured.contractId!==contract.id)return unavailable();
 for(const key of ['principalDigest','scopeDigest','providerSnapshotDigest','sourceFingerprint'])if(typeof captured[key]!=='string'||!/^[a-f0-9]{64}$/.test(captured[key]))return unavailable();
 if(typeof captured.expiresAt!=='number'||!Number.isSafeInteger(captured.expiresAt)||captured.expiresAt<=Date.now()||captured.expiresAt>Date.now()+ATTENDANCE_ANALYSIS_LIMITS.lifetimeMs)return unavailable();
 return Object.freeze(captured) as AttendanceAnalysisBinding;
}
function owned(capability:unknown,current:unknown):Owned{
 if(!capability||typeof capability!=='object')return unavailable();const state=vault.get(capability);if(!state)return unavailable();
 if(state.binding.expiresAt<=Date.now()||performance.now()>=state.deadline){retireAttendanceTrendAnalysis(capability);return unavailable();}
 if(hash(JSON.stringify(binding(current)))!==state.bindingDigest)return unavailable();return state;
}
/** LOCAL review artifact only, never a reviewed:true/source-authorized assertion. Fixed coarse bands
 * and relative periods preserve an analytical relationship without sending their raw measurements.
 * A complete paired category history must occur >=5 times, and each nonzero per-period category
 * slice must also contain >=5 people. Both rules apply independently to each >=20-person cohort.
 * These provisional limits suppress tiny slices; external knowledge can still reidentify people. */
export function prepareAttendanceTrendAnalysis(current:unknown,payload:unknown):PreparedAttendanceAnalysis{
 try{
  const capturedBinding=binding(current),root=object(payload,['version','window','cohorts']);if(root.version!==1)return unavailable();
  const window=member(root.window,windows),cohorts=list(root.cohorts,ATTENDANCE_ANALYSIS_LIMITS.maximumCohorts);if(cohorts.length===0)return unavailable();
  const seenCohorts=new Set<string>(),allPeople=new Set<string>(),people=new Map<string,string>(),sourceCohorts:unknown[]=[];
  const output=cohorts.map(item=>{
   const source=object(item,['cohort','trend','records']),cohort=member(source.cohort,cohortLabels),rawTrend=object(source.trend,['attendance','punctuality']);
   if(seenCohorts.has(cohort))return unavailable();seenCohorts.add(cohort);
   const trend=Object.freeze({attendance:member(rawTrend.attendance,trends),punctuality:member(rawTrend.punctuality,trends)});
   const sourceRows:Row[]=[],paired=new Map<string,Map<string,Row>>(),slices=new Map<string,number>();
   const add=(key:string)=>slices.set(key,(slices.get(key)??0)+1);
   for(const item of list(source.records,ATTENDANCE_ANALYSIS_LIMITS.maximumPeople*2)){
    const raw=object(item,['personKey','period','attendanceBand','punctualityBand']);
    if(typeof raw.personKey!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(raw.personKey))return unavailable();
    const row:Row={personKey:raw.personKey,period:member(raw.period,periods),attendanceBand:member(raw.attendanceBand,attendanceBands),punctualityBand:member(raw.punctualityBand,punctualityBands)};
    const person=row.personKey.toLowerCase();let pair=paired.get(person);
    if(!pair){if(allPeople.has(person))return unavailable();allPeople.add(person);pair=new Map();paired.set(person,pair);}
    if(pair.has(row.period))return unavailable();pair.set(row.period,row);sourceRows.push(Object.freeze(row));
    add(row.period+':attendance:'+row.attendanceBand);add(row.period+':punctuality:'+row.punctualityBand);
   }
   if(paired.size<ATTENDANCE_ANALYSIS_LIMITS.minimumPeoplePerCohort||allPeople.size>ATTENDANCE_ANALYSIS_LIMITS.maximumPeople)return unavailable();
   const patterns=new Map<string,number>(),rows:{person:string;period:Row['period'];attendanceBand:Row['attendanceBand'];punctualityBand:Row['punctualityBand']}[]=[];
   for(const [person,pair] of paired){
    const previous=pair.get('previous'),current=pair.get('current');if(pair.size!==2||!previous||!current)return unavailable();
    const pattern=JSON.stringify([previous.attendanceBand,current.attendanceBand,previous.punctualityBand,current.punctualityBand]);patterns.set(pattern,(patterns.get(pattern)??0)+1);
    const alias='person_'+randomBytes(18).toString('base64url');if(people.has(alias))return unavailable();people.set(alias,person);
    for(const row of [previous,current])rows.push(Object.freeze({person:alias,period:row.period,attendanceBand:row.attendanceBand,punctualityBand:row.punctualityBand}));
   }
   if([...slices.values(),...patterns.values()].some(count=>count<ATTENDANCE_ANALYSIS_LIMITS.minimumNonzeroSlice))return unavailable();
   // Input employee ordering can itself identify people; emit random-alias order, never native order.
   rows.sort((a,b)=>a.person===b.person?(a.period==='previous'?-1:1):a.person<b.person?-1:1);
   sourceCohorts.push(Object.freeze({cohort,trend,records:Object.freeze(sourceRows)}));
   return Object.freeze({cohort,trend,records:Object.freeze(rows)});
  });
  const sourceJson=JSON.stringify({version:1,window,cohorts:sourceCohorts}),json=JSON.stringify({version:1,purpose:'attendance_trend_analysis',window,cohorts:output});
  if(Buffer.byteLength(sourceJson,'utf8')>ATTENDANCE_ANALYSIS_LIMITS.bytes||Buffer.byteLength(json,'utf8')>ATTENDANCE_ANALYSIS_LIMITS.bytes)return unavailable();
  const projection:AttendanceAnalysisProjection=Object.freeze({purpose:'attendance_trend_analysis',sourceStatus:'requires_native_owner_replay',risk:'pseudonymized_person_level_bands',json,
   sanitizedDigest:hash(json),originalSourceFingerprint:hash(sourceJson),contractId:contract.id,contractSourceVersion:contract.version,contractSourceDigest:contract.digest,reviewStatus:contract.reviewStatus});
  const capability=Object.freeze(Object.create(null)) as PreparedAttendanceAnalysis;
  const state:Owned={binding:capturedBinding,bindingDigest:hash(JSON.stringify(capturedBinding)),projection,people,deadline:performance.now()+Math.max(0,capturedBinding.expiresAt-Date.now())};
  state.timer=setTimeout(()=>{people.clear();vault.delete(capability);},Math.max(1,capturedBinding.expiresAt-Date.now()));state.timer.unref?.();vault.set(capability,state);return capability;
 }catch{return unavailable();}
}
export function inspectAttendanceTrendAnalysis(capability:unknown,current:unknown):AttendanceAnalysisProjection{return owned(capability,current).projection;}
/** Exact local lookup only. Neither knowing an alias nor this primitive authorizes a source read,
 * naming a person in a draft, or replacing arbitrary model prose. Native owners must decide those. */
export function resolveAttendancePersonAlias(capability:unknown,current:unknown,alias:unknown):string{
 const state=owned(capability,current);if(typeof alias!=='string'||!/^person_[A-Za-z0-9_-]{24}$/.test(alias)||!state.people.has(alias))return unavailable();return state.people.get(alias)!;
}
export function assertAttendanceTrendReviewApproved(capability:unknown,current:unknown):void{
 const state=owned(capability,current);if(state.projection.reviewStatus!=='approved'||contract.reviewStatus!=='approved')return unavailable();
}
export function retireAttendanceTrendAnalysis(capability:unknown):void{
 if(!capability||typeof capability!=='object')return;const state=vault.get(capability);if(!state)return;state.people.clear();if(state.timer)clearTimeout(state.timer);vault.delete(capability);
}
