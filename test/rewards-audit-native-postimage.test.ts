/** Pure comparator/protocol/context/source controls, never native acceptance. */
import {expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {assertAuditCanonicalTransition,type AuditNativeSnapshot} from './prototypes/rewards-audit-native-postimage';
import {defaultControllerInput,defaultControllerOutput,defaultControllerApplication} from './prototypes/rewards-audit-default-controller-protocol';
import {rewardsAuditOwnerConfiguration} from './prototypes/rewards-audit-fixture-context';
function model():AuditNativeSnapshot{return{row:{signature:'app._domain_event_next(uuid,boolean)',definition:'fixed model declaration',body:'fixed model body',details:{oid:123,prosrc:'fixed model body',proargdefaults:'opaque original model tree',proacl:null,prosupport:'0'}},args:'p_tenant uuid, p_try boolean DEFAULT false',identityArgs:'p_tenant uuid, p_try boolean',result:'jsonb',defaults:'false',language:'plpgsql',owner:'model_owner',acl:[],dependencies:[{objid:123,deptype:'n'}],sharedDependencies:[],family:[],publicFacts:{money:'model fact'}};}
function original(){const value=model();value.family=[value.row.details];return value;}
it('accepts only the complete model original or its native-default-only postimage without altering either input',()=>{
 const before=original(),after=structuredClone(before);after.row.details.proargdefaults='opaque canonical model tree';after.family=[after.row.details];const saved=structuredClone(before);
 expect(()=>assertAuditCanonicalTransition(before,before)).not.toThrow();expect(()=>assertAuditCanonicalTransition(before,after)).not.toThrow();expect(before).toEqual(saved);expect(after.row.details.proargdefaults).toBe('opaque canonical model tree');
});
it('refuses unknown model catalog fields, body, ACL, ABI, OID, dependencies, multiplicity and public-fact drift',()=>{
 const before=original();
 for(const [field,value]of Object.entries({oid:124,proacl:['unexpected'],prosupport:'77',pronargs:3,proargtypes:'2950 25',proconfig:['search_path=public'],unexpected:'new'})){
  const after=structuredClone(before);after.row.details[field]=value;after.family=[after.row.details];expect(()=>assertAuditCanonicalTransition(before,after),field).toThrow();
 }
 for(const mutate of [(v:AuditNativeSnapshot)=>{v.row.body+=' drift';},(v:AuditNativeSnapshot)=>{v.defaults='true';},(v:AuditNativeSnapshot)=>{v.dependencies.push({...v.dependencies[0]});},(v:AuditNativeSnapshot)=>{v.sharedDependencies.push({refobjid:99});},(v:AuditNativeSnapshot)=>{v.family.push({...v.row.details});},(v:AuditNativeSnapshot)=>{v.publicFacts.money='changed';}]){const after=structuredClone(before);mutate(after);expect(()=>assertAuditCanonicalTransition(before,after)).toThrow();}
});
it('the fixed private controller grammar accepts no caller SQL/signature/program/default or claimed verified state',()=>{
 const nonce='00000000-0000-4000-8000-000000000001',start={kind:'start',nonce,ownerUrl:'postgres://private.test/model'};
 expect(defaultControllerInput.parse(start)).toEqual(start);expect(defaultControllerInput.parse({kind:'continue',nonce})).toEqual({kind:'continue',nonce});expect(defaultControllerApplication(nonce)).toBe('rewards_default:'+nonce);
 for(const key of ['sql','signature','program','default','verified','role','path','canonicalization'])expect(defaultControllerInput.safeParse({...start,[key]:true}).success).toBe(false);
 const identity={nonce,database:'model',role:'owner',pid:3,started:'2026-11-08 00:00:00+00',xid:'4294967297'};
 for(const kind of ['prepared','committed','completed'])expect(defaultControllerOutput.safeParse({...identity,kind}).success).toBe(true);
 for(const value of [{...identity,kind:'verified'},{...identity,kind:'prepared',pid:'3'},{...identity,kind:'prepared',xid:'-1'},{kind:'refused',phase:'private error'},{kind:'refused',phase:'apply',raw:'secret'}])expect(defaultControllerOutput.safeParse(value).success).toBe(false);
});
it('the extracted original owner context preserves canonical hosted/worker/URL and endpoint refusals',()=>{
 const values={GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',VITEST_POOL_ID:'1',WORKER_DB:'1',TEST_DB_NAMESPACE:'',TEST_MIGRATION_DATABASE_URL:'postgres://owner:private@127.0.0.1:5432/ai_hr_test_w1',TEST_DATABASE_URL:'postgres://ai_hr_app:private@127.0.0.1:5432/ai_hr_test_w1'};
 try{for(const[key,value]of Object.entries(values))vi.stubEnv(key,value);const result=rewardsAuditOwnerConfiguration();expect(result).toMatchObject({pool:'1',database:'ai_hr_test_w1',namespace:''});expect(result.migration.username).toBe('owner');
  const invalid:Array<[keyof typeof values,string]>=[['GITHUB_ACTIONS','false'],['RUNNER_ENVIRONMENT','self-hosted'],['VITEST_POOL_ID','0'],['WORKER_DB','0'],['TEST_MIGRATION_DATABASE_URL','postgres://owner@localhost/ai_hr_test_w1'],['TEST_DATABASE_URL','postgres://ai_hr_app@127.0.0.1:5433/ai_hr_test_w1']];
  for(const[key,value]of invalid){vi.stubEnv(key,value);expect(()=>rewardsAuditOwnerConfiguration(),key).toThrow();vi.stubEnv(key,values[key]);}
 }finally{vi.unstubAllEnvs();}
});
it('the complete legacy factory is exactly reconstructed and both native SQL files remain byte-identical',()=>{
 const archive=JSON.parse(readFileSync('test/prototypes/rewards-audit-owner-context-original.json','utf8'));
 expect(archive.base).toBe('0e5b8695acb99615ee2a915f886bdd0d26a63613');
 const current=readFileSync('test/prototypes/rewards-audited-read-owner-factory.ts','utf8');
 const original=current.replace("import {rewardsAuditOwnerConfiguration} from './rewards-audit-fixture-context';","import {workerDb} from '../db-names';").replace(' const {database,namespace,pool,migration}=rewardsAuditOwnerConfiguration();\n',archive.originalContext);
 expect(createHash('sha256').update(original).digest('hex')).toBe(archive.originalFactorySha256);
 for(const[file,sha]of [['rewards-audited-read.sql','cad7076c1263888257084dbf5b2eef77ebb6e360dbf08ae38e2029a00a58b654'],['rewards-audit-policy.sql','634b83c911c972011111c4f63993cc82cf465aa00dd67c4e6042d91d10c9ce2c']])expect(createHash('sha256').update(readFileSync('test/prototypes/'+file)).digest('hex')).toBe(sha);
});
