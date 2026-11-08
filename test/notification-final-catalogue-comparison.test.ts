import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {compareCanonicalFunctionRows,compareCanonicalReplayMembers} from './fixtures/notification-worker/final-catalogue-comparison';
const row={oid:'app.fixed(boolean)',prosrc:'select true',proargdefaults:'({CONST :consttype 16 :location 42 :constvalue 1 [ 1 ]})',prosqlbody:null,probin:null,nativeArguments:'input boolean DEFAULT true',nativeDefaults:'true',proowner:'postgres',proconfig:['search_path=pg_catalog'],proacl:{explicit:true,entries:[{grantor:'postgres',grantee:'postgres',privilege:'EXECUTE',grantable:false}]}};
const native=(id:string,body=row)=>({signature:body.oid,raw:{oid:id,proargdefaults:body.proargdefaults}});
it('compares complete typed metadata and all opaque defaults while requiring actual changed canonical object IDs',()=>{
 expect(compareCanonicalFunctionRows([row],[{...row}],[native('17000')],[native('18000')])).toEqual({functionCount:1,defaultFunctions:1,shiftedFunctions:1});
 expect(()=>compareCanonicalFunctionRows([row],[row],[native('17000')],[native('17000')])).toThrow('inconclusive');
});
it('rejects exact default/location/OID bytes, source, ABI/ACL/config and missing or duplicated membership without normalizing them away',()=>{
 for(const change of [{proargdefaults:row.proargdefaults.replace('42','43')},{proargdefaults:row.proargdefaults.replace('16','999')},{proargdefaults:null},{prosrc:'select false'},{proowner:'other'},{proconfig:[]},{proacl:{}},{nativeDefaults:'false'},{nativeArguments:'other'},{prosqlbody:'opaque'},{probin:'external'},{extraNativeColumn:1}]){
  expect(()=>compareCanonicalFunctionRows([row],[{...row,...change}],[native('17000')],[native('18000')])).toThrow();
 }
 expect(()=>compareCanonicalFunctionRows([row,row],[row],[native('17000')],[native('18000')])).toThrow();
 expect(()=>compareCanonicalFunctionRows([row],[{...row,oid:'app.other(boolean)'}],[native('17000')],[native('18000')])).toThrow();
 const{proargdefaults:_defaults,...omitted}=row;expect(()=>compareCanonicalFunctionRows([omitted],[omitted],[native('17000')],[native('18000')])).toThrow('vanish');
});
it('checks raw retained defaults independently of the normalized view',()=>{
 expect(()=>compareCanonicalFunctionRows([row],[row],[native('17000')],[{...native('18000'),raw:{oid:'18000',proargdefaults:'changed raw AST'}}])).toThrow('raw default bytes');
 expect(()=>compareCanonicalFunctionRows([row],[row],[],[native('18000')])).toThrow();
});

import {normalizeNotificationCanonicalInventory,nativeInventoryCanonical} from './fixtures/notification-worker/canonical-inventory';
import {validateFullCiRoleReceipt} from '../.github/ci/run-unit.mjs';
import {catalogueReplayRoleHash} from '../.github/ci/notification-catalogue-replay.mjs';
import {DB_BATCH_FILES} from '../.github/ci/manifest.mjs';
import {FULL_CI_ROLE_MODE,FULL_CI_ROLE_SOURCE,fullCiRoleReceiptBasename} from '../scripts/lib/discard-premigration';
import {replayOwnerPaths} from './fixtures/notification-worker/canonical-inventory-evidence';
const hash=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
function inventorySample(offset=0){
 const type={oid:16+offset,schema:'pg_catalog',namespaceOid:11+offset,name:'bool',identity:'pg_catalog.bool',formatted:'boolean',raw:{oid:String(16+offset),typnamespace:String(11+offset),typname:'bool'}};
 const raw={oid:String(101+offset),proname:'example',pronamespace:String(201+offset),proowner:String(301+offset),prolang:String(401+offset),prorettype:String(16+offset),proargtypes:[String(16+offset)],proallargtypes:null,protrftypes:null,provariadic:'0',prosupport:'-',proacl:null,
  procost:100,prorows:0,prokind:'f',prosecdef:true,proleakproof:false,proisstrict:false,proretset:false,provolatile:'v',proparallel:'u',pronargs:1,pronargdefaults:0,proargmodes:null,proargnames:['input'],prosrc:'BEGIN -- 9001 is source, not an OID replacement\n RETURN TRUE; END',probin:null,prosqlbody:null,proconfig:['search_path=pg_catalog'],proargdefaults:null};
 const row={raw,signature:'app.example(boolean)',namespaceOid:201+offset,ownerOid:301+offset,languageOid:401+offset,returnTypeOid:type.oid,inputTypeOids:[type.oid],allTypeOids:null,transformTypeOids:null,variadicTypeOid:0,supportOid:0,supportText:'-',
  acl:[{grantorOid:301+offset,granteeOid:0,privilege:'EXECUTE',grantable:false}],nativeArguments:'input boolean',nativeIdentityArguments:'input boolean',nativeResult:'boolean',nativeDefaults:null,nativeDefinition:'CREATE FUNCTION app.example(input boolean) RETURNS boolean ...',sourceBytes:Buffer.byteLength(raw.prosrc),sourceSha256:hash(raw.prosrc)};
 return{formatVersion:2,columns:Object.keys(raw),functionCount:1,referenceCounts:{types:1,namespaces:2,languages:1,roles:2,supports:0},
  dictionaries:{types:{[type.oid]:type},namespaces:{[201+offset]:{oid:201+offset,name:'app',raw:{oid:String(201+offset),nspname:'app'}},[11+offset]:{oid:11+offset,name:'pg_catalog',raw:{oid:String(11+offset),nspname:'pg_catalog'}}},languages:{[401+offset]:{oid:401+offset,name:'plpgsql',raw:{oid:String(401+offset),lanname:'plpgsql'}}},roles:{[301+offset]:{oid:301+offset,name:'app_owner'},0:{oid:0,name:'PUBLIC'}},supports:{}},
  functions:[row],dependencies:[{raw:{classid:'1255',objid:String(101+offset),refclassid:'2615',refobjid:String(201+offset)},object:{identity:'app.example(boolean)'},reference:{identity:'app'}}],sharedDependencies:[{raw:{classid:'1255',objid:String(101+offset),refclassid:'1260',refobjid:String(301+offset)},referenceRole:{oid:301+offset,name:'app_owner'}}]};
}
/** Synthetic in-memory comparison inputs only; not written as hosted receipts. */
function replayMembers(mode:'baseline'|'oid-shift'){
 const encode=(value:unknown)=>Buffer.from(nativeInventoryCanonical(value)+'\n');
 const record=(path:string,text:string)=>{const bytes=Buffer.from(text);return{path,text,bytes:bytes.length,mode:'100644',sha256:hash(bytes),blob:createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex')};};
 const frame={variation:mode,source:'a'.repeat(40),controller:'b'.repeat(40),run:'123',attempt:'1',unit:'db-'+(mode==='baseline'?'1':'2').repeat(16),planFingerprint:'c'.repeat(64)};
 const entry={idx:0,version:'7',when:1,tag:'0000_fixed_fixture',breakpoints:true};
 const prerequisites=Object.fromEntries(Object.entries(FULL_CI_ROLE_SOURCE).map(([name,path])=>[name,record(path,'fixed prerequisite '+name)]));
 const replayOwners=Object.fromEntries(Object.entries(replayOwnerPaths).map(([name,path])=>[name,record(path,'fixed replay '+name)]));
 const source={...frame,journal:record('db/migrations/meta/_journal.json',JSON.stringify({version:'7',dialect:'postgresql',entries:[entry]})),migrations:[{...entry,position:0,...record('db/migrations/0000_fixed_fixture.sql','select true;')}],unlistedSql:[],unlistedSqlDisposition:'SOURCE_ONLY_NOT_IN_JOURNAL_NOT_CLAIMED_APPLIED',prerequisites,replayOwners};
 const roles={roles:['ai_hr_app','ai_hr_draft_discard_port','ai_hr_owner'].map((name,index)=>({oid:index+1,name,login:name!=='ai_hr_draft_discard_port',inherit:true,super:false,createDb:false,createRole:false,replication:false,bypassRls:false,connectionLimit:-1,validUntil:null})),edges:[{role:'ai_hr_app',member:'ai_hr_draft_discard_port',grantor:'postgres',inherit:true,set:false,admin:false},{role:'ai_hr_draft_discard_port',member:'ai_hr_owner',grantor:'postgres',inherit:false,set:true,admin:false}]};
 const session={postmasterStart:'2026-11-08T00:00:00.123456Z',version:160015,versionText:'PostgreSQL 16.15 fixed comparison model',isolation:'repeatable read',readOnly:'on'};
 const binding={mode:FULL_CI_ROLE_MODE,candidate:frame.source,controller:frame.controller,runId:frame.run,attempt:frame.attempt,unit:frame.unit,offset:0,planFingerprint:frame.planFingerprint,batchSize:DB_BATCH_FILES,batchFiles:[mode==='baseline'?'test/notification-final-catalogue-baseline.test.ts':'test/notification-final-catalogue-oid-shift.test.ts']};
 const sources={helperSha256:prerequisites.helper.sha256,wrapperSha256:prerequisites.wrapper.sha256,orchestrationSha256:prerequisites.orchestration.sha256},replaySources={ownerSha256:replayOwners.owner.sha256,contractSha256:replayOwners.contract.sha256};
 const facts={objects:[{oid:20000}],dependencies:[{objid:20000}],shared:[]};
 const receipt={...binding,schemaVersion:1,kind:'PERSONNEL_DRAFT_DISCARD_FULL_CI_ROLE_PREREQUISITES',phase:'before_initial_candidate_migration',scope:'disposable CI setup only; no native, installation or release attestation',...sources,
  fixture:{mode:FULL_CI_ROLE_MODE,...roles,postgres:{versionNumber:session.version,versionText:session.versionText,session:'postgres',current:'postgres'}},
  catalogueReplay:{version:1,kind:'NATIVE_CATALOGUE_REPLAY_PREREQUISITE_NOT_PROFILE',mode,candidate:frame.source,controller:frame.controller,runId:frame.run,attempt:frame.attempt,unit:frame.unit,planFingerprint:frame.planFingerprint,sourceHashes:replaySources,
   session:{database:'postgres',pid:123,backendStart:'2026-11-08 00:00:00.123456+00',postmasterStart:session.postmasterStart,versionNumber:session.version,versionText:session.versionText,session:'postgres',current:'postgres',loopback:true},roleCatalogSha256:catalogueReplayRoleHash(roles),allocation:mode==='baseline'?null:{namespaceOid:20000,enumOid:20001,enumArrayOid:20002,heapOid:20003,rowTypeOid:20004,rowArrayOid:20005,nativeRowsSha256:catalogueReplayRoleHash(facts.objects),dependenciesSha256:catalogueReplayRoleHash({dependencies:facts.dependencies,shared:facts.shared}),facts},objectsAbsent:true,quiescence:{sameCluster:true,ownedPresent:false,observerPid:124,observerStart:'2026-11-08 00:00:01.123456+00',observedAt:'2026-11-08 00:00:02.123456+00',postmasterStart:'2026-11-08T00:00:00.123456Z'},releaseAuthorized:false}};
 const prerequisite=Buffer.from(JSON.stringify(receipt,null,2)+'\n'),inventory=inventorySample(mode==='baseline'?0:1000);
 const raw={...frame,session,roles,ledger:[{id:1,hash:source.migrations[0].sha256,created_at:'1'}],inventory};
 const normalized={...frame,...normalizeNotificationCanonicalInventory(inventory)};
 const members={source:encode(source),raw:encode(raw),normalized:encode(normalized)};
 const report={...frame,kind:'NATIVE_CANONICAL_INVENTORY_DIAGNOSTIC_NOT_RELEASE',complete:true,socketClosed:true,expectedProfileAuthorized:false,releaseAuthorized:false,session,roles,ledger:raw.ledger,
  prerequisites:{file:fullCiRoleReceiptBasename(frame.unit,0),sha256:hash(prerequisite),raw:receipt,proof:validateFullCiRoleReceipt(receipt,binding,sources,replaySources)},
  members:Object.entries(members).map(([name,bytes])=>({file:'notification-canonical-'+name+'.json',bytes:bytes.length,sha256:hash(bytes)}))};
 return{...members,report:encode(report),prerequisite};
}
it('checks complete canonical raw members, original prerequisite wire bytes and all ordered source blobs before comparing rows',()=>{
 const result=compareCanonicalReplayMembers(replayMembers('baseline'),replayMembers('oid-shift'),{candidate:'a'.repeat(40),controller:'b'.repeat(40)});
 expect(result).toMatchObject({functionCount:1,shiftedFunctions:1,exactRawDefaultsEqual:true,expectedProfileAuthorized:false,releaseAuthorized:false});
});
it('refuses corrupt/truncated/duplicate-key members, source and receipt drift even when a normalized row view could agree',()=>{
 const a=replayMembers('baseline'),b=replayMembers('oid-shift'),expected={candidate:'a'.repeat(40),controller:'b'.repeat(40)};
 for(const field of ['source','raw','normalized','report','prerequisite']as const){
  expect(()=>compareCanonicalReplayMembers(a,{...b,[field]:b[field].subarray(0,b[field].length-1)},expected)).toThrow();
 }
 const report:Record<string,unknown>=JSON.parse(b.report.toString()),decode=(bytes:Buffer):Record<string,unknown>=>JSON.parse(bytes.toString());
 const raw=decode(b.raw);raw.session={...decode(Buffer.from(JSON.stringify(raw.session))),postmasterStart:'2026-11-09T00:00:00.000000Z'};
 expect(()=>compareCanonicalReplayMembers(a,{...b,raw:Buffer.from(nativeInventoryCanonical(raw)+'\n')},expected)).toThrow();
 report.complete=false;expect(()=>compareCanonicalReplayMembers(a,{...b,report:Buffer.from(nativeInventoryCanonical(report)+'\n')},expected)).toThrow();
 expect(()=>compareCanonicalReplayMembers(a,b,{...expected,candidate:'f'.repeat(40)})).toThrow();
 const duplicate=Buffer.from(b.raw.toString().replace('{','{"variation":"forged",'));expect(()=>compareCanonicalReplayMembers(a,{...b,raw:duplicate},expected)).toThrow();
});
