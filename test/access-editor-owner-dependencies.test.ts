/** Native-owner dependency oracle models only; real rollback-control/native tests remain required. */
import {expect,it} from 'vitest';
import {accessNativeMetadataOid,accessOwnerDependencyExpectation,assertAccessOwnerDependencies,type AccessSharedDependency} from './fixtures/access-editor-owner-dependencies';
function sample(){
 const binding={database:37,roleCatalog:100,namespaceCatalog:200,functionCatalog:300,relationCatalog:400,typeCatalog:500,oldOwner:10,newOwner:999};
 const edge=(classid:number,objid:number,refobjid:number,deptype:string):AccessSharedDependency=>({dbid:37,classid,objid,objsubid:0,refclassid:100,refobjid,deptype});
 const acl=edge(300,3,88,'a');
 const before={namespaces:[{oid:1,nspname:'public',owner:71,details:{}},{oid:2,nspname:'app',owner:10,details:{}}],
  functions:[{oid:3,owner:10,details:{pronamespace:'2',prokind:'f'}},{oid:4,owner:10,details:{pronamespace:'1',prokind:'p'}},{oid:5,owner:77,details:{pronamespace:'2',prokind:'f'}},{oid:6,owner:10,details:{pronamespace:'1',prokind:'f'}}],
  relations:[{oid:7,owner:10,relnamespace:1,relname:'actual_table',details:{relkind:'r'}},{oid:8,owner:10,relnamespace:2,relname:'actual_view',details:{relkind:'v'}},{oid:9,owner:10,relnamespace:2,relname:'actual_sequence',details:{relkind:'S'}},{oid:10,owner:10,relnamespace:999,relname:'toast',details:{relkind:'r'}},{oid:11,owner:10,relnamespace:1,relname:'table_index',details:{relkind:'i'}}],
  types:[{oid:12,owner:10,details:{typnamespace:'2',typtype:'d'}},{oid:13,owner:10,details:{typnamespace:'1',typtype:'e'}},{oid:14,owner:10,details:{typnamespace:'1',typtype:'b'}},{oid:15,owner:10,details:{typnamespace:'1',typtype:'c'}},{oid:16,owner:10,details:{typnamespace:'1',typtype:'e'}},{oid:17,owner:77,details:{typnamespace:'2',typtype:'e'}}],
  extensionOwners:[{classid:300,objid:6},{classid:500,objid:16}],sharedDependencies:[acl,{...acl},edge(300,5,77,'o'),edge(400,8,88,'r'),edge(400,8,88,'x')]};
 const transfer={functions:[{oid:3},{oid:4}],relations:[{oid:7},{oid:8},{oid:9}],types:[{oid:12},{oid:13}]};
 const pin={tableOid:111,typeOid:112,arrayTypeOid:113,ownerBefore:10,ownerAfter:999,database:37,relationCatalog:400,typeCatalog:500,roleCatalog:100,before:[],after:[edge(400,111,999,'o')],rollbackComplete:true,objectAbsent:true,typesAbsent:true,localDependenciesAbsent:true,dependenciesAbsent:true};
 return{binding,before,transfer,pin};
}
it('derives exact source objects before transfer and preserves extension/automatic exclusions plus every baseline foreign/ACL multiplicity',()=>{
 const f=sample(),expected=accessOwnerDependencyExpectation(f.before,f.transfer,f.binding,f.pin);
 expect(expected.sourceObjects).toEqual({namespace:[2],functions:[3,4],relations:[7,8,9],types:[12,13]});expect(expected.addedOwnerRows).toBe(8);expect(expected.baselineRows).toBe(5);
 expect(expected.rawBeforeSharedDependencies).toEqual(f.before.sharedDependencies);expect(expected.expectedSharedDependencies.filter(row=>row.deptype==='a')).toHaveLength(2);expect(expected.expectedSharedDependencies).toContainEqual(f.before.sharedDependencies[2]);
 expect(()=>assertAccessOwnerDependencies(expected,[...expected.expectedSharedDependencies].reverse(),[...expected.expectedRawSharedDependencies].reverse())).not.toThrow();
});
it('refuses each missing/extra/cross-kind/object/subobject/reference-role/reference-class/database/flavor owner obligation',()=>{
 const f=sample(),expected=accessOwnerDependencyExpectation(f.before,f.transfer,f.binding,f.pin),rows=expected.expectedSharedDependencies,selected=rows.findIndex(row=>row.deptype==='o'&&row.refobjid===10);
 expect(selected).toBeGreaterThanOrEqual(0);const original=rows[selected];
 const mutations:AccessSharedDependency[]=[{...original,classid:400},{...original,objid:777},{...original,objsubid:1},{...original,refclassid:900},{...original,refobjid:999},{...original,dbid:38},{...original,deptype:'a'}];
 for(const changed of mutations){const actual=[...rows];actual[selected]=changed;expect(()=>assertAccessOwnerDependencies(expected,actual,expected.expectedRawSharedDependencies)).toThrow();}
 expect(()=>assertAccessOwnerDependencies(expected,rows.filter((_,i)=>i!==selected),expected.expectedRawSharedDependencies)).toThrow();expect(()=>assertAccessOwnerDependencies(expected,[...rows,original],expected.expectedRawSharedDependencies)).toThrow();
 const raw=expected.expectedRawSharedDependencies.map(row=>row.deptype==='o'&&row.refobjid===999?{...row,refobjid:10}:row);expect(()=>assertAccessOwnerDependencies(expected,rows,raw)).toThrow('Raw native');
});
it('does not let an incomplete/wrong/duplicated executed transfer replace independent BEFORE owners/kinds/namespace/extension truth',()=>{
 const f=sample();
 for(const transfer of [{...f.transfer,functions:f.transfer.functions.slice(1)},{...f.transfer,relations:[...f.transfer.relations,{oid:6}]},{...f.transfer,types:[{oid:12},{oid:12}]},{...f.transfer,functions:[{oid:7},{oid:4}]}])expect(()=>accessOwnerDependencyExpectation(f.before,transfer,f.binding,f.pin)).toThrow();
 const changed=structuredClone(f.before);changed.functions[0].owner=77;expect(()=>accessOwnerDependencyExpectation(changed,f.transfer,f.binding,f.pin)).toThrow();
 const malformed=structuredClone(f.before);malformed.functions[0].details.pronamespace='not-an-oid';expect(()=>accessOwnerDependencyExpectation(malformed,f.transfer,f.binding,f.pin)).toThrow();
 const extension=structuredClone(f.before);extension.extensionOwners.push({classid:300,objid:3});expect(()=>accessOwnerDependencyExpectation(extension,f.transfer,f.binding,f.pin)).toThrow();
 expect(()=>accessOwnerDependencyExpectation({...f.before,functions:[...f.before.functions,f.before.functions[0]]},f.transfer,f.binding,f.pin)).toThrow();
});
it('requires the real pin-control source/owner/exact edge and completed rollback with no surviving object/dependencies',()=>{
 const f=sample();for(const pin of [{...f.pin,database:38},{...f.pin,ownerBefore:11},{...f.pin,ownerAfter:998},{...f.pin,relationCatalog:401},{...f.pin,roleCatalog:101},{...f.pin,typeCatalog:501},{...f.pin,arrayTypeOid:f.pin.typeOid},
  {...f.pin,before:f.pin.after},{...f.pin,after:[]},{...f.pin,after:[...f.pin.after,...f.pin.after]},{...f.pin,rollbackComplete:false},{...f.pin,objectAbsent:false},{...f.pin,typesAbsent:false},{...f.pin,localDependenciesAbsent:false},{...f.pin,dependenciesAbsent:false}])expect(()=>accessOwnerDependencyExpectation(f.before,f.transfer,f.binding,pin)).toThrow();
 const contaminated={...f.before,relations:[...f.before.relations,{oid:f.pin.tableOid,owner:10,relnamespace:1,relname:'leaked_control',details:{relkind:'r'}}]};
 expect(()=>accessOwnerDependencyExpectation(contaminated,{...f.transfer,relations:[...f.transfer.relations,{oid:f.pin.tableOid}]},f.binding,f.pin)).toThrow('leaked');
});
it('rejects lost/changed/extra baseline ACL and foreign edges, unknown row fields and unexpected pinned-owner predecessors',()=>{
 const f=sample(),expected=accessOwnerDependencyExpectation(f.before,f.transfer,f.binding,f.pin),rows=expected.expectedSharedDependencies,acl=rows.findIndex(row=>row.deptype==='a');
 const missing=[...rows];missing.splice(acl,1);expect(()=>assertAccessOwnerDependencies(expected,missing,expected.expectedRawSharedDependencies)).toThrow();
 const foreign=[...rows];foreign[acl]={...foreign[acl],refobjid:123};expect(()=>assertAccessOwnerDependencies(expected,foreign,expected.expectedRawSharedDependencies)).toThrow();
 expect(()=>assertAccessOwnerDependencies(expected,[...rows,{...rows[acl],unexpectedNativeField:'never silently discarded'}],expected.expectedRawSharedDependencies)).toThrow();
 expect(()=>accessOwnerDependencyExpectation({...f.before,sharedDependencies:[...f.before.sharedDependencies,{...rows.find(row=>row.refobjid===10)!}]},f.transfer,f.binding,f.pin)).toThrow('unexpectedly referenced');
});

it('accepts only bounded exact native metadata OIDs while preserving raw predecessor metadata and owner equality',()=>{
 for(const value of [1,73012,4294967295,'1','73012','4294967295'])expect(accessNativeMetadataOid(value)).toBe(Number(value));
 for(const value of [0,-1,1.5,4294967296,NaN,Infinity,'','0','-1','1.0','1e3','01',' 73012','73012 ','+73012','4294967296',null,undefined,true,{oid:'73012'}])expect(()=>accessNativeMetadataOid(value)).toThrow();
 const raw={proowner:'73012',prosrc:'exact native body',unknownNativeField:{oid:'must remain opaque'}};
 expect(accessNativeMetadataOid(raw.proowner)).toBe(73012);expect(accessNativeMetadataOid(raw.proowner)).not.toBe(73013);
 expect(raw).toEqual({proowner:'73012',prosrc:'exact native body',unknownNativeField:{oid:'must remain opaque'}});
});
