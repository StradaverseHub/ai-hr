/** Pure policy/vault behavior. Successful LOCAL minimization never means a pending contract can leave
 * the tenant. No provider, configuration, secrets, database or transport is used in this suite. */
import {createHash} from 'node:crypto';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {prepareProviderData,inspectPreparedProviderData,resolveProviderDataHandle,assertProviderDataReviewApproved,retireProviderData,
 PROVIDER_DATA_CONTRACT,PROVIDER_DATA_LIMITS,type ProviderDataBinding,type ProviderDataScalar} from '../lib/ai/provider-data-policy';
const hash=(text:string)=>createHash('sha256').update(text,'utf8').digest('hex');
const binding=():ProviderDataBinding=>({feature:'hr_assistant',operation:'conversation',contractId:PROVIDER_DATA_CONTRACT,
 principalDigest:'1'.repeat(64),scopeDigest:'2'.repeat(64),providerSnapshotDigest:'3'.repeat(64),sourceFingerprint:'4'.repeat(64),expiresAt:Date.now()+60000});
const payload=(values:ProviderDataScalar[]=['Amina Private Sentinel','amina.private@example.test','901212-14-9876','+60123456789','private-person-uuid',987654.321,false,null])=>({version:1,records:[{ordinal:0,module:'employees',
 fields:values.map((value,ordinal)=>({ordinal,field:'employeeCode',format:'text',available:true,value}))}]});
const projected=(json:string)=>JSON.parse(json) as {version:number;purpose:'source_selection_only';records:{ordinal:number;module:string;fields:{ordinal:number;field:string;format:string;available:boolean;value:string}[]}[]};
afterEach(()=>{vi.useRealTimers();});
describe('closed provider-data minimization and pending review gate',()=>{
 it('emits only closed metadata and random handles; every original scalar stays local',()=>{
  const current=binding(),source=payload(),cap=prepareProviderData(current,source),result=inspectPreparedProviderData(cap,current),out=projected(result.json);
  expect(out).toEqual({version:1,purpose:'source_selection_only',records:[{ordinal:0,module:'employees',fields:source.records[0].fields.map(field=>({...field,value:expect.stringMatching(/^value_[A-Za-z0-9_-]{24}$/)}))}]});
  const handles=out.records[0].fields.map(field=>field.value);expect(new Set(handles).size).toBe(source.records[0].fields.length);
  for(const [index,handle] of handles.entries())expect(resolveProviderDataHandle(cap,current,handle)).toBe(source.records[0].fields[index].value);
  for(const scalar of source.records[0].fields.map(field=>field.value))if(typeof scalar==='string'||typeof scalar==='number')expect(result.json).not.toContain(String(scalar));
  expect(result.sanitizedDigest).toBe(hash(result.json));expect(result.originalSourceFingerprint).toBe(hash(JSON.stringify(source)));
  expect(result.purpose).toBe('source_selection_only');expect(result.reviewStatus).toBe('pending');expect(Object.isFrozen(result)).toBe(true);expect(Object.isFrozen(cap)).toBe(true);
  expect(()=>assertProviderDataReviewApproved(cap,current)).toThrow('AI data disclosure policy');retireProviderData(cap);
 });
 it('uses distinct request handles even for equal values and does not expose values in capability serialization',()=>{
  const current=binding(),source=payload(['Same private value','Same private value']),first=prepareProviderData(current,source),second=prepareProviderData(current,source);
  const a=projected(inspectPreparedProviderData(first,current).json).records[0].fields.map(field=>field.value),b=projected(inspectPreparedProviderData(second,current).json).records[0].fields.map(field=>field.value);
  expect(new Set([...a,...b]).size).toBe(4);expect(JSON.stringify(first)).toBe('{}');
  expect(()=>resolveProviderDataHandle(second,current,a[0])).toThrow('AI data disclosure policy');retireProviderData(first);retireProviderData(second);
 });
 it('requires the exact current principal, scope, provider and source binding; copied/serialized capabilities have no authority',()=>{
  const current=binding(),cap=prepareProviderData(current,payload()),handle=projected(inspectPreparedProviderData(cap,current).json).records[0].fields[0].value;
  for(const field of ['principalDigest','scopeDigest','providerSnapshotDigest','sourceFingerprint'] as const){const other={...current,[field]:'a'.repeat(64)};
   expect(()=>inspectPreparedProviderData(cap,other)).toThrow('AI data disclosure policy');expect(()=>resolveProviderDataHandle(cap,other,handle)).toThrow('AI data disclosure policy');}
  for(const fake of [{...cap},JSON.parse(JSON.stringify(cap)),Object.freeze({}),null,'capability'])expect(()=>inspectPreparedProviderData(fake,current)).toThrow('AI data disclosure policy');
  expect(()=>resolveProviderDataHandle(cap,current,'value_'+'a'.repeat(24))).toThrow('AI data disclosure policy');
  expect(resolveProviderDataHandle(cap,current,handle)).toBe('Amina Private Sentinel');retireProviderData(cap);
 });
 it('expires and retires local mappings without permitting clock or lifetime overrides',()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-30T03:00:00Z'));const current=binding(),cap=prepareProviderData(current,payload());
  const handle=projected(inspectPreparedProviderData(cap,current).json).records[0].fields[0].value;
  vi.advanceTimersByTime(60000);expect(()=>inspectPreparedProviderData(cap,current)).toThrow('AI data disclosure policy');expect(()=>resolveProviderDataHandle(cap,current,handle)).toThrow('AI data disclosure policy');
  vi.setSystemTime(new Date('2026-10-30T03:00:00Z'));expect(()=>inspectPreparedProviderData(cap,current)).toThrow('AI data disclosure policy');
  for(const expiresAt of [Date.now(),Date.now()-1,Date.now()+PROVIDER_DATA_LIMITS.lifetimeMs+1,Infinity,NaN])expect(()=>prepareProviderData({...binding(),expiresAt},payload())).toThrow('AI data disclosure policy');
  const live=binding(),retired=prepareProviderData(live,payload());retireProviderData(retired);expect(()=>inspectPreparedProviderData(retired,live)).toThrow('AI data disclosure policy');
 });
 it('fails closed for unknown contracts/features/operations, images, arbitrary prose and posted safe/reviewed overrides',()=>{
  const current=binding();
  for(const update of [{contractId:'unknown_v1'},{feature:'report_insight'},{operation:'image'},{operation:'draft'},{reviewed:true},{safe:true},{principalDigest:'not-a-digest'}])expect(()=>prepareProviderData({...current,...update},payload())).toThrow('AI data disclosure policy');
  for(const source of ['Raw private question',new Uint8Array([1,2,3]),{prompt:'Private input'},{version:1,records:[],system:'Private instructions'},
   {version:1,records:[{ordinal:0,module:'employees',fields:[],privateComment:'Unreviewed'}]}])expect(()=>prepareProviderData(current,source)).toThrow('AI data disclosure policy');
  const cap=prepareProviderData(current,payload([]));expect(inspectPreparedProviderData(cap,current).reviewStatus).toBe('pending');expect(()=>assertProviderDataReviewApproved(cap,current)).toThrow();retireProviderData(cap);
 });
 it('rejects getters, toJSON, custom prototypes, proxy traps, unknown field names and non-scalars without evaluating them',()=>{
  const current=binding();let invoked=0;
  const getter={version:1,get records(){invoked++;return [];}};
  const custom=Object.assign(Object.create({private:'inherited'}),payload());
  const proxy=new Proxy(payload(),{getPrototypeOf(){invoked++;return Object.prototype;}});
  const toJSON={...payload(),toJSON(){invoked++;return {};}};
  const accessorBinding={...current,get principalDigest(){invoked++;return '1'.repeat(64);}};
  for(const source of [getter,custom,proxy,toJSON])expect(()=>prepareProviderData(current,source)).toThrow('AI data disclosure policy');
  expect(()=>prepareProviderData(accessorBinding,payload())).toThrow('AI data disclosure policy');expect(invoked).toBe(0);
  for(const value of [undefined,Infinity,NaN,{},[],()=>{},'x'.repeat(PROVIDER_DATA_LIMITS.scalarCharacters+1)]){const source=payload(['value']);(source.records[0].fields[0] as {value:unknown}).value=value;expect(()=>prepareProviderData(current,source)).toThrow();}
  const unknown=payload(['value']);unknown.records[0].fields[0].field='secretBankAccount';expect(()=>prepareProviderData(current,unknown)).toThrow();
 });
 it('enforces closed ordinals, formats, array descriptors and aggregate byte/count bounds without partial capabilities',()=>{
  const current=binding(),duplicate=payload(['one','two']);duplicate.records[0].fields[1].ordinal=0;
  const negative=payload(['one']);negative.records[0].ordinal=-1;
  const format=payload(['one']);format.records[0].fields[0].format='raw_html';
  const tooMany={version:1,records:Array.from({length:PROVIDER_DATA_LIMITS.records+1},(_,ordinal)=>({ordinal,module:'employees',fields:[]}))};
  const tooManyFields=payload(Array.from({length:PROVIDER_DATA_LIMITS.fields+1},()=> 'one'));
  const bytes={version:1,records:Array.from({length:2},(_,ordinal)=>({ordinal,module:'employees',fields:Array.from({length:64},(_,ordinal)=>({ordinal,field:'employeeCode',format:'text',available:true,value:'x'.repeat(4096)}))}))};
  const sparse=payload(['one']);delete (sparse.records[0].fields as unknown[])[0];
  let invoked=false;const accessor=payload(['one']);Object.defineProperty(accessor.records,'0',{enumerable:true,get(){invoked=true;return {};}});
  for(const source of [duplicate,negative,format,tooMany,tooManyFields,bytes,sparse,accessor])expect(()=>prepareProviderData(current,source)).toThrow('AI data disclosure policy');expect(invoked).toBe(false);
 });
 it('captures immutable projection and vault values before callers mutate their own source or binding',()=>{
  const current=binding(),source=payload(['Original private value']),cap=prepareProviderData(current,source),projection=inspectPreparedProviderData(cap,current),handle=projected(projection.json).records[0].fields[0].value;
  source.records[0].fields[0].value='Changed private value';source.records[0].module='claims';
  expect(inspectPreparedProviderData(cap,current)).toBe(projection);expect(resolveProviderDataHandle(cap,current,handle)).toBe('Original private value');
  const swapped={...current,principalDigest:'9'.repeat(64)};expect(()=>inspectPreparedProviderData(cap,swapped)).toThrow();retireProviderData(cap);
 });
});
